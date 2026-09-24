// src/services/pluginBoundary.ts
//
// 插件与宿主之间的**边界清单**：每一个跨越那条边界的东西，都在这里登记一次，
// 并写明它跨过去之后是什么形态。
//
// ============================================================
// 这份清单要解决的是一件具体的事
// ============================================================
//
// 插件与宿主现在共享同一个 WebView、同一个 JS 上下文（见
// docs/02-开发指南/插件开发/插件系统架构.md 第 6.3 节）。这意味着今天**没有**真正的
// 隔离：插件能读 `window`、能直接 `fetch`、能直接 `invoke`。宿主无法知道"谁在调用"，
// 因此权限检查只能做到"经由宿主通道时有效"。
//
// 真正的访问控制要靠把插件挪到独立的 realm（进程 / Web Worker）。而一旦跨 realm，
// **入口就只剩消息传递** —— 消息只能携带结构化克隆能表达的东西：不能带函数、
// 不能带类实例、不能带原型链、不能带 DOM 节点。
//
// 所以这份清单只回答一个问题，对每一个跨边界的东西：
//
//     **它跨得过去吗；跨不过去的话，v2 靠什么替代。**
//
// 它不是文档，是**判据**：`scripts/check-plugin-boundary.ts` 用它断言实际接线，
// 新增成员或新增方法而不登记会让检查失败。
//
// ============================================================
// 为什么不把结论写成"能不能隔离"
// ============================================================
//
// 因为那会退化成一句无法兑现的话 —— `sandboxLevel`（L0-L3）就是这么被删掉的：
// 它描述了宿主做不到的事，却曾被渲染进插件详情页。见 `permissions.rs` 与
// docs/02-开发指南/插件开发/清单文件参考.md 第 6 节。
//
// 这里只写**可判定的事实**：这个东西是值、是对象，还是函数。等级、承诺、阶段，
// 一概不写。
//
// ============================================================
// 两层：成员，与方法
// ============================================================
//
// 第一层是**成员**（`Modulith.*` 与 `ctx.*` 上的每一项）。它回答"这个入口跨不跨得过去"。
//
// 第二层是**方法**（`ctx.storage.get` 这类）。它回答"这个能力换成消息往返之后，
// 参数与返回值能不能过去"。第二层是 v2 真正的工作量所在 —— 一个标为 `handle`
// 的能力对象，只有当它每个方法的入参与返回值都是值时，才真的能换成代理。

// ============================================================
// 分类
// ============================================================

/**
 * 一个跨边界成员（或方法）跨越那条边界的方式。
 *
 * 取值覆盖了全部情况，且**可判定**：判据是"它是不是函数"以及"它的内容是不是纯数据"，
 * 两者都不依赖对人的信任。
 */
export type BoundaryKind =
  /** 纯数据：跨 realm 由结构化克隆原样送过去，不需要任何改造 */
  | 'value'
  /** 能力对象：**对象外壳过不去，但它代表的是一组消息往返** —— 内容可以在另一个 realm 里重建 */
  | 'handle'
  /** 可调用：函数。结构化克隆跨不过去，只能改成"按 ID 调用 + 消息传递" */
  | 'callable'
  /**
   * 宿主造出来的对象：既不是纯数据，也不是插件的函数。
   *
   * `ctx.http.fetch()` 返回的**原生 `Response`** 是这一类。它的内部状态
   * （status / headers / body 文本）本来就是后端经 IPC 送来的纯数据，但
   * `new Response(...)` 之后变成了一个带方法的宿主对象：`.json()` / `.text()` 是函数，
   * `body` 是 `ReadableStream`，整个对象不可结构化克隆。
   *
   * 与 `callable` 的区别很重要：函数**无解**，而这一类**有明确出路** ——
   * 把数据直接交给插件，不要包成宿主对象。代价是插件侧的用法变了
   * （`res.json()` 变成对数据的操作），那是 v2 的一次产品取舍，不是技术障碍。
   */
  | 'host-object';

/**
 * 该成员（或方法）在 v2（插件挪到独立 realm）时的去处。
 *
 * 这个字段是必填的，因为"将来再说"不是一种设计。它的价值不在措辞，而在于
 * **写不出来就说明这个 API 从一开始就设计错了**。
 */
export type BoundaryMigration =
  /** 原样：值跨 realm 直接可用 */
  | 'as-is'
  /** 换代理：能力对象的每个方法映射成一次消息往返。**这是 handle 的默认去处** */
  | 'rpc'
  /** 入参或返回值含函数，要重新设计（"交出可寻址的行为"或"宿主渲染描述"） */
  | 'message'
  /** 入参或返回值是宿主对象，要改成"只传数据" */
  | 'pass-data'
  /** v1.5 目标 2 把它从"随时可同步调用"改成"激活时给的一份快照" */
  | 'bootstrap-snapshot';

export interface BoundaryMember {
  /** 边界上的成员名。必须与实际接线逐字一致 —— 由门禁断言 */
  readonly name: string;
  readonly kind: BoundaryKind;
  readonly migration: BoundaryMigration;
  /** 它是什么。一句话，说清"跨过去之后插件拿到的是什么" */
  readonly note: string;
}

/**
 * 一个能力方法。
 *
 * 它只登记**形态**，不登记完整签名 —— 完整签名在 `src/types/plugin.ts` 里，抄一份
 * 到这里必然漂移。这里要的是那个无法从签名自动看出来的判断：
 * **参数与返回值是值，还是函数/宿主对象。**
 */
export interface BoundaryMethod {
  readonly name: string;
  /** 返回值与回调参数的形态。**泛型参数（如 `get<T>` 的 T）无法判定，一律按 value 记** */
  readonly io: BoundaryKind;
  readonly migration: BoundaryMigration;
  /** 为什么是这个形态。一句话，够下一个人判断"我这次改动有没有改变结论" */
  readonly note: string;
}

/** 全局对象（`Modulith`）与上下文（`ctx`）两个表面 */
export type BoundarySurface = 'host' | 'context';

/**
 * 这个成员**是不是值形态**（换成代理 / 快照之后就能过去）。
 *
 * `value` 与 `handle` 都是。`callable` 与 `host-object` 都不是：前者是函数，
 * 结构化克隆明确拒绝；后者是带方法的宿主对象，得先把数据剥出来。
 *
 * 名字是刻意选的：早先它叫 `crossesRealmAsData`，读起来像"今天已经能跨了"，
 * 于是 `React`（一个活的 class 实例）被这个判断放行了 —— 而它恰恰是最大的一块。
 * 名字说的是**形态**，不是**现状**。
 */
export function isValueShaped(kind: BoundaryKind): boolean {
  return kind === 'value' || kind === 'handle';
}

// ============================================================
// 宿主表面（`Modulith.*`）
// ============================================================
//
// 这一份此前只是 `scripts/check-contributions.ts` 里的一个局部数组
// （`REFERENCE_PASSING` / `VALUE_PASSING`），在插件源码里读不到。搬到这里之后，
// 它同时服务三件事：门禁断言、文档、以及给 v2 的迁移清单。
//
// 迁移里最大的一块是 React。`React` / `jsx` / `jsxs` / `Fragment` 给的是**宿主那个
// React 实例**，插件因此能正常用 hooks 与 context —— 代价是插件与宿主的 React
// 版本强耦合，而且这四个引用一个都过不去 realm 边界。v2 必须做一次取舍：
// 要么插件自带 UI 运行时（9 个已发布插件全部重写），要么插件交出可序列化的界面
// 描述、宿主负责渲染。这个取舍记在
// docs/08-规划/插件架构与API-v1.5范围.md 的"分叉 A"，v1.5 刻意不碰它。
//
// 顺序刻意保持与 1.4.0 的 `HOST_CAPABILITIES.host` **逐字一致**。它是对外契约的一部分
// （`Modulith.capabilities.host` 会把它原样交给插件），重排它没有收益，却有风险：
// 任何按位置而不是按名字读它的代码会静默错位。新增成员一律追加在末尾。
const HOST_MEMBERS: readonly BoundaryMember[] = [
  { name: 'version', kind: 'value', migration: 'as-is', note: '宿主版本字符串' },
  { name: 'platform', kind: 'value', migration: 'as-is', note: '平台标识字符串' },
  {
    name: 'React',
    kind: 'host-object',
    migration: 'pass-data',
    note: '宿主自己的 React 实例。活的类实例、带闭包，跨不过 realm；v2 要在"插件自带 UI 运行时"与"宿主渲染界面描述"之间选一条',
  },
  {
    name: 'jsx',
    kind: 'callable',
    migration: 'message',
    note: 'JSX 工厂。与 React 同一个问题，随它一起走',
  },
  {
    name: 'jsxs',
    kind: 'callable',
    migration: 'message',
    note: 'JSX 工厂（多子节点形式）。同上',
  },
  {
    name: 'Fragment',
    kind: 'host-object',
    migration: 'pass-data',
    note: 'React 的 Fragment 符号，来自宿主实例。同上',
  },
  {
    name: 'registerModule',
    kind: 'callable',
    migration: 'message',
    note: '交出渲染组件。入参含 component 函数，是声明式贡献里唯一还传引用的地方',
  },
  {
    name: 'createContext',
    kind: 'callable',
    migration: 'bootstrap-snapshot',
    note: '创建 ctx。**只能在 bundle 顶层调用**，因为归属靠"当前正在加载的插件"这个隐式全局',
  },
  {
    name: 'registerCommand',
    kind: 'callable',
    migration: 'message',
    note: '交出命令行为函数',
  },
  {
    name: 'onDeactivate',
    kind: 'callable',
    migration: 'message',
    note: '登记清理函数。v2 要把清理改成"宿主记录插件持有什么"，而不是"插件交出一个函数"',
  },
  {
    name: 'useModuleActive',
    kind: 'callable',
    migration: 'message',
    note: 'React hook，同步返回布尔。跨 realm 后要改成订阅式。**9 个已发布插件里 8 个在用它**，因此这是界面层最广的一处耦合',
  },
  {
    name: 'capabilities',
    kind: 'value',
    migration: 'as-is',
    note: '能力表（纯数据：版本号与四组名字）',
  },
  {
    name: 'run',
    kind: 'callable',
    migration: 'message',
    note: '**显式引导入口**：宿主把身份与数据作为参数交进去，回调里做贡献。它的 migration 是 `message` 而非 `as-is` —— 入参是一个函数，而"怎么把一个函数交给宿主"本身就是消息传递要解决的事（与 `events.subscribe` 同一类）。它的价值在于**去掉了隐式全局**：v1 靠"当前正在加载哪个插件"决定归属，那个全局跨不过 realm，而这里身份是显式参数。回调的返回值在 v1.5 被忽略；"返回值即贡献"要求交出组件，那属于界面层（分叉 A）',
  },
];

// ============================================================
// 上下文表面（`ctx.*`）
// ============================================================
//
// 这一份是补登记的：在此之前，`ctx` 的 17 个成员**只有名字被核对过**，没有任何一处
// 回答过"它跨不跨得过去"。而 `ctx` 恰恰是边界的主体 —— 权限的实际载体
// （`http` / `launcher` / `icons` / `shell` / `audio`）全在这里。
//
// 值得单独指出的是那 12 个 `handle`：它们**不是资源句柄，而是能力对象**。
// `ctx.storage` 不是一个"存储连接"，它是一个由若干函数组成的对象。因此把它们标成
// `handle` 说的是"它代表的是一组消息往返" —— **不是**"它今天已经能跨过去了"。
// 今天它一个都跨不过去，因为它是个对象。v2 要把它换成 JSON-RPC 式的代理：
// 对象外壳换成代理，方法逐个映射成消息往返。这件事可行的前提正是每个方法的入参与
// 返回值都是值 —— 那由下面的 `CAPABILITY_METHODS` 逐条登记、由门禁逐条核对。
const CONTEXT_MEMBERS: readonly BoundaryMember[] = [
  { name: 'pluginId', kind: 'value', migration: 'as-is', note: '插件 ID 字符串' },
  { name: 'pluginVersion', kind: 'value', migration: 'as-is', note: '插件版本字符串' },
  { name: 'version', kind: 'value', migration: 'as-is', note: '宿主版本字符串' },
  {
    name: 'activationEvent',
    kind: 'value',
    migration: 'as-is',
    note: '本次激活事件；旧式插件为 null',
  },
  {
    name: 'manifest',
    kind: 'value',
    migration: 'as-is',
    note: '本插件的清单对象。由后端经 IPC 送来，是纯 JSON —— 因此可克隆',
  },
  {
    name: 'storage',
    kind: 'handle',
    migration: 'rpc',
    note: '键值存储。需要 storage 权限，Rust 侧强制',
  },
  {
    name: 'http',
    kind: 'handle',
    migration: 'rpc',
    note: '联网的唯一受管通道。需要 network / network-external。**它返回原生 Response，是唯一一处 host-object**',
  },
  {
    name: 'logger',
    kind: 'handle',
    migration: 'rpc',
    note: '日志。除控制台外还写进宿主的日志文件。debug/info/warn/error 是 void 返回，可直接丢弃',
  },
  {
    name: 'notifications',
    kind: 'handle',
    migration: 'rpc',
    note: '应用内通知。前端强制，未声明时降级为空实现',
  },
  {
    name: 'events',
    kind: 'handle',
    migration: 'rpc',
    note: '插件间事件总线。前端强制。**subscribe 的回调入参是函数**，因此它比其它能力多一步：v2 要改成"宿主推事件、插件按 ID 认领"',
  },
  {
    name: 'launcher',
    kind: 'handle',
    migration: 'rpc',
    note: '启动外部程序。需要 process-spawn，Rust 侧强制。**这是插件能拿到的最强能力**',
  },
  {
    name: 'icons',
    kind: 'handle',
    migration: 'rpc',
    note: '提取本机文件图标。需要 filesystem-read，返回 data URL 字符串',
  },
  {
    name: 'shell',
    kind: 'handle',
    migration: 'rpc',
    note: '在文件管理器中定位文件。需要 filesystem-read',
  },
  {
    name: 'fileDrop',
    kind: 'handle',
    migration: 'rpc',
    note: '窗口级文件拖放。需要 filesystem-read。**subscribe 的回调入参是函数**',
  },
  {
    name: 'audio',
    kind: 'handle',
    migration: 'rpc',
    note: '导入音频，返回 data URL。需要 filesystem-read',
  },
  {
    name: 'clipboard',
    kind: 'handle',
    migration: 'rpc',
    note: '读写系统剪贴板。需要 clipboard，**前端强制** —— 剪贴板是浏览器 API，插件本来就能直接调 navigator.clipboard，因此后端加门不会让强制变强',
  },
  {
    name: 'settings',
    kind: 'handle',
    migration: 'bootstrap-snapshot',
    note: '读插件自己声明的设置项。**get / getAll 是同步的**，这正是 v1.5 目标 2 要改成快照参数的那一处',
  },
  {
    name: 'disposables',
    kind: 'handle',
    migration: 'message',
    note: '收尾登记。add 的入参是函数，与 onDeactivate 同一个问题',
  },
];

// ============================================================
// 能力方法
// ============================================================
//
// 这一层是 v2 的真实工作量。12 个能力对象标为 `handle` 只是说"它代表消息往返"；
// 能不能真的换成往返，取决于**每个方法**的参数与返回值。
//
// `io` 记的是返回值与回调参数的形态（参数里的普通值不单独记 —— 字符串、数字、
// 布尔、数组与普通对象都是值，不需要有人提醒）。因此 `io: 'callable'` 与
// `io: 'host-object'` 才是需要看的两种。
//
// 判据的来源是实际运行时实现（`src/services/pluginRuntime.ts` 的 `pluginXxx` 函数），
// 不是 `src/types/plugin.ts` 的声明 —— 两者曾有对不上的地方，而运行时才是插件真正
// 拿到的东西。门禁会核对这里写的方法名确实出现在那个实现里。
const CAPABILITY_METHODS: Readonly<Record<string, readonly BoundaryMethod[]>> = {
  storage: [
    { name: 'get', io: 'value', migration: 'as-is', note: '返回解析后的 JSON 值；泛型 T 由插件自定' },
    { name: 'set', io: 'value', migration: 'as-is', note: '入参会被 JSON.stringify，因此必须可序列化（这本来就是约束）' },
    { name: 'delete', io: 'value', migration: 'as-is', note: '返回 void' },
    { name: 'clear', io: 'value', migration: 'as-is', note: '返回 void' },
    { name: 'keys', io: 'value', migration: 'as-is', note: '返回 string[]' },
    { name: 'list', io: 'value', migration: 'as-is', note: '返回 PluginStoragePage（keys / nextCursor / usage），是纯数据' },
    { name: 'usage', io: 'value', migration: 'as-is', note: '返回 PluginStorageUsage（totalBytes / keyCount）' },
    { name: 'all', io: 'value', migration: 'as-is', note: '返回 Record<string, unknown>，值由插件自己写进去' },
  ],
  http: [
    { name: 'fetch', io: 'host-object', migration: 'pass-data', note: '**返回原生 Response**：带方法、body 是 ReadableStream，不可克隆' },
    { name: 'get', io: 'host-object', migration: 'pass-data', note: '同上' },
    { name: 'post', io: 'host-object', migration: 'pass-data', note: '同上。data 会被 JSON.stringify，因此入参是值' },
    { name: 'put', io: 'host-object', migration: 'pass-data', note: '同上' },
    { name: 'delete', io: 'host-object', migration: 'pass-data', note: '同上' },
  ],
  logger: [
    { name: 'debug', io: 'value', migration: 'as-is', note: '返回 void，参数是字符串与任意值' },
    { name: 'info', io: 'value', migration: 'as-is', note: '同上' },
    { name: 'warn', io: 'value', migration: 'as-is', note: '同上' },
    { name: 'error', io: 'value', migration: 'as-is', note: '同上' },
    { name: 'trace', io: 'callable', migration: 'message', note: '**返回一个计时结束函数**。v2 要么改成两个方法（start/end 带 token），要么改成宿主侧按 label 计时' },
  ],
  notifications: [
    { name: 'isAvailable', io: 'value', migration: 'as-is', note: '同步返回布尔。v2 改成读 capabilities' },
    { name: 'show', io: 'value', migration: 'as-is', note: '返回 Promise<void>' },
    { name: 'info', io: 'value', migration: 'as-is', note: '同上' },
    { name: 'success', io: 'value', migration: 'as-is', note: '同上。运行时确实提供了它' },
    { name: 'warn', io: 'value', migration: 'as-is', note: '同上' },
    { name: 'error', io: 'value', migration: 'as-is', note: '同上' },
  ],
  events: [
    { name: 'isAvailable', io: 'value', migration: 'as-is', note: '同步返回布尔' },
    { name: 'publish', io: 'value', migration: 'as-is', note: '返回 void，payload 是任意值' },
    { name: 'subscribe', io: 'callable', migration: 'message', note: '**入参是事件处理函数、返回值是取消订阅函数**。v2 改成"宿主推事件、插件按 ID 认领"' },
  ],
  launcher: [
    { name: 'launch', io: 'value', migration: 'as-is', note: '返回 Promise<void>，参数是字符串与字符串数组' },
  ],
  icons: [
    { name: 'extract', io: 'value', migration: 'as-is', note: '返回 data URL 字符串' },
  ],
  shell: [
    { name: 'revealInFolder', io: 'value', migration: 'as-is', note: '返回 Promise<void>' },
  ],
  fileDrop: [
    { name: 'isAvailable', io: 'value', migration: 'as-is', note: '同步返回布尔' },
    { name: 'subscribe', io: 'callable', migration: 'message', note: '**入参是拖放处理函数、返回值是取消订阅函数**。同上' },
  ],
  audio: [
    { name: 'pick', io: 'value', migration: 'as-is', note: '返回 PickedAudio（name / dataUrl / bytes）或 null，是纯数据' },
  ],
  clipboard: [
    { name: 'isAvailable', io: 'value', migration: 'as-is', note: '同步返回布尔：权限已声明**且**环境提供 navigator.clipboard' },
    { name: 'readText', io: 'value', migration: 'as-is', note: '返回 Promise<string>。**可能被浏览器拒绝**（页面未聚焦 / 剪贴板被独占），调用方应有回退' },
    { name: 'writeText', io: 'value', migration: 'as-is', note: '返回 Promise<void>。回退路径用 document.execCommand，需要用户手势' },
  ],
  settings: [
    { name: 'isAvailable', io: 'value', migration: 'as-is', note: '同步返回布尔' },
    { name: 'get', io: 'value', migration: 'bootstrap-snapshot', note: '**同步**返回单项值。v1.5 目标 2：改成激活时给的一份快照' },
    { name: 'getAll', io: 'value', migration: 'bootstrap-snapshot', note: '**同步**返回全部设置。同上' },
    { name: 'set', io: 'value', migration: 'rpc', note: '返回 Promise<void>' },
    { name: 'onChange', io: 'callable', migration: 'message', note: '**入参是变更监听函数、返回值是取消订阅函数**。v2 改成"宿主推设置变更、插件按 ID 认领"' },
  ],
  disposables: [
    { name: 'add', io: 'callable', migration: 'message', note: '**入参是清理函数、返回值是提前执行函数**。v2 要把清理改成"宿主记录插件持有什么"，而不是"插件交出一个函数"' },
    { name: 'size', io: 'value', migration: 'as-is', note: '同步返回数字' },
  ],
};

// ============================================================
// 对外
// ============================================================

const SURFACES: Record<BoundarySurface, readonly BoundaryMember[]> = {
  host: HOST_MEMBERS,
  context: CONTEXT_MEMBERS,
};

/**
 * 全部跨边界成员，按表面分组。
 *
 * 返回的是同一批冻结对象，不做拷贝 —— 它是常量清单，调用方只读。
 */
export function boundarySurface(surface: BoundarySurface): readonly BoundaryMember[] {
  return SURFACES[surface];
}

/** 成员名列表，顺序与清单声明顺序一致（`Modulith.capabilities` 用的就是这个顺序） */
export function boundaryNames(surface: BoundarySurface): string[] {
  return SURFACES[surface].map((member) => member.name);
}

/** 值形态的成员（`value` + `handle`）—— 换成代理 / 快照之后就能过去 */
export function valueShapedMembers(surface: BoundarySurface): readonly BoundaryMember[] {
  return SURFACES[surface].filter((member) => isValueShaped(member.kind));
}

/**
 * **函数形态**的成员 —— 真正要改结构的那一批，v2 无法靠代理绕过。
 *
 * 注意它**只筛 `callable`**。`handle` 同样是引用、同样要改，但改法是机械的
 * （对象换成代理、方法换成消息）；`host-object` 也有明确出路（剥出数据）。
 * 把三者混在一起报，会让"哪些要重新设计、哪些只是换个壳"重新变得模糊。
 */
export function callableMembers(surface: BoundarySurface): readonly BoundaryMember[] {
  return SURFACES[surface].filter((member) => member.kind === 'callable');
}

/** 某个能力对象的方法清单。没有登记的能力对象返回空数组 */
export function capabilityMethods(capability: string): readonly BoundaryMethod[] {
  return CAPABILITY_METHODS[capability] ?? [];
}

/** 已登记方法的能力对象名 */
export function capabilityNames(): string[] {
  return Object.keys(CAPABILITY_METHODS);
}

/**
 * 含函数或宿主对象的方法 —— 也就是 v2 里真正要动的那几条。
 *
 * 这个函数是给门禁与文档用的：它把"51 个方法里到底有几条要改"变成一个具体数字，
 * 而不是一句"大概不多"。
 */
export function methodsNeedingWork(): Array<{ capability: string; method: BoundaryMethod }> {
  const found: Array<{ capability: string; method: BoundaryMethod }> = [];
  for (const [capability, methods] of Object.entries(CAPABILITY_METHODS)) {
    for (const method of methods) {
      if (!isValueShaped(method.io)) found.push({ capability, method });
    }
  }
  return found;
}

/**
 * 按分类统计。门禁用它把"有多少东西过不去"变成可比较的数字 ——
 * 一个只增不减的计数比一段散文更难被忽略。
 */
export function countByKind(surface: BoundarySurface): Record<BoundaryKind, number> {
  const counts: Record<BoundaryKind, number> = {
    value: 0,
    handle: 0,
    callable: 0,
    'host-object': 0,
  };
  for (const member of SURFACES[surface]) counts[member.kind] += 1;
  return counts;
}

/** 某个成员是否登记过。门禁在报错时用它区分"没登记"与"登记错了" */
export function findMember(
  surface: BoundarySurface,
  name: string
): BoundaryMember | undefined {
  return SURFACES[surface].find((member) => member.name === name);
}
