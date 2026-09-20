// src/types/plugin.ts
// Modulith 插件系统类型定义
//
// ============================================================================
// 读这个文件之前请先看这一段，否则很容易照着不存在的 API 写插件。
//
// 本文件混合了两类内容：
//
//   【已实现】—— 与运行时一致，可以照着写：
//     * `PluginManifest`（清单字段，以后端 Rust `PluginManifest` 为准）
//     * `PluginContributions` 与它的四个成员（`contributes`，宿主会真正消费）
//     * `ActivationEvent`（`activationEvents`，宿主会真正消费）
//     * `PluginPermission`（权限名，kebab-case）
//     * `PluginNotificationAPI`（`ctx.notifications`）
//     * `PluginEventAPI` / `PluginBusEvent`（`ctx.events`）
//     * `PluginLauncherAPI`（`ctx.launcher`）
//     * `PluginIconAPI`（`ctx.icons`）
//     * `PluginShellAPI`（`ctx.shell`）
//     * `PluginFileDropAPI`（`ctx.fileDrop`）
//     * `PluginAudioAPI`（`ctx.audio`）
//     * `PluginSettingsAPI` / `PluginDisposablesAPI`（`ctx.settings` / `ctx.disposables`）
//     * `ModulithCapabilities`（`Modulith.capabilities`）
//
//   【设计草案】—— 尚未实现的长期设想，**照它写会直接失败**（集中在文件末尾）：
//     * `PluginContext`（真实的上下文见 `createContext()`）
//     * `PluginLifecycle` 的各个钩子（`activate` / `deactivate` / `onInstall` …）
//       —— 注意：**卸载时的收尾现在有了**，但用的不是这组钩子，而是
//       `ctx.disposables` / `Modulith.onDeactivate()`，见 `PluginDisposablesAPI`。
//     * `PluginCommandAPI` / `PluginViewAPI` / `PluginMenuAPI` /
//       `PluginFileSystemAPI` / `PluginPluginAPI`
//     * `PluginAPI`（`getVersion` / `checkCompatibility` …）
//
// 真正被注入到 `window.Modulith` 的宿主接口是 `ModulithHost`，定义在
// `src/services/pluginRuntime.ts` —— 那是插件作者应当以之为准的那一份。
//
// 为什么草案还留着而不是删掉：它们描述的是有意向做的方向，删掉会丢失这份记录。
// 但「留着」的代价是它看起来像可用 API，因此这一段说明是必需的 ——
// 文档声称的能力与实际能力不符，比没有文档更糟。
// ============================================================================

/**
 * 语义化版本
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
  raw: string;
}

/**
 * 插件权限标识符（与 Rust `PluginPermission` 的 kebab-case 序列化保持一致）
 *
 * 这个联合类型只用于**编写清单时的类型提示**。权限的标签、描述、风险等级与强制
 * 程度都不在这里 —— 它们由宿主推导，运行时通过 `list_plugin_permissions` 取回，
 * 见 `src/services/permissionRegistry.ts`。
 *
 * 因此本类型与 Rust 枚举之间仍是一份手写副本（漏写一项不会报错，只会让清单里多出
 * 一个看起来莫名其妙的类型错误），但**风险等级不再是**：它已经没有前端副本了。
 * 风险是安全信息，不能由被审查的一方提供，也不能由前端逐条手写 —— 详见
 * docs/08-规划/插件生态设计.md 第 3 节。
 *
 * 注意「声明了」不等于「被强制」。强制程度是宿主元数据的一部分，取值为
 * `host` / `frontend` / `none`，界面必须如实标注 `none`。
 */
export type PluginPermission =
  | 'storage'                    // 本地存储
  | 'network'                    // 网络请求（本机/回环）
  | 'network-external'           // 外部域名请求
  | 'notification'               // 应用内通知（已强制）
  | 'clipboard'                  // 剪贴板访问
  | 'filesystem-read'            // 文件读取（已强制）
  | 'filesystem-write'           // 文件写入
  | 'filesystem-scoped'          // 限定目录访问
  | 'plugin-communicate'         // 插件间通信
  | 'native-module'              // 原生模块调用
  | 'dev-tools'                  // 开发者工具
  | 'process-spawn';             // 启动外部程序（已强制）

/**
 * 插件作者信息
 */
export interface PluginAuthor {
  name: string;
  email?: string;
  url?: string;
}

/**
 * 插件仓库信息
 */
export interface PluginRepository {
  type: string;
  url: string;
}

/**
 * 插件引擎要求
 */
export interface PluginEngines {
  loopcore: string;  // 语义化版本范围
}

/**
 * 模块贡献定义（`contributes.modules`）
 *
 * 这是「插件往侧边栏放一个模块」的**声明**。声明之后，宿主**不需要执行插件代码**
 * 就能把这个模块放进侧边栏、放进搜索、接受深链 —— 代码只在激活时才跑。
 *
 * `component` 不在这里：清单是数据，React 组件是行为，两者必须是分开的两件事。
 * 行为在激活时通过 `Modulith.registerModule({ id, component })` 提供，`id` 与这里对齐。
 *
 * 与「旧式插件」的区别：旧式插件在加载期直接 `registerModule()`，目录条目是那时候
 * 才出现的；声明式插件在**读到清单**时目录就完整了。
 */
export interface ModuleContribution {
  /** 模块 ID，在插件内唯一 */
  id: string;
  /** 模块名（界面显示） */
  name: string;
  /** 更长的显示名；缺省时用 `name` */
  displayName?: string;
  /** 一句话描述，用于搜索与提示 */
  description?: string;
  /**
   * 图标：宿主内置的 lucide 图标名，或插件目录内的 `.svg` 路径。
   * 缺省时回落到清单的 `icon` / `iconSvg`。
   */
  icon?: string;
  /**
   * 是否出现在侧边栏，默认 `true`。
   *
   * 置为 `false` 的模块只能通过命令、深链或其它模块的入口打开 ——
   * 这正是「功能性插件需要一个界面，但那个界面不该占侧边栏一行」的用法。
   */
  sidebar?: boolean;
  /** 挂到某个已有模块下作为子模块 */
  parent?: string;
  /** 排序权重，越小越靠前，默认 100 */
  priority?: number;
  /** 分类，默认 `plugin` */
  category?: string;
  /** 侧边栏徽标文本 */
  badge?: string;
}

/**
 * 命令贡献定义（`contributes.commands`）
 *
 * 与模块同理：面板里的条目来自**声明**，`run` 在激活时才通过
 * `Modulith.registerCommand({ id, run })` 绑定。
 *
 * 因此一个「只加几条命令、没有任何界面」的插件现在是合法的 ——
 * 这在 1.2.0 之前不可能存在（那时没注册模块会被判为加载失败）。
 */
export interface CommandContribution {
  /** 命令 ID，在插件内唯一。宿主会加上 `plugin:<插件ID>:` 前缀 */
  id: string;
  /** 面板里显示的名称 */
  title: string;
  /** 右侧的补充说明 */
  subtitle?: string;
  /** 参与匹配但不显示的额外关键词 */
  keywords?: string[];
  /** lucide 图标名 */
  icon?: string;
}

/** 设置项的取值类型 */
export type SettingType = 'boolean' | 'string' | 'number' | 'select';

export interface SettingOption {
  value: string;
  label: string;
}

/**
 * 设置项贡献（`contributes.settings`）
 *
 * **零代码贡献。** 宿主照这份声明渲染界面，值存在插件自己的存储命名空间里
 * （因此需要 `storage` 权限），插件在激活后用 `ctx.settings` 读回。
 *
 * 为什么不做成「插件提供一个 React 设置组件」：那会让设置界面必须执行插件代码
 * 才能渲染，等于把「读清单即可建立完整界面」这个前提毁掉 —— 而那个前提正是
 * 按需激活与将来沙箱化的基础。
 */
export interface SettingContribution {
  /** 设置项 ID，在插件内唯一 */
  id: string;
  /** 界面上的标签 */
  label: string;
  /** 说明文字 */
  description?: string;
  type: SettingType;
  /** 缺省值；用户没有改过时 `ctx.settings` 返回它 */
  default?: boolean | string | number;
  /** `type === 'select'` 时的候选项 */
  options?: SettingOption[];
  /** `type === 'number'` 时的范围与步长 */
  min?: number;
  max?: number;
  step?: number;
  /** `type === 'string'` 时的占位提示 */
  placeholder?: string;
}

/**
 * 右键菜单贡献（`contributes.contextMenus`）
 *
 * 菜单项执行的是**一条已声明的命令** —— 因此它不需要自己的 handler 绑定，
 * 也不需要新的宿主 API。
 */
export interface ContextMenuContribution {
  /** 在插件内唯一 */
  id: string;
  /** 菜单里显示的文字 */
  label: string;
  /** 被执行命令的**本地** ID（与 `commands[].id` 对齐） */
  command: string;
  /** lucide 图标名 */
  icon?: string;
  /** 分组。同一组的条目相邻显示；宿主自己的动作始终排在插件条目之前 */
  group?: string;
}

/**
 * 插件贡献点（`contributes`）
 *
 * 四个成员都是**可选**的，但 `contributes` 一旦出现，插件就被当作「声明式插件」：
 * 目录从清单建立，代码按 `activationEvents` 激活。
 *
 * 宿主**不校验**未知的贡献点名称（后端把 `contributes` 当作不透明 JSON 保留），
 * 这是有意的：将来新增贡献点（`themes` / `statusBar` / …）不必先改清单格式，
 * 旧宿主会忽略它，而不是让整份清单解析失败。
 */
export interface PluginContributions {
  modules?: ModuleContribution[];
  commands?: CommandContribution[];
  settings?: SettingContribution[];
  contextMenus?: ContextMenuContribution[];
}

/**
 * 激活事件（`activationEvents`）
 *
 * 语义是「**宿主可以在这些时刻激活我**」，而不是「宿主必须立刻执行我」——
 * 宿主有权把一个 `onStartup` 的插件推到机器空闲时再跑。
 *
 * 只有下面这四种会被消费。早期草案里的 `onView` / `onFile` / `onPlugin` /
 * `onRestore` **没有被实现**，写它们不会有任何效果（宿主会在控制台警告一次）。
 */
export type ActivationEvent =
  /** 应用进入可用状态之后，由宿主在空闲时激活 */
  | 'onStartup'
  /** 打开某个已声明模块时 */
  | `onModule:${string}`
  /** 执行某条已声明命令时（写本地 ID） */
  | `onCommand:${string}`
  /** 展开右键菜单并点击某项时（写本地 ID） */
  | `onContextMenu:${string}`;

/**
 * 配置迁移定义
 */
export interface ConfigMigration {
  fromVersion: string;
  toVersion: string;
  migrate: (config: any) => any;
}

/**
 * 插件配置
 */
export interface PluginConfig {
  defaultSettings: Record<string, any>;
  migrations: ConfigMigration[];
}

/**
 * 插件清单 (manifest.json)
 */
export interface PluginManifest {
  // 基本信息
  name: string;                    // 插件 ID（包名）
  displayName: string;             // 显示名称
  version: string;                 // 语义化版本
  description: string;             // 描述
  
  // 作者信息
  author: PluginAuthor;
  license?: string;
  homepage?: string;
  repository?: PluginRepository;
  
  // 分类与标签
  keywords?: string[];
  categories?: string[];
  
  // 引擎要求
  engines: PluginEngines;
  
  // 入口文件
  main: string;                    // JS 入口
  types?: string;                  // 类型定义
  style?: string;                  // 样式文件
  icon?: string;                   // 图标文件
  
  // 权限
  //
  // 这里曾有 `sandboxLevel?: SandboxLevel`。**已删除**：插件与宿主运行在同一个
  // WebView、同一个 JS 上下文里，宿主无法按等级限制它 —— 那是一个插件自己声明、
  // 宿主无法核实的字段，只会让作者与用户以为存在分级管控。
  // 替代它的是 `permissions`（正在逐步变成真强制）与出站网络策略。
  permissions?: PluginPermission[];
  
  // 依赖
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  
  // 激活事件
  activationEvents?: ActivationEvent[];
  
  // 贡献点
  contributes?: PluginContributions;
  
  // 配置
  config?: PluginConfig;
  
  // 其他
  preview?: boolean;               // 是否为预览版
  deprecated?: boolean;            // 是否已废弃
  replacedBy?: string;             // 替代插件 ID
}

/**
 * 签名信息 (signature.json)
 */
export interface PluginSignature {
  algorithm: 'RSA-SHA256' | 'ECDSA-SHA256' | 'ED25519';
  publicKey: string;
  signature: string;
  timestamp: string;
  certificate?: {
    issuer: string;
    subject: string;
    validFrom: string;
    validTo: string;
  };
}

/**
 * 插件包完整性哈希
 */
export interface PluginIntegrity {
  algorithm: 'sha256' | 'sha384' | 'sha512';
  hash: string;
}

/**
 * 插件安装源
 */
export type PluginSource =
  | { type: 'registry'; registry: string; packageName: string }
  | { type: 'file'; path: string }
  | { type: 'url'; url: string }
  | { type: 'local'; path: string };

/**
 * 插件安装状态
 */
export type PluginStatus =
  | 'uninstalled'    // 未安装
  | 'installed'      // 已安装
  | 'enabled'        // 已启用
  | 'disabled'       // 已禁用
  | 'loading'        // 加载中
  | 'error'         // 错误状态
  | 'updating'       // 更新中
  | 'removing';      // 移除中

/**
 * 插件运行时信息
 */
export interface PluginRuntimeInfo {
  loadTime: number;           // 加载时间 (ms)
  memoryUsage: number;        // 内存使用 (KB)
  lastActivated?: string;     // 最后激活时间
  activationCount: number;    // 激活次数
  errorCount: number;         // 错误次数
}

/**
 * 插件实例
 */
export interface PluginInstance {
  id: string;
  version: string;
  path: string;
  manifest: PluginManifest;
  status: PluginStatus;
  runtime?: PluginRuntimeInfo;
  exports?: PluginExports;
}

/**
 * 插件导出接口
 */
export interface PluginExports {
  activate?: (ctx: PluginContext) => Promise<void> | void;
  deactivate?: (ctx: PluginContext) => Promise<void> | void;
  onInstall?: (ctx: PluginContext) => Promise<void> | void;
  onUninstall?: (ctx: PluginContext) => Promise<void> | void;
  onUpdate?: (ctx: PluginContext, fromVersion: string) => Promise<void> | void;
  onConfigChange?: (ctx: PluginContext, newConfig: any) => Promise<void> | void;
  [key: string]: any;
}

/**
 * 插件上下文
 */
export interface PluginContext {
  // 插件信息
  pluginId: string;
  pluginVersion: string;
  manifest: PluginManifest;
  
  // API
  api: PluginAPI;
  
  // 存储
  storage: PluginStorage;
  
  // 事件
  events: PluginEventBus;
  
  // 配置
  config: PluginConfigAPI;
  
  // 日志
  logger: PluginLogger;
  
  // 命令
  commands: PluginCommandAPI;
  
  // 视图
  views: PluginViewAPI;
  
  // 菜单
  menus: PluginMenuAPI;
  
  // 通知
  notifications: PluginNotificationAPI;
  
  // 网络 (需要权限)
  http?: PluginHttpAPI;
  
  // 文件系统 (需要权限)
  fs?: PluginFileSystemAPI;
  
  // 插件间通信 (需要权限)
  plugins?: PluginPluginAPI;
}

/**
 * 插件 API 基础接口
 */
export interface PluginAPI {
  // 获取 Modulith 版本
  getVersion(): string;
  
  // 检查 API 兼容性
  checkCompatibility(minVersion: string): boolean;
  
  // 获取应用路径
  getAppPath(): string;
  
  // 获取插件数据路径
  getPluginDataPath(): string;
  
  // 获取用户数据路径
  getUserDataPath(): string;
}

/**
 * 插件存储接口
 */
export interface PluginStorage {
  get<T>(key: string, defaultValue?: T): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  all(): Promise<Record<string, any>>;
}

/**
 * 插件事件总线
 */
export interface PluginEventBus {
  emit<T>(event: string, payload?: T): void;
  on<T>(event: string, handler: (payload: T) => void): () => void;
  once<T>(event: string, handler: (payload: T) => void): () => void;
  off(event: string, handler?: (...args: any[]) => void): void;
}

/**
 * 插件配置 API
 */
export interface PluginConfigAPI {
  get<T>(key: string, defaultValue?: T): T;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Record<string, any>;
  reset(): Promise<void>;
  onChange: (callback: (config: Record<string, any>) => void) => () => void;
}

/**
 * 插件日志接口
 */
export interface PluginLogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  trace(label: string): () => void;
}

/**
 * 插件命令 API
 */
export interface PluginCommandAPI {
  register(command: string, handler: (...args: any[]) => any): () => void;
  execute<T>(command: string, ...args: any[]): Promise<T>;
  getAllCommands(): string[];
}

/**
 * 视图贡献定义（**草案专用**）
 *
 * 1.2.0 起，真正被消费的贡献点是 `PluginContributions` 的四个成员；
 * 这个形状只服务于下面 `PluginViewAPI` 那份**未实现**的草案，因此它留在这里
 * 而不是和实现放在一起 —— 免得被当成可以写进 `contributes` 的字段。
 */
export interface ViewContribution {
  id: string;
  name: string;
  icon?: string;
  priority?: number;
  component?: string;
}

/**
 * 菜单贡献定义（**草案专用**）。见 `ViewContribution` 的说明。
 * 真正可用的右键菜单贡献是 `ContextMenuContribution`。
 */
export interface MenuContribution {
  location: string;
  command: string;
  group?: string;
  when?: string;
}

/**
 * 插件视图 API（**未实现**）
 */
export interface PluginViewAPI {
  register(view: ViewContribution, component: React.ComponentType): () => void;
  unregister(viewId: string): void;
  focus(viewId: string): void;
}

/**
 * 插件菜单 API（**未实现**）
 */
export interface PluginMenuAPI {
  register(menu: MenuContribution): () => void;
  unregister(location: string, command: string): void;
}

/**
 * 宿主能力表（`Modulith.capabilities`）的**实际**签名。
 *
 * 用途：插件在运行时判断宿主有没有某个能力，而不是靠 `Modulith.version` 做字符串
 * 比较。`engines.loopcore` 只表达「我要求宿主至少多新」，而且它**只提示、不阻断**；
 * 真正决定一段代码能不能跑的，是这里列出的东西。
 *
 * 典型用法：
 *
 * ```js
 * if (Modulith.capabilities.contributions.includes('settings')) { ... }
 * ```
 *
 * `api` 是这份能力表自身的版本号。它和 `Modulith.version` 是两件事 ——
 * 宿主可以发一个补丁版本而不动能力表。
 *
 * **这里刻意不列权限名。** 权限的权威是后端 `PluginPermission` 枚举，前端已经有一条
 * 取回它的路径（`list_plugin_permissions` / `permissionRegistry`）；在这里再放一份
 * 就是同一份名单的第二个副本，而副本必然漂移 —— 这正是 1.1.x 反复记录过的教训。
 *
 * `scripts/check-contributions.ts` 把下面四个数组钉成了断言：增删成员必须同时改
 * 检查脚本，因此它不会悄悄漂移。
 */
export interface ModulithCapabilities {
  /** 能力表自身的版本，从 1 开始 */
  api: number;
  /** `window.Modulith` 上可用的成员名 */
  host: string[];
  /** `createContext()` 返回的服务名 */
  context: string[];
  /** 宿主会消费的贡献点名（`contributes` 的键） */
  contributions: string[];
  /** 宿主会消费的激活事件名（不含冒号后的参数） */
  activationEvents: string[];
}

/**
 * 插件设置 API（`ctx.settings` 的**实际**签名）。
 *
 * 读的是 `contributes.settings` 里那些设置项的当前值。宿主负责渲染界面、
 * 落盘与缺省值，插件只读结果 —— 因此插件**不需要**自己发明键名，
 * 也不需要自己处理「用户从没改过」这种情况（那时返回清单里的 `default`）。
 *
 * 需要清单声明 `storage` 权限：值存在插件自己的存储命名空间里，
 * 与 `ctx.storage` 共用同一套后端命令。未声明时读取返回缺省值、写入抛错。
 *
 * `getAll()` 是同步的：值在插件激活前就已随贡献目录读好，因此插件可以在
 * 顶层（激活期）直接读它来决定怎么做，不必先 `await`。
 */
export interface PluginSettingsAPI {
  /** 权限已声明且设置已读入 */
  isAvailable(): boolean;
  /** 单项；没有声明过该 id 时返回 `undefined` */
  get<T = unknown>(id: string): T | undefined;
  /** 全部设置项（键是设置项 id） */
  getAll(): Record<string, unknown>;
  /** 写入一项；返回的 Promise 在落盘后完成 */
  set(id: string, value: unknown): Promise<void>;
  /** 订阅变更（宿主设置界面写入时也会触发），返回取消订阅函数 */
  onChange(handler: (id: string, value: unknown) => void): () => void;
}

/**
 * 插件资源回收 API（`ctx.disposables` 的**实际**签名）。
 *
 * 这是功能型插件的前提：一个后台服务会创建定时器、事件监听、观察者、
 * WebSocket、音频节点 —— 这些**宿主一个都不知道**，插件被禁用之后
 * 它们会一直活着。把清理函数交到这里，宿主会在卸载/禁用/重新加载时
 * 按**逆序**执行。
 *
 * 三条保证：
 *   1. 逆序执行（后申请的先释放，与栈一致）；
 *   2. 单个清理函数抛错**不影响**其余；
 *   3. 每个清理函数只执行一次（重复注册同一个函数不会重复执行）。
 *
 * 插件若需要在使用之后立刻释放（而不是等到卸载），应当直接调用 `dispose()`
 * 并把该函数从表里摘掉 —— `dispose()` 返回后 `size` 会相应减少。
 */
export interface PluginDisposablesAPI {
  /** 注册一个清理函数；返回一个「提前执行并移除它」的函数 */
  add(dispose: () => void): () => void;
  /** 当前待执行的清理函数数量 */
  size(): number;
}

/**
 * 插件通知 API（`ctx.notifications` 的**实际**签名）。
 *
 * 与本节其他接口不同，这个接口是**已实现**的：`createContext()` 会真的返回它，
 * 需要清单声明 `notification` 权限。未声明时返回空实现并记录一条警告，
 * 不会让插件整体加载失败（见 pluginRuntime.ts 的 pluginNotifications）。
 *
 * 与早期草案的差异（曾写成 `info(title, message, options?)` 返回 void）：
 *   * 返回 `Promise<void>` —— 通知要落盘，调用方可能需要等它写完；
 *   * 第三个参数是 `dedupeKey` 而不是一个 options 对象 —— 当前唯一需要控制的
 *     就是「同一条信息重复发生时合并」，其余（时长、动作按钮、点击回调）
 *     都还没有实现，与其留一个永远被忽略的参数，不如只暴露真实可用的那个；
 *   * 多一个 `show`（显式指定 info 级别）与 `isAvailable()`，后者让插件不必
 *     只看控制台就知道自己有没有权限。
 *
 * **只有应用内通知，没有系统级通知。** 那需要引入 `tauri-plugin-notification`
 * 依赖，当前版本刻意不新增依赖，因此这里不提供 `NotificationAction` /
 * `onClick` 之类依赖系统通知中心的形态。
 */
export interface PluginNotificationAPI {
  /** 权限是否已声明；false 时其余方法都是空实现 */
  isAvailable(): boolean;
  show(title: string, body?: string, dedupeKey?: string): Promise<void>;
  info(title: string, body?: string, dedupeKey?: string): Promise<void>;
  warn(title: string, body?: string, dedupeKey?: string): Promise<void>;
  error(title: string, body?: string, dedupeKey?: string): Promise<void>;
  success(title: string, body?: string, dedupeKey?: string): Promise<void>;
}

/**
 * 插件跨模块事件 API（`ctx.events` 的**实际**签名）。
 *
 * 同样是已实现的接口，需要 `plugin-communicate` 权限。见 services/eventBus.ts。
 * 订阅自动归属到插件 ID，因此插件被卸载时宿主会一次性摘掉它的全部订阅。
 */
export interface PluginEventAPI {
  isAvailable(): boolean;
  publish(topic: string, payload?: unknown): void;
  subscribe<T = unknown>(topic: string, handler: (event: PluginBusEvent<T>) => void): () => void;
}

export interface PluginBusEvent<T = unknown> {
  topic: string;
  payload: T;
  /** 发布方：模块 ID、插件 ID 或 `host` */
  source: string;
  at: number;
}

/**
 * 插件 HTTP API
 */
export interface PluginHttpAPI {
  get(url: string, options?: RequestInit): Promise<Response>;
  post(url: string, data?: any, options?: RequestInit): Promise<Response>;
  put(url: string, data?: any, options?: RequestInit): Promise<Response>;
  delete(url: string, options?: RequestInit): Promise<Response>;
  fetch(url: string, options?: RequestInit): Promise<Response>;
}

/**
 * 插件启动外部程序 API（`ctx.launcher` 的**实际**签名）。
 *
 * 已实现，需要 `process-spawn` 权限。**这是插件能拿到的最强能力** ——
 * 它可以运行本机上的任意程序。因此未声明权限时是**拒绝**（抛出错误），
 * 而不是像通知那样降级为空实现：一次静默失败的启动请求，只会让作者
 * 以为是自己的路径写错了。
 *
 * 与 `notification` / `events` 不同，这一项在后端强制：真正的门是 Rust 侧的
 * `plugin_launch_program`，前端绕不过去。
 */
export interface PluginLauncherAPI {
  /**
   * 启动一个程序。
   *
   * `program` 必须是**绝对路径**且指向一个已存在的文件；不接受 `cmd` 这类
   * 依赖 PATH 解析的程序名。`args` 作为独立参数传递，不经过 shell。
   */
  launch(program: string, args?: string[]): Promise<void>;
}

/**
 * 插件图标提取 API（`ctx.icons` 的**实际**签名）。
 *
 * 需要 `filesystem-read` 权限，在 Rust 侧强制。返回可直接放进 `src` 的
 * PNG data URL；非 Windows 平台或文件没有图标资源时会抛出错误，调用方应当
 * 准备好回退图标（而不是把失败当成致命错误）。
 */
export interface PluginIconAPI {
  /** 提取指定文件的图标；`path` 必须是绝对路径 */
  extract(path: string): Promise<string>;
}

/**
 * 插件与本机外壳协作的 API（`ctx.shell` 的**实际**签名）。
 *
 * 需要 `filesystem-read` 权限。目前只有「在文件管理器中定位」，它**不会打开
 * 文件本身**，因此没有借插件之手执行文件的风险。
 */
export interface PluginShellAPI {
  /** 在系统文件管理器中定位文件或目录 */
  revealInFolder(path: string): Promise<void>;
}

export interface PluginFileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  /** 拖入的文件或目录的绝对路径；非 `drop` 阶段可能是空数组 */
  paths: string[];
}

/**
 * 插件文件拖放 API（`ctx.fileDrop` 的**实际**签名）。
 *
 * 需要 `filesystem-read` 权限，未声明时降级为空实现（订阅返回空函数）。
 *
 * **事件是窗口级的**：只要有文件被拖进窗口就会触发，与当前显示哪个模块无关。
 * 插件必须自己用 `Modulith.useModuleActive()` 判断可见性，否则会在后台抢走
 * 本该属于其它模块的拖放。
 */
export interface PluginFileDropAPI {
  /** 权限已声明且底层监听建立成功 */
  isAvailable(): boolean;
  /** 订阅拖放事件，返回取消订阅函数 */
  subscribe(handler: (event: PluginFileDropEvent) => void): () => void;
}

/**
 * 插件音频导入 API（`ctx.audio` 的**实际**签名）。
 *
 * 需要 `filesystem-read` 权限，在 Rust 侧强制。
 *
 * 刻意做成「选择 + 读取 + 编码」一步到位：插件拿到的是可直接播放的 data URL，
 * **接触不到原始字节或路径**。这样扩展名校验与体积上限只有一个执行点，
 * 也就没有绕过限制的路径。与 `ctx.icons` 同一思路 —— 宿主给成品，不给原料。
 *
 * 拿到之后建议存进插件自己的存储（`ctx.storage`），下次启动就不必再让用户选一次。
 */
export interface PluginAudioAPI {
  /** 弹出原生文件选择框；用户取消时返回 `null`（取消不是错误） */
  pick(): Promise<PickedAudio | null>;
}

export interface PickedAudio {
  /** 原始文件名，界面上显示「当前提示音：xxx.mp3」用 */
  name: string;
  /** 形如 `data:audio/mpeg;base64,...`，可直接交给 `new Audio(...)` */
  dataUrl: string;
  /** 原始字节数 */
  bytes: number;
}

/**
 * 插件文件系统 API
 */
export interface PluginFileSystemAPI {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
}

/**
 * 插件间通信 API
 */
export interface PluginPluginAPI {
  getPlugin(pluginId: string): Promise<PluginInstance | null>;
  callCommand(pluginId: string, command: string, ...args: any[]): Promise<any>;
  sendMessage(pluginId: string, message: any): Promise<void>;
  onMessage(handler: (fromPluginId: string, message: any) => void): () => void;
}

/**
 * 插件错误信息
 */
export interface PluginErrorInfo {
  pluginId: string;
  error: Error;
  timestamp: string;
  context: string;
  stack?: string;
}

/**
 * 插件更新信息
 */
export interface PluginUpdateInfo {
  pluginId: string;
  currentVersion: string;
  availableVersion: string;
  isCompatible: boolean;
  releaseNotes?: string;
  downloadUrl?: string;
  integrity?: PluginIntegrity;
}

/**
 * 插件搜索结果
 */
export interface PluginSearchResult {
  total: number;
  plugins: PluginSummary[];
  hasMore: boolean;
}

/**
 * 插件摘要信息
 */
export interface PluginSummary {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: PluginAuthor;
  icon?: string;
  categories?: string[];
  keywords?: string[];
  downloads?: number;
  rating?: number;
  preview?: boolean;
}

/**
 * 插件详情
 */
export interface PluginDetail extends PluginSummary {
  manifest: PluginManifest;
  readme?: string;
  changelog?: string;
  screenshots?: string[];
  repository?: PluginRepository;
  homepage?: string;
  license?: string;
  publishedAt?: string;
  updatedAt?: string;
}

/**
 * 插件注册表配置
 */
export interface RegistryConfig {
  name: string;
  url: string;
  priority: number;
  verifySignature: boolean;
}

/**
 * 插件管理器配置
 */
export interface PluginManagerConfig {
  registries: RegistryConfig[];
  offlineMode: boolean;
  cacheEnabled: boolean;
  cacheTTL: number;  // 秒
  autoUpdate: boolean;
  allowUnsignedPlugins: boolean;
  maxBackupVersions: number;
  sandboxEnabled: boolean;
}

/**
 * 定义插件的辅助类型
 */
export type DefinePlugin<T extends PluginExports = PluginExports> = T & {
  __pluginManifest?: PluginManifest;
};
