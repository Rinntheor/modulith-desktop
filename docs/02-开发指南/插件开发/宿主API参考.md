# 宿主 API 参考

宿主在页面加载时向 `window` 注入 `Modulith` 对象，这是插件与框架交互的唯一入口。本文列出全部可用接口与使用约束。

## 1. window.Modulith

接口**没有被 `Object.freeze`**，宿主也没有用 `defineProperty` 把它设为只读。插件在技术上可以覆写或增删 `window.Modulith` 上的成员，宿主不会检测、也不会因此拒绝加载。约定是「不要修改」，而不是「不能修改」。

之所以不加冻结，是因为 `version` 本身需要在后端版本号取回后被宿主就地更新：`reloadPluginRuntime()` 会先 `await refreshHostVersion()`，再在已注入的情况下写入 `Modulith.version`。冻结会把这条唯一的写路径也一并封死。若要改为冻结，需要先把 `version` 改成 getter，属于接口形态变更，当前未做。

需要强调的后果：**覆写 `Modulith` 只会破坏你自己的插件**。宿主内部并不通过 `window.Modulith` 调用这些函数——它持有模块作用域内的原始引用（`React`、`jsx`、`registerModule` 等直接 import 进来），插件写入 `window.Modulith.registerModule = ...` 只影响后续加载的其他插件读到的值。宿主不提供接口防护，因此不要在生产插件里依赖这种写法的任何「隔离」效果。

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `version` | string | 宿主版本号，来自后端 `get_app_info` |
| `platform` | string | 固定为 `"tauri"` |
| `React` | object | 宿主使用的 React 实例 |
| `jsx` | function | 宿主的 JSX 运行时（自动运行时） |
| `jsxs` | function | 同 `jsx`，用于多子元素场景 |
| `Fragment` | symbol | React Fragment |
| `registerModule` | function | 注册一个模块 |
| `createContext` | function | 取得当前插件的服务集合（靠隐式全局定位插件） |
| `run` | function | **推荐**：显式引导 —— 宿主把身份与数据作为参数交进来，见 [1.5](#15-run推荐) |
| `registerCommand` | function | 把一个动作注册进全局搜索框 |
| `useModuleActive` | function | 判断当前模块是否真的对用户可见（Hook） |
| `capabilities` | object | 宿主能力表。**特性探测用它**，不要比较版本号 |

`Modulith.capabilities` 的 `api` 字段是**接口表自身的版本**，当前为 `1`。它描述的是"宿主认识哪些成员"，
不是"你这个插件用第几版接口" —— 插件不需要在清单里声明 api 版本，用哪个入口由插件自己决定。

`registerCommand` 与 `createContext` 一样**只能在插件加载期间调用**（即 IIFE 顶层），因为命令需要归属到具体插件，而「当前正在加载哪个插件」只有加载期才有确定值。宿主会给 ID 加上 `plugin:<插件ID>:` 前缀，插件卸载时据此一次性摘除它注册的全部命令。

```js
window.Modulith.registerCommand({
  id: 'clear-done',                       // 插件内的局部 ID，宿主自动加前缀
  title: '清除已完成的待办',
  keywords: ['clear', 'qingchu'],
  run: function () { ctx.storage.set('todos', []); },
});
```

`useModuleActive` 是标签页保活的配套接口：模块被切走后**不会卸载**，定时器与轮询会照常运行。插件应当用它决定要不要暂停后台工作：

```js
var React = window.Modulith.React;
var active = window.Modulith.useModuleActive();

React.useEffect(function () {
  if (!active) return;                    // 在后台就不起轮询
  var timer = setInterval(refresh, 30000);
  return function () { clearInterval(timer); };
}, [active]);
```

它同时考虑了两件事：所在格子是否**可见**，以及窗口是否被最小化 / 隐藏。宿主提供的是**感知能力**而不是强制暂停 —— JS 里拿不到模块创建的定时器句柄，宿主无法可靠地代为清理。

**分屏之后「可见」的含义需要说清。** 宿主支持窗口内分屏：内容区会被分成左右两个**标签组**，每组有自己的标签栏与激活标签。此时**两组的激活标签都可见**，因此 `useModuleActive()` 在它们上面都返回 `true`。这正是它该有的行为 —— 用户同时看着它们，两边都该照常工作。

需要注意的推论：如果你的插件假设「同一时刻只有一个模块实例在跑」，分屏会让这个假设失效 —— 用户可以同时打开两个模块（甚至是同一插件的两个模块）而它们互不知道对方也在运行。共享同一条外部资源（定时器、串口、文件）时请自行用 `ctx.storage` 或 `ctx.events` 做互斥。

### 1.1 使用 React

插件必须使用 `Modulith.React`，不得自行导入 React：

```js
var React = window.Modulith.React;
var h = React.createElement;
```

原因在于 Hooks 依赖模块实例的身份。如果插件打包进自己的 React 副本，那么插件组件调用 `useState` 时读取的是另一个实例的内部状态，导致「Invalid hook call」或状态不同步。共用同一实例是硬性要求。

打包时应把以下模块设为外部依赖，映射到 `Modulith` 的对应成员：

| 模块 | 映射到 |
| --- | --- |
| `react` | `Modulith.React` |
| `react/jsx-runtime` | `Modulith`（宿主在该对象上同时提供 `jsx` / `jsxs` / `Fragment`） |
| `react-dom` | 不映射 —— 宿主不提供 ReactDOM，也不该外部化（见下） |

映射目标是**打包器里那个全局标识符本身**，不是它的子成员：`globals` 只接受一个标识符，打包器会在它后面继续取属性。因此 `react` 映射到 `Modulith.React`（产物里会写 `Modulith.React.createElement`），而 `react/jsx-runtime` 必须映射到 `Modulith`（产物里会写 `Modulith.jsx` / `Modulith.jsxs` / `Modulith.Fragment`）。把后者写成 `Modulith.jsx` 会得到 `Modulith.jsx.jsx`。

宿主**不提供** `ReactDOM`。插件不应调用 `createRoot` 或 `render`，而应通过 `registerModule` 交出组件，由宿主负责挂载与卸载。

### 1.2 JSX 自动运行时

若构建工具配置为自动运行时，编译产物会引用 `react/jsx-runtime` 的 `jsx`、`jsxs` 与 `Fragment`。这三者都可在 `Modulith` 上找到，按上表映射即可。

### 1.3 registerModule

```js
Modulith.registerModule({
  id: 'notes',
  name: '文本速记',
  description: '随手记下想法、待办与片段',
  // lucide-react 的图标名。留空则回退到清单里的 icon（那个才是文件路径）
  icon: 'NotebookPen',
  priority: 70,
  category: 'plugin',
  component: Notes,
});
```

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 模块唯一标识，不得与内建模块或其他插件模块冲突 |
| `name` | string | 是 | 模块名 |
| `component` | React 组件 | 是 | 模块的根组件，接收空 props |
| `displayName` | string | 否 | 显示名，缺省时使用 `name` |
| `description` | string | 否 | 描述 |
| `icon` | string | 否 | lucide-react 图标名 |
| `path` | string | 否 | 逻辑路径 |
| `priority` | number | 否 | 排序权重，升序 |
| `category` | string | 否 | 分组名 |
| `badge` | string | 否 | 角标文本 |

调用时机：必须在 `registerModule` 可用的窗口内调用，即插件代码执行期间。注册成功后模块进入动态编目，与内建模块一起出现在侧边栏。

如果插件执行完毕却没有注册任何模块，宿主会判定加载失败。

### 1.4 createContext

```js
var ctx = Modulith.createContext();
```

返回绑定到当前插件的服务集合：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pluginId` | string | 当前插件 ID |
| `pluginVersion` | string | 当前插件版本 |
| `manifest` | object | 解析后的清单 |
| `version` | string | 宿主版本号 |
| `storage` | object | 插件私有存储（键值） |
| `dataDir` | object | 插件私有文件目录（需 `plugin-data` 权限） |
| `db` | object | 每插件一个 SQLite（需 `plugin-data` 权限） |
| `http` | object | 网络请求 |
| `logger` | object | 带插件前缀的日志 |
| `notifications` | object | 应用内通知（需 `notification` 权限） |
| `events` | object | 跨模块事件总线（需 `plugin-communicate` 权限） |
| `launcher` | object | 启动外部程序（需 `process-spawn` 权限） |
| `icons` | object | 提取本机文件图标（需 `filesystem-read` 权限） |
| `shell` | object | 在文件管理器中定位（需 `filesystem-read` 权限） |
| `fileDrop` | object | 接收拖入的文件路径（需 `filesystem-read` 权限） |
| `audio` | object | 导入音频文件（需 `filesystem-read` 权限） |

**调用时机是严格受限的**：只能在插件 bundle 执行期间调用，例如 IIFE 顶层。在插件代码之外调用会抛出异常，因为服务需要绑定正在加载的插件 ID。

推荐在 bundle 顶层获取一次并复用：

```js
(function () {
  var Modulith = window.Modulith;
  if (!Modulith) return;

  var ctx = Modulith.createContext();   // 顶层获取一次

  function MyView() {
    // 在组件内部闭包引用 ctx 即可，不要再次调用 createContext
    React.useEffect(function () {
      ctx.storage.get('key').then(function (value) { /* ... */ });
    }, []);
    return null;
  }

  Modulith.registerModule({ id: 'myView', name: '我的视图', component: MyView });
})();
```

### 1.5 run（推荐）

```js
var ctx = null;
Modulith.run(function (bootstrap) {
  ctx = bootstrap.ctx;      // 与 Modulith.createContext() 返回的是**同一个**对象
});
```

`run` 与 `createContext` 返回同一个 `ctx`，**区别只在插件身份怎么获得**：

| | 身份来源 | 跨进程可用 |
| --- | --- | --- |
| `createContext()` | 「当前正在加载哪个插件」这一全局状态 | ✗ |
| `run(bootstrap)` | 宿主作为**参数**传进来 | ✓ |

插件将来挪进独立进程（沙箱化）之后，那个全局状态不复存在，而显式传参跨得过去。
因此**新插件应当用 `run`**；已有的 `createContext()` 写法不会被移除。

`bootstrap` 里全是**值**（字符串、数字、纯对象），这正是它能跨进程的原因：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pluginId` | string | 本插件 ID |
| `pluginVersion` | string | 本插件版本 |
| `hostVersion` | string | 宿主版本 |
| `manifest` | object \| undefined | 本插件的清单 |
| `activationEvent` | string \| null | 本次由什么触发；旧式插件为 `'legacy'` |
| `capabilities` | object | 宿主能力表。**特性探测用它**，不要比较版本号 |
| `settings` | object | 本插件声明的设置项的**当前值快照**（只读，不跟随变化） |
| `ctx` | object | 上下文，与 `createContext()` 的返回值相同 |

⚠️ **回调是同步执行的。** 它**不是**"延迟到激活事件再执行"的生命周期钩子 ——
什么时候执行整段 bundle 仍然由清单里的 `activationEvents` 决定。因此 `registerModule()`
这类"必须在加载期同步完成"的调用，放进这个回调里同样有效：

```js
(function () {
  var Modulith = window.Modulith;
  if (!Modulith) return;

  var React = Modulith.React;
  var ctx = null;

  Modulith.run(function (bootstrap) {
    ctx = bootstrap.ctx;
    // bootstrap.activationEvent 让我们只为"被用到的那部分"做准备
    if (bootstrap.activationEvent === 'onStartup') { /* 后台预热 */ }
  });

  function MyView() { /* ... */ }

  Modulith.registerModule({ id: 'myView', name: '我的视图', component: MyView });
})();
```

`settings` 是快照而不是读取器：它在 bundle 执行**之前**取好，之后不会跟着变化。
需要跟进用户改动就用 `ctx.settings.onChange`。它需要清单声明 `storage` 权限，
未声明时是空对象（与 `ctx.settings.get` 的降级一致）。

## 2. storage

插件私有存储，按插件 ID 隔离。数据以 JSON 序列化后保存在应用数据目录中，卸载插件时一并清除。

**需要 `storage` 权限。** 清单里必须声明：

```json
"permissions": ["storage"]
```

未声明时所有方法都会被**拒绝**（返回错误），而不是静默失效。存储不属于「可选附加能力」：拿不到数据却继续运行，只会让作者对着「界面是空的」反复排查，不如直接报明原因。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `get` | `get<T>(key, defaultValue?) => Promise<T \| undefined>` | 读取并反序列化；键不存在或解析失败时返回 `defaultValue` |
| `set` | `set<T>(key, value) => Promise<void>` | 序列化后写入 |
| `delete` | `delete(key) => Promise<void>` | 删除单个键 |
| `clear` | `clear() => Promise<void>` | 清空该插件的全部数据 |
| `keys` | `keys() => Promise<string[]>` | 列出全部键 |
| `all` | `all() => Promise<Record<string, unknown>>` | 读取全部键值 |

用法：

```js
// 读取，带默认值
var notes = await ctx.storage.get('notes', []);

// 写入任意可 JSON 序列化的值
await ctx.storage.set('notes', [{ id: '1', text: '第一条' }]);

// 删除
await ctx.storage.delete('notes');

// 遍历全部
var keys = await ctx.storage.keys();
```

注意 `get` 在内部捕获 JSON 解析错误并返回默认值，因此数据损坏不会导致调用方抛出异常。

**不要用 localStorage 保存插件数据**。`storage` 会随插件卸载而清理，且按插件隔离；`localStorage` 既不隔离也不清理。

## 2.1 db

结构化数据。**每插件一个 SQLite 文件**（数据目录里的 `plugin.db`）。
**需要 `plugin-data` 权限**（与 `ctx.dataDir` 同一项）。

三层数据的分工：

| | 装什么 | 上限 | 能查询吗 |
| --- | --- | --- | --- |
| `ctx.storage` | 一键一个 JSON | 单值 1 MB、总量 8 MB | 不能 |
| `ctx.dataDir` | 文件与目录 | 单文件 256 MB、总量 1 GiB | 不能 |
| `ctx.db` | 表与索引 | 与数据目录共用配额（数据库占一半） | **能** |

关键在于最后一行：要"按标签筛、按更新时间排、取第 3 页"时，前两层能做的只有
把所有数据拉进 JS 自己过滤 —— 而那正是"一千条以后就开始卡"的来源。

```js
// 建表（DDL 也是 exec）
await ctx.db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )
`);
await ctx.db.exec('CREATE INDEX IF NOT EXISTS notes_updated ON notes (updated_at DESC)');

// 写入。参数用 ?1 / ?2 占位，按数组顺序绑定 —— 不要自己拼字符串
await ctx.db.exec('INSERT INTO notes (title, tags, updated_at) VALUES (?1, ?2, ?3)', [
  '第一条',
  JSON.stringify(['demo']),
  Date.now(),
]);

// 查询：返回对象数组
const recent = await ctx.db.query('SELECT id, title FROM notes ORDER BY updated_at DESC LIMIT ?1', [20]);

// 一批语句，全成功或全回滚
await ctx.db.transaction([
  { sql: 'UPDATE notes SET title = ?1 WHERE id = ?2', params: ['改过的', 1] },
  { sql: 'DELETE FROM notes WHERE id = ?1', params: [2] },
]);

// 需要重名列或原始数组时
const raw = await ctx.db.queryRaw('SELECT 1 AS id, 2 AS id');
// { columns: ['id','id'], rows: [[1, 2]] }
```

### 值的形状

* 对象与数组会被存成 **JSON 文本**（读回来是一段字符串，自己 `JSON.parse`）；
* 二进制用 `{ $blob: '<base64>' }` 表示，**两个方向都是**。裸 base64 字符串与
  一段恰好是合法 base64 的文本分不开，那样"读回来的文本变成了字节"要到很后面
  才会被发现；
* 整数与浮点数保持数值类型，`null` 保持 `null`；
* `BigInt` **不支持** —— 宿主侧收的是 JSON，没有 int64 那种类型，而悄悄截断会
  让一个 id 变成另一个 id。

### 边界（都由 SQLite 引擎执行，不是字符串过滤）

* `ATTACH` / `DETACH` **被拒绝** —— 那是唯一一条能在同一个连接里打开别的文件的
  SQL，也就是唯一一条能跨出你数据目录的路；
* `PRAGMA max_page_count` / `page_size` / `journal_mode` / `locking_mode` /
  `writable_schema` / `mmap_size` 的**设值**被拒绝（读取照常）；
* `load_extension` 被拒绝；
* **一次调用只编译一条语句**。`exec('SELECT 1; SELECT 2')` 会直接失败 ——
  一个"最后一条失败、前几条已经生效"的调用没法被正确处理。多条要一起成功或
  一起失败，用 `transaction`；
* 外键**默认是开的**（SQLite 的历史缺省是关，而"删了父行子行还在"看起来像
  数据库不守规矩）；
* `plugin.db` 是**保留名**：`ctx.dataDir.write` / `remove` 碰不到它（读可以 ——
  备份应当在损坏之前就能做）。

### 没有 `begin()` / `commit()`

跨调用的显式事务是**会泄漏的状态**：你的代码在 `begin` 之后抛异常、插件被禁用、
或者你只是忘了提交，那条写事务就一直挂着，而这个连接会被下一个打开数据库的实例
继续用 —— 于是"我什么都没干，它却说数据库被锁住了"。更要命的是浏览器/宿主这一侧
没有一个"无论发生什么都会执行"的 `finally`。

因此事务的边界必须落在**这一次** `transaction()` 调用里。

## 3. http

网络请求服务。返回标准 `Response` 对象，因此可以像 `fetch` 一样使用。

> **这是插件联网的唯一通道。** 直接用 `fetch`、`XMLHttpRequest`、`WebSocket`
> 或 `navigator.sendBeacon` 会被拒绝：CSP 的 `connect-src` 只放行 IPC 与回环地址，
> 宿主还会在调用时给出明确原因并记一条流量日志。走 `ctx.http` 才能带上权限检查、
> 出站策略与日志 —— 三者都落在后端，直接发请求会把它们一起绕过去。
>
> 唯一例外是**回环地址**（`127.0.0.1` / `localhost` / `::1`）：连本机不出这台机器，
> 因此直接连也放行。即便如此，`ctx.http` 仍然是首选 —— 它会留下日志。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `fetch` | `fetch(url, init?) => Promise<Response>` | 通用请求，方法取自 `init.method`，默认 GET |
| `get` | `get(url, init?) => Promise<Response>` | GET |
| `post` | `post(url, data?, init?) => Promise<Response>` | POST，`data` 会被 JSON 序列化 |
| `put` | `put(url, data?, init?) => Promise<Response>` | PUT，`data` 会被 JSON 序列化 |
| `delete` | `delete(url, init?) => Promise<Response>` | DELETE |

用法：

```js
// GET 并解析 JSON
var res = await ctx.http.get('https://api.example.com/items');
var items = await res.json();

// POST JSON
var created = await ctx.http.post('https://api.example.com/items', { name: '新条目' });

// 自定义请求头
await ctx.http.get('https://api.example.com/data', {
  headers: { Authorization: 'Bearer token' },
});
```

### 3.1 权限要求

网络访问受清单权限约束，未声明时请求会被拒绝：

| 目标 | 需要的权限 |
| --- | --- |
| 本机回环地址（`127.0.0.1`、`localhost`、`::1`） | `network` |
| 其他地址 | `network` 与 `network-external` |

因此访问外部接口的插件需要同时声明两项：

```json
"permissions": ["network", "network-external"]
```

请求由后端发出，因此不受浏览器同源策略限制。

## 4. logger

带 `[plugin:<id>]` 前缀的日志输出，便于在开发者工具中按插件过滤。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `debug` | `debug(msg, ...args)` | 调试信息 |
| `info` | `info(msg, ...args)` | 一般信息 |
| `warn` | `warn(msg, ...args)` | 警告 |
| `error` | `error(msg, ...args)` | 错误 |
| `trace` | `trace(label) => () => void` | 计时，调用返回值输出耗时 |

用法：

```js
ctx.logger.info('插件已加载', { version: ctx.pluginVersion });

// 计时
var done = ctx.logger.trace('加载数据');
await loadData();
done();   // 输出 "加载数据: 12.3ms"
```

## 5. notifications

应用内通知。**需要清单声明 `notification` 权限**；未声明时这些方法都是空实现，并会在控制台留下一条警告，但不会导致插件加载失败。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `isAvailable` | `isAvailable() => boolean` | 权限是否已声明 |
| `show` / `info` | `(title, body?, dedupeKey?) => Promise<void>` | 一般信息 |
| `success` | 同上 | 成功 |
| `warn` | 同上 | 警告（浮层停留更久） |
| `error` | 同上 | 错误（浮层不自动消失） |

```json
"permissions": ["storage", "notification"]
```

```js
// 普通通知：右下角浮层 + 通知中心，重启后仍在
await ctx.notifications.info('同步完成', '共 42 条记录');

// dedupeKey：同一条信息重复发生时合并为一条（计数递增），不会反复弹浮层
await ctx.notifications.warn('网络不可用', '正在重试', 'network-down');

// 主动查询权限，自行降级
if (!ctx.notifications.isAvailable()) {
  console.warn('本插件未声明 notification 权限，将改用模块内提示');
}
```

几个必须知道的行为：

- `source` 自动设为**插件 ID**，而不是你注册的模块 ID。这两者通常不同（插件 ID 是 `com.example.my-plugin`，模块 ID 是你自己起的 `myView`）。
- 未读徽标与「打开模块」入口会自动处理这个差异：`moduleCatalog` 的 `getNotificationSourcesFor()` 把模块展开为「模块 ID + 其所属插件 ID」，`resolveNotificationTarget()` 把插件 ID 解析回该插件注册的第一个模块。因此一个插件注册多个模块时，通知会显示在**所有**这些模块的徽标上，而点击跳转到 priority 最小的那一个 —— 通知本身不携带「属于哪个模块」的信息。
- **浮层的展示规则**：`dedupeKey` 命中一条**已读**记录时不会合并（那是新的一件事），因此会重新弹一次；命中未读记录时只增加计数、不弹浮层。
- **只有应用内通知，没有系统级通知。** 应用关闭时无法提醒。这需要在宿主里引入 `tauri-plugin-notification` 依赖，当前版本刻意不新增依赖，因此不提供该能力。
- 通知总量上限 200 条，超出后优先丢弃已读的旧通知。

## 6. events

跨模块事件总线。**需要清单声明 `plugin-communicate` 权限**；未声明时 `publish` 被忽略、`subscribe` 返回空的取消函数（同样只记警告）。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `isAvailable` | `isAvailable() => boolean` | 权限是否已声明 |
| `publish` | `publish(topic, payload?) => void` | 发布，同步投递 |
| `subscribe` | `subscribe<T>(topic, handler) => () => void` | 订阅，返回取消函数 |

```js
// 发布
ctx.events.publish('todo.changed', { pending: 3 });

// 订阅（handler 收到 { topic, payload, source, at }）
var off = ctx.events.subscribe('timer.finished', function (event) {
  ctx.notifications.info('计时结束', event.payload.label);
});

// 不再需要时主动取消（插件被禁用/卸载时宿主会自动清理，这里只是提前收回）
off();
```

约束与取舍：

- **主题名只能是**小写字母、数字、`.`、`-`、`_`，且必须以字母或数字开头，最长 64 字符。非法主题会被丢弃并记录警告，而不是抛错 —— 发布通常发生在异步回调里，在那里抛错没人接得住。
- **投递是同步的**，按订阅顺序依次调用。异步投递会让「发布」与「处理」之间插入任意其它代码，排查问题时很难把因果对上。
- 某个处理函数抛错会被捕获并记录，**不会中断其余处理函数**，也不会让发布方失败。
- 默认**收不到自己发布的事件**。这是为了打断「发布 → 自己处理 → 再发布同一主题」的回环。确实需要时用宿主内部的 `subscribe` 选项，插件接口不暴露它。
- 插件的订阅会自动归属到插件 ID，因此插件被禁用或卸载时宿主会一次性摘掉它的全部订阅与命令。你不需要自己记住取消订阅，但仍应在不再需要时主动 `off()`。
- 总线上**没有权限隔离**：声明了权限的插件可以订阅任意主题。它带来的是「模块之间可以协作」，不是「模块之间互相隔离」。

## 7. launcher

启动外部程序。**需要 `process-spawn` 权限**，未声明时调用会被拒绝。

这是插件能拿到的最强能力 —— 它运行的是本机上的任意程序，权限等同于你自己的
用户账户。插件详情页会把它标为高风险；安装前请确认你信任该插件的来源。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `launch` | `launch(program, args?) => Promise<void>` | 启动一个程序；`program` 必须是绝对路径 |

```js
// 需要 process-spawn 权限
await ctx.launcher.launch('C:\\Program Files\\App\\app.exe');

// 带参数：作为独立 argv 项传递，不经过 shell
await ctx.launcher.launch('C:\\Program Files\\App\\app.exe', ['--profile', 'work']);
```

约束：

- **`program` 必须是绝对路径**，且指向一个已存在的文件。`cmd`、`powershell`
  这类依赖 `PATH` 解析的程序名会被拒绝。这条限制不阻止插件启动 `cmd.exe`
  （那同样是绝对路径）—— 它的目的是让「要执行什么」在代码里显式可见，
  而不是一道沙箱。
- **参数不经过 shell**：作为独立 argv 项传入，因此不存在引号、`&&`、`|`
  这类注入问题。
- **启动后不等待**：命令在子进程创建后立即返回，宿主不跟踪它的退出状态。
- 失败原因（路径不存在、非绝对路径、未声明权限）以错误抛出。建议展示给用户 ——
  静默失败会让人误以为是路径写错了。

完整可运行示例见插件仓库的 `plugins/quick-launch`（需要原生能力的那一类示例都在那里：
启动程序、提取图标、在文件管理器中定位、接收拖入的文件）。

## 8. icons

提取本机文件的图标。**需要 `filesystem-read` 权限**，未声明时调用会被拒绝。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `extract` | `extract(path) => Promise<string>` | 返回可直接放进 `src` 的 PNG data URL |

```js
const url = await ctx.icons.extract('C:\\Program Files\\App\\app.exe');
img.src = url;
```

约束：

- `path` 必须是绝对路径，且指向一个**已存在的文件**（目录不行）。
- **没有图标资源的文件会失败**（例如 `.txt` 就走这条路径），因此调用方应当准备好回退图标，不要把它当致命错误。
- **目前只在 Windows 上实现**，其他平台返回明确错误，而不是一张占位图。
- 结果是 64×64 的 PNG。取一次约几十 KB，建议**缓存** —— 示例插件把它写进自己的存储，键为 `icon.<条目ID>`。
- 注意存储键的字符集限制：只允许字母数字与 `.` `_` `-`，所以是 `icon.` 前缀而不是 `icon:`。

## 9. shell

与系统文件管理器协作。**需要 `filesystem-read` 权限**。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `revealInFolder` | `revealInFolder(path) => Promise<void>` | 在文件管理器中打开该路径并选中它 |

```js
await ctx.shell.revealInFolder('C:\\Program Files\\App\\app.exe');
```

约束：

- `path` 必须是绝对路径且已存在；**目录也可以**（与 `icons.extract` 不同）。
- 它**只定位，不打开文件本身**，因此没有「借插件之手执行文件」的风险。

## 10. fileDrop

接收拖入窗口的文件路径。**需要 `filesystem-read` 权限**；未声明时 `subscribe` 返回空函数并记录一次警告（与 `notifications` 的降级方式一致）。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `isAvailable` | `isAvailable() => boolean` | 权限已声明且底层监听建立成功 |
| `subscribe` | `subscribe(handler) => () => void` | 订阅拖放事件，返回取消订阅函数 |

```js
const active = Modulith.useModuleActive();
React.useEffect(() => {
  if (!active) return;                       // 见下方「窗口级」说明
  return ctx.fileDrop.subscribe((event) => {
    if (event.type === 'drop') addFromPaths(event.paths);
  });
}, [active]);
```

`event` 形如 `{ type, paths }`：`type` 为 `enter` / `over` / `drop` / `leave`，`paths` 是绝对路径数组（非 `drop` 阶段可能为空）。

**这是窗口级事件。** 无论当前显示哪个模块，只要有文件被拖进窗口就会触发。因此**必须**先用 `Modulith.useModuleActive()` 判断可见性再订阅，否则插件会在后台抢走本该属于其它模块的拖放。

**为什么必须由宿主转发。** Tauri 的 `dragDropEnabled` 默认为 `true` 时会拦截系统拖放，此时 WebView 内的 HTML5 拖放整体不可用；而 `withGlobalTauri` 未开启，插件拿不到 `window.__TAURI__`。两者相加使插件无法自行接收拖入路径 —— 这条通道是宿主代为建立的。

> 同一个原因还带来一项限制：**WebView 内的 HTML5 拖放不可用**。因此「把界面元素拖到另一个元素上」这类交互（例如把卡片拖进分组）需要自己用指针事件实现，不能依赖 `dragstart` / `drop`。

## 11. audio

导入一个音频文件，用于播放自定义提示音之类的场景。**需要 `filesystem-read` 权限**。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `pick` | `pick() => Promise<PickedAudio \| null>` | 弹出原生选择框；用户取消时返回 `null` |

```js
const picked = await ctx.audio.pick();
if (picked) {
  // 直接就能播
  new Audio(picked.dataUrl).play();
  console.log(picked.name, picked.bytes);   // "ding.mp3" 42137
}
```

`PickedAudio` 形如 `{ name, dataUrl, bytes }`。

约束：

- **返回的是成品，不是原料。** 「选择 + 读取 + 编码」在宿主里一步完成，插件拿到的是
  可直接交给 `new Audio(...)` 的 data URL，**接触不到原始字节或路径**。扩展名白名单
  与体积上限因此只有一个执行点，没有绕过的路径 —— 与 `ctx.icons` 同一思路。
- 支持的扩展名：`mp3` / `wav` / `ogg` / `m4a` / `aac` / `flac` / `opus` / `webm`。
  对话框过滤器只是给用户的建议（选择框里仍可切到「所有文件」），**真正的校验按扩展名做**。
- 单个文件上限 **2 MB**。提示音通常只有几十 KB，这个上限是为了不把一个几百 MB 的
  文件读进内存再编码成 base64。
- 用户取消返回 `null`，这与「选了但格式不支持」是两回事：后者会抛错。
- 拿到之后建议存进插件自己的存储，下次启动就不必再让用户选一次。注意 data URL 是
  字符串，**别放进会被频繁重写的状态里** —— 单独存一个键更划算。

> **浏览器自动播放策略。** 音频播放通常需要一次用户手势才能「解锁」。如果提示音是在
> 计时结束时触发、而用户当时并没有点击任何东西，第一次播放可能被拒绝。稳妥做法是在
> 用户点「开始」这类按钮时先建好并 `resume()` 一个 `AudioContext`，
> 之后到点播放就不会被拦（插件仓库的 `plugins/pomodoro` 就是这么做的）。

## 11.1 clipboard —— 需要 `clipboard`

```js
await ctx.clipboard.writeText('要复制的内容');
const text = await ctx.clipboard.readText();
if (!ctx.clipboard.isAvailable()) { /* 未声明权限或环境不支持，走降级 */ }
```

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `isAvailable()` | boolean | 权限已声明**且**环境提供剪贴板接口 |
| `readText()` | `Promise<string>` | 未声明权限时返回空串并记录一次警告 |
| `writeText(text)` | `Promise<void>` | 未声明权限时静默返回；真的失败时抛错 |

### ⚠️ 这一项的强制程度比其它权限弱

**剪贴板是浏览器 API，插件绕过 `ctx.clipboard` 直接调 `navigator.clipboard` 仍然可行。**
因此这一项管住的是「插件按约定走宿主通道」，而**不是**「插件拿不到剪贴板」。

这与 `updater` 的处理不同：那里是宿主自己的命令（`updater:default`），前端不授权就真的
不可达；剪贴板没有这样的开关，在 Rust 侧加门只会制造一种「更难绕过」的假象。

**那为什么还要有它**：调用会被记录、行为统一，而且**忘记声明权限的插件会被降级** ——
权限列表里这一项因此不是空的。需要真正的强隔离，只能等插件挪进独立进程。

### 两条会咬人的行为

**一、`writeText` 会静默替换用户剪贴板里的内容。** 用户可能正打算粘贴别的东西。
它不像通知那样显眼，因此**别在用户没主动触发的时候调用它** ——
一个后台定时器每 5 秒覆盖一次剪贴板，用户只会觉得"电脑坏了"。

**二、读取可能被拒绝，而且那不是缺陷。** 浏览器通常要求页面处于聚焦状态，剪贴板也可能
被别的程序独占。因此：

```js
let text = '';
try {
  text = await ctx.clipboard.readText();
} catch (err) {
  // 别把拒绝当成致命错误 —— 准备好回退路径（让用户手动粘贴、读插件自己的存储）
}
```

写入路径有一个 `document.execCommand('copy')` 的回退，它**必须由用户手势触发**：
在按钮点击里有效，在定时器或后台回调里无效。失败时会抛出说明原因的错误，
而不是无声失败 —— 无声失败会让作者以为是自己传的值不对。

## 12. files —— **沙箱独有**

访问**用户在原生对话框里当场选中**的文件与目录。这是插件第一次能读写用户机器上的真实文件，
因此先把它的边界说清楚：**没有 `files.open(path)` 这样的接口，也不会有。**

| 动作 | 需要什么 | 谁决定 |
| --- | --- | --- |
| 读一批文件 | 用户在多选对话框里选中它们 | 用户 |
| 读一个目录 | 用户在目录对话框里选中它 | 用户 |
| 写一个目录 | 同上，且清单声明 `filesystem-scoped` | 用户 |
| 路径 | 相对路径，锁在授权根之内 | 宿主 |

插件能提供的只有对话框的标题与扩展名过滤器 —— 两者都只影响用户看到什么，不影响用户能选什么。

### 12.1 为什么它只有沙箱侧有

授权的载体是一条带令牌的 URL（`/<令牌>/file/<授权 id>/…`），而令牌只发给沙箱界面。
in-process 插件跑在宿主文档里、没有令牌，因此没有承载"这条授权属于谁"的凭据。
给它一个永远抛错的桩只会让作者以为它本该能用，所以 `Modulith.capabilities` 的差异清单里
**显式列着它**（`scripts/check-sandbox.ts` 第 20 节），而不是悄悄缺失。

### 12.2 授权是会话级的

一条授权绑在 `(插件, 界面)` 上，并且**只活在内存里**：

| 事件 | 结果 |
| --- | --- |
| iframe 被卸载（切标签、重挂载、插件重载） | 该界面的授权全部收回 |
| 插件被停用 / 卸载 | 该插件的授权全部收回 |
| 应用退出 | 全部消失 |

推论：**不要把授权 id 存进 `ctx.storage`。** 下一次打开的界面拿到的是新的 id，
而旧 id 上的每一次调用都会拿到 `403`。想知道"我这次选过哪些"，用 `files.grants()`。

### 12.3 方法

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `isAvailable` | `() => boolean` | 清单里声明了 `filesystem-read` |
| `canWrite` | `() => boolean` | 清单里声明了 `filesystem-scoped` |
| `pick` | `(options?) => Promise<Grant[]>` | 多选文件框。`options` 为 `{ extensions?: string[], filterName?: string }` |
| `pickDirectory` | `(options?) => Promise<Grant \| null>` | 目录框。`options` 为 `{ writable?: boolean, title?: string }` |
| `grants` | `() => Promise<Grant[]>` | 这块界面当前持有的全部授权 |
| `release` | `(grant) => Promise<boolean>` | 主动放开一条 |
| `list` | `(grant, rel?) => Promise<Entry[]>` | 列**目录授权**里的条目 |
| `stat` | `(grant, rel?) => Promise<Entry \| null>` | 元信息；不存在返回 `null` |
| `mkdir` | `(grant, rel) => Promise<void>` | 建目录（含中间层），需要可写 |
| `remove` | `(grant, rel) => Promise<void>` | 删一个文件或一棵树，需要可写，**删不掉授权根** |
| `read` | `(grant, rel?) => Promise<ArrayBuffer>` | 读字节 |
| `readText` | `(grant, rel?) => Promise<string>` | 读文本（UTF-8） |
| `write` | `(grant, rel, data) => Promise<void>` | 写字节；`data` 收 `ArrayBuffer` / 类型化数组 / `Blob` / 字符串 |
| `writeText` | `(grant, rel, text) => Promise<void>` | 写文本（UTF-8） |
| `url` | `(grant, rel?) => string` | 一条**同源**地址，可直接放进 `<img src>` |

`Grant` 形如 `{ grant, kind, label, readable, writable, bytes }`：`kind` 是 `'file'` 或
`'directory'`，`label` 是给人看的文件名/目录名，**`grant` 是唯一可用的句柄** ——
绝对路径不会交给插件。

`Entry` 与 `ctx.dataDir.list()` 的形状完全相同：`{ name, isDir, size, modified }`。

```js
// 让用户挑一批图片，读出元数据，再把结果写进用户指定的目录
const files = await ctx.files.pick({ extensions: ['png', 'jpg', 'jpeg', 'webp'] });

const out = await ctx.files.pickDirectory({ writable: true, title: '选择导出目录' });
if (out) {
  for (const item of files) {
    const bytes = new Uint8Array(await ctx.files.read(item.grant));
    // ...处理 bytes...
    await ctx.files.write(out.grant, `cleaned-${item.label}`, processed);
  }
}
```

### 12.4 预览用户文件要用 `url()`，不要先 `read()`

```js
// 好：引擎自己去取，它知道怎么省内存
img.src = ctx.files.url(grant);

// 差：整份字节先进 JS 堆，再交给引擎 —— 缩略图列表里几十张就是几百 MB
img.src = URL.createObjectURL(new Blob([await ctx.files.read(grant)]));
```

`url()` 返回的是**同源**地址（`modulith-plugin.localhost`），因此不触犯 CSP 的 `img-src 'self'`。

### 12.5 会被拒绝的写法

- **单文件授权上的相对路径。** `files.read(grant, 'other.png')` 会被拒 —— 单文件授权
  没有"旁边"这个概念。多文件请对每一项各读一次。
- **`..`、盘符、UNC、Windows 保留设备名。** 与 `ctx.dataDir` 共用同一份路径校验
  （`data_dir::resolve_labeled`），越界的错误信息会指明是"用户授权的目录"。
- **在只读授权上写。** `writable` 为假的授权，`write` / `mkdir` / `remove` 全部拒绝。
- **删掉授权根。** `files.remove(grant, '')` 被显式拒绝：最坏情况只能是删掉插件自己写进去的东西。
- **往不存在的父目录里写。** 与 `ctx.dataDir.write` 同一条规矩，不会悄悄建目录 ——
  一个拼错的路径变成"它明明成功了、东西在别处"是没法自查的。先 `mkdir`。

### 12.6 落盘是"全有或全无"

`write` 先在同目录写一个临时文件、再改名。中途失败（盘满、被占用、进程被杀）不会在用户
目录里留下一个**半截的成品** —— 而半截的 PNG 在文件管理器里与一张正常的图片长得一模一样。

### 12.7 它与 `ctx.dataDir` 的分工

| | `ctx.dataDir` | `ctx.files` |
| --- | --- | --- |
| 根 | 插件自己的私有目录 | **用户当场选定的**文件或目录 |
| 权限 | `plugin-data` | `filesystem-read` / `filesystem-scoped` |
| 生命周期 | 跟着插件，卸载后仍保留 | 跟着**界面**，关掉即失效 |
| 总量上限 | 单文件 256 MB、总量 1 GiB | 单文件 256 MB，**目录总量不限**（那是用户自己的目录） |
| 路径 | 相对数据根 | 相对授权根 |

最后一行是刻意的：`dataDir` 的边界是"插件在花用户的磁盘"，而 `files` 是用户自己选的目标、
并且能看到文件一个个出现 —— 再套一个宿主发明的配额只会在"用户就是想导 200 张图"时拦住他。

## 13. 完整示例

一个最小可用的插件代码包：

```js
(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[my-plugin] window.Modulith 不存在，宿主未就绪');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;
  var ctx = Modulith.createContext();

  function MyView() {
    var state = React.useState(0);
    var count = state[0];
    var setCount = state[1];

    return h(
      'div',
      { className: 'my-plugin' },
      h('h1', null, '我的插件'),
      h('p', null, '当前计数：' + count),
      h('button', { onClick: function () { setCount(count + 1); } }, '加一')
    );
  }

  Modulith.registerModule({
    id: 'myPluginView',
    name: '我的插件',
    description: '示例视图',
    component: MyView,
  });

  ctx.logger.info('插件加载完成');
})();
```

对应的清单：

```json
{
  "name": "com.example.my-plugin",
  "displayName": "我的插件",
  "version": "1.0.0",
  "description": "示例插件",
  "engines": { "modulith": ">=1.6.0" },
  "main": "dist/index.js"
}
```

## 14. 约束速查

| 约束 | 说明 |
| --- | --- |
| 不使用 `import` | 代码以 `<script>` 注入执行，必须是自执行脚本 |
| 不导入 React | 使用 `Modulith.React`，共用宿主实例 |
| 不修改 `window.Modulith` | 接口未冻结，但覆写只会破坏插件自身 |
| 不调用 ReactDOM | 通过 `registerModule` 交组件，宿主负责挂载 |
| `createContext()` 只在加载期调用 | 在 bundle 顶层获取一次并复用 |
| `registerCommand()` 只在加载期调用 | 命令需要归属到插件，卸载时据此批量摘除 |
| 必须注册至少一个模块 | 否则判定为加载失败 |
| 网络需声明权限 | 外部地址需 `network` 与 `network-external` |
| 通知需声明权限 | `notification`，否则接口是空实现 |
| 跨模块通信需声明权限 | `plugin-communicate` |
| 后台工作要看 `useModuleActive()` | 标签页保活，切走不会卸载，定时器需自行暂停 |
| 插件数据用 `storage` | 不要用 `localStorage` |
| 用户文件只能经 `ctx.files` | 路径不由插件给出，授权随界面关闭失效；**沙箱独有** |

## 15. 相关文档

- 加载流程与隔离边界：[插件系统架构](插件系统架构.md)
- 清单字段：[清单文件参考](清单文件参考.md)
- 可运行的完整示例：[示例插件](示例插件.md)
