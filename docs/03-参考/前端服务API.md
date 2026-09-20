# 前端服务 API

`src/services/` 下的模块封装了业务逻辑与后端调用。本文按模块列出公开接口。这些模块不依赖任何 React 组件，可在组件、上下文与工具函数中使用。

## 1. boot

应用初始化。完整时序见[启动流程](../01-架构/启动流程.md)。

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `bootManager` | `BootManager` | 单例，驱动启动流程 |
| `getBootResult()` | `BootResult \| null` | 取得启动结果；未完成时为 `null` |
| `getBootState()` | `BootState` | 取得当前启动状态，用于渲染启动界面 |
| `subscribeBoot(listener)` | `() => void` | 订阅启动状态变化，返回取消订阅函数 |
| `resolveInitialModule()` | `string` | 解析应首次打开的模块 |
| `BootPhase` | 类型 | `'idle' \| 'running' \| 'awaiting-auth' \| 'ready' \| 'failed'` |
| `BootStepStatus` | 类型 | `'pending' \| 'running' \| 'done' \| 'skipped' \| 'failed'` |
| `BootState` | 接口 | 阶段、步骤列表、进度、告警与错误 |
| `BootResult` | 接口 | 启动完成后交给主界面的数据 |
| `BootStepState` | 接口 | 单个步骤的状态、进度与耗时 |

`BootManager` 实例提供 `start()`、`retry()`、`waitForUnlock()`。`start()` 返回缓存的 Promise，因此重复调用不会重复执行初始化，这是为 React StrictMode 下 effect 执行两次而设计的。

## 2. bootProgress

启动进度的纯计算，不依赖 React、Tauri 或浏览器环境。

| 导出 | 签名 |
| --- | --- |
| `computeBootProgress` | `(steps: BootProgressStep[], weights: number[], phase: BootPhase) => number` |
| `BootPhase` | 类型别名，与 `boot` 模块共用 |
| `BootStepStatus` | 类型别名 |
| `BootProgressStep` | 接口：`{ status, unitsDone, unitsTotal }` |

进度按权重折算，未就绪前上限为 99，且单调不回退。

## 3. appSettings

应用设置的读写与订阅。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `AppSettings` | 接口 | 设置结构（含 `theme`、`reduceMotion`、`deferPluginLoading`、`pluginLoadTimeoutMs`、`accent`、`openTabs`、`activeTab`、`tabBarVisible`、`autoCheckUpdates`、`lastUpdateCheckAt`、`networkMode`、`githubProxy`、`fileLoggingEnabled`、`crashLoggingEnabled`） |
| `DEFAULT_APP_SETTINGS` | 常量 | 默认设置，各字段与后端 `settings.rs` 的默认值一致 |
| `MAX_OPEN_TABS` | 常量 | 标签页上限，值为 12，必须与后端 `settings.rs` 的同名常量一致 |
| `loadAppSettings()` | `Promise<AppSettings>` | 从后端载入并缓存 |
| `getCachedSettings()` | `AppSettings` | 同步读取缓存值 |
| `isSettingsLoaded()` | `boolean` | 是否已载入 |
| `saveAppSettings(patch)` | `Promise<AppSettings>` | 局部更新并落盘（乐观更新 + 失败回滚，**无防抖**） |
| `resetAppSettings()` | `Promise<AppSettings>` | 恢复默认设置 |
| `getAppDataDir()` | `Promise<string>` | 取得应用数据目录 |
| `subscribeSettings(listener)` | `() => void` | 订阅变化 |

`saveAppSettings` 接收部分字段而非完整对象，内部与缓存合并后提交。

`normalize()` 对从后端读回的 `openTabs` 会过滤非字符串项、**去重**并截断到 `MAX_OPEN_TABS`。去重是必要的：重复的 ID 会让 React 的 `key` 冲突，表现为其中一个标签永远无法激活。

`normalize()` 对 `networkMode` 会把未知取值回落到 `direct`（后端只认两个取值，透传只会得到一个渲染不出文案的选项），对 `githubProxy` 会去掉首尾空白（一份被手工改过的 `settings.json` 会绕过保存时的校验，而拼接时多一个空格会拼出两个地址）。`fileLoggingEnabled` / `crashLoggingEnabled` 沿用「只有显式写成 `false` 才关闭」的约定。

`networkSettings`（`src/utils/networkSettings.ts`）是这两个网络字段的纯逻辑：取值、校验、预设、以及地址拼接的预览。它的常量是后端 `network.rs` 的镜像，`scripts/check-network.ts` 会直接读那两个 Rust 文件来核对有没有漂移。**真正的改写永远由后端完成**，前端只做即时校验与预览。

## 4. auth

访问授权的调用封装与常量。数据结构与安全机制见[认证与安全](../04-安全/认证与安全.md)。

### 4.1 常量与工具

| 导出 | 说明 |
| --- | --- |
| `MIN_KEY_LENGTH` | 访问密钥最小长度，值为 8 |
| `tokenStore` | 会话令牌的存取封装 |
| `collectDeviceFingerprint()` | 采集设备指纹，返回 `DeviceFingerprint` |
| `describeOutcome(outcome)` | 将结果标识转为可展示的中文描述 |
| `formatDateTime(iso)` | 格式化时间，空值返回占位文本 |
| `formatBlockedUntil(iso)` | 格式化锁定到期时间 |

`tokenStore` 使用 `sessionStorage`，因此关闭应用后会话不保留。这一取舍的残余风险见[认证与安全](../04-安全/认证与安全.md)。

### 4.2 调用函数

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `getAuthStatus()` | `Promise<AuthStatus>` | 查询授权状态（含 `hasRecoveryCode`、`remainingRecoveryCodes`） |
| `verifySession(token)` | `Promise<boolean>` | 校验令牌 |
| `getHardwareFingerprint()` | `Promise<HardwareFingerprint>` | 取得硬件指纹 |
| `setupAccessKey(key)` | `Promise<KeySetupResponse>` | 首次设置密钥，返回值带**一次性**恢复码 |
| `unlock(key, rememberMe?)` | `Promise<AuthResponse>` | 校验密钥并解锁 |
| `tryAutoLogin()` | `Promise<AuthResponse>` | 尝试自动登录 |
| `logout()` | `Promise<void>` | 注销会话 |
| `changeAccessKey(oldKey, newKey)` | `Promise<string>` | 更换密钥 |
| `generateRecoveryCode()` | `Promise<string[]>` | 重新生成**整套**恢复码（需已解锁），返回 3 枚明文；旧码全部立即失效 |
| `verifyRecoveryCode(code)` | `Promise<RecoveryVerification>` | 核验恢复码（**不改状态**），通过后返回 10 分钟有效的一次性令牌 |
| `resetAccessKeyWithRecoveryCode(token, newKey)` | `Promise<KeySetupResponse>` | 用一次性令牌设置新密钥（**不需要会话**）；只作废被用掉的那一枚，`recoveryCodes` 恒为空数组 |
| `setRequireAuth(enabled)` | `Promise<boolean>` | 开关授权要求 |
| `setAutoLogin(enabled)` | `Promise<boolean>` | 开关自动登录 |
| `getSecurityOverview()` | `Promise<SecurityOverview>` | 安全概览 |
| `getKnownDevices()` | `Promise<KnownDevice[]>` | 已知设备 |
| `removeKnownDevice(deviceId)` | `Promise<void>` | 移除设备 |
| `getLoginLogs()` | `Promise<LoginLogEntry[]>` | 登录记录 |
| `clearLoginLogs()` | `Promise<void>` | 清空登录记录 |

大部分函数会自动附带设备指纹与当前令牌，调用方无需手动传递。

`setupAccessKey` 与 `resetAccessKeyWithRecoveryCode` 返回的是 `KeySetupResponse`（比 `AuthResponse` 多一个 `recoveryCodes`）。这些明文字符串**只在这一次返回**，后端只保存其 Argon2id 哈希，因此界面必须在这一步把它们展示给用户。

恢复流程是**两步**的：`verifyRecoveryCode` 只核验恢复码并返回一个 10 分钟有效的一次性令牌，`resetAccessKeyWithRecoveryCode` 再用该令牌设置新密钥。拆分的理由是可用性——合成一步时任何错误都会把提示与聚焦落在第一个输入框，用户会误以为恢复码抄错了。

### 4.3 类型

`SecurityInfo`、`AuthResponse`、`KeySetupResponse`、`RecoveryVerification`、`AuthStatus`、`KnownDevice`、`LoginLogEntry`、`SecurityOverview`、`HardwareFingerprint`、`DeviceFingerprint`。

## 5. authStore

授权的共享状态，供多个组件读取同一份授权信息而不重复请求。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `subscribeAuth(listener)` | `() => void` | 订阅变化 |
| `getCachedAuth()` | `AuthStatus \| null` | 同步读取缓存 |
| `getAuthStatus()` | `Promise<AuthStatus>` | 查询并更新缓存 |
| `refreshAuth()` | `Promise<AuthStatus>` | 强制刷新 |
| `AuthStatus` | 类型 | 从 `auth` 模块重导出 |

## 6. moduleCatalog

模块编目的统一视图，合并内建模块与插件注册的动态模块。详见[前端架构](../01-架构/前端架构.md)第 2 节。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `getCatalogModules()` | `ModuleDescriptor[]` | 合并后的模块列表 |
| `getCatalogFlatMap()` | `Map<string, ModuleDescriptor>` | 含子模块的扁平映射 |
| `registerDynamicModule(module, pluginId)` | `boolean` | 注册插件模块，冲突时返回 `false` |
| `unregisterDynamicModules(pluginId)` | `void` | 撤销某插件的全部模块 |
| `clearDynamicModules()` | `void` | 清空全部动态模块 |
| `getPluginModuleIds(pluginId)` | `string[]` | 某插件注册的模块 ID |
| `isDynamicModule(moduleId)` | `boolean` | 是否来自插件 |
| `getModuleOwner(moduleId)` | `string \| null` | 所属插件 ID |
| `getDynamicModuleCount()` | `number` | 动态模块数量 |
| `subscribeCatalog(listener)` | `() => void` | 订阅编目变化 |
| `getCatalogVersion()` | `number` | 编目版本号，每次变化递增 |
| `isPluginCatalogLoading()` | `boolean` | 插件模块是否仍在后台注册中 |
| `setPluginCatalogLoading(loading)` | `void` | 标记加载状态并通知订阅者 |
| `SubModuleDescriptor` | 类型 | 子模块描述符 |

`getCatalogVersion()` 提供与内容无关的失效信号：模块被**替换**（同名不同实现）时动态模块数量不变，只依赖数量会漏掉更新，因此 `ModuleRenderer` 用它作为 `useMemo` 的依赖。

`isPluginCatalogLoading()` 用于区分「插件还没加载完」与「模块真的不存在」。插件默认后台加载，用户有可能在注册完成前就打开了某个插件模块。

## 7. moduleManager

模块偏好的运行时管理，单例导出。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `initialize()` | `Promise<void>` | 载入偏好并同步编目 |
| `reloadCatalog()` | `void` | 重新读取模块编目 |
| `subscribe(listener)` | `() => void` | 订阅状态变化 |
| `getActiveModules()` | `ModuleDescriptor[]` | 可见且已排序的模块 |
| `getHiddenModules()` | `ModuleDescriptor[]` | 被隐藏的模块 |
| `getPinnedModules()` | `string[]` | 置顶模块 ID |
| `getFavoriteIds()` | `string[]` | 收藏模块 ID |
| `getRecentIds()` | `string[]` | 最近使用模块 ID |
| `getFavoriteModules()` | `ModuleDescriptor[]` | 收藏的模块 |
| `getRecentModules()` | `ModuleDescriptor[]` | 最近使用的模块 |
| `hideModule(id)` | `Promise<void>` | 隐藏模块 |
| `showModule(id)` | `Promise<void>` | 恢复模块 |
| `togglePinModule(id)` | `Promise<void>` | 切换置顶 |
| `moveModuleToIndex(id, index)` | `Promise<void>` | 移动到指定位置 |
| `moveModule(id, direction)` | `Promise<void>` | 上移或下移一位 |
| `toggleFavoriteModule(id, favorite?)` | `Promise<void>` | 切换收藏 |
| `recordModuleOpen(id)` | `Promise<void>` | 记录一次打开 |
| `resetAll()` | `Promise<void>` | 恢复默认偏好 |
| `ModulePreferences` | 接口 | 偏好数据结构 |

方法内部会校验输入（模块存在性、索引范围、方向取值），非法输入被拒绝而不传递给后端。

## 8. pluginRuntime

插件运行时的宿主实现。插件侧的接口见[宿主 API 参考](../02-开发指南/插件开发/宿主API参考.md)。

### 8.1 版本

| 导出 | 说明 |
| --- | --- |
| `MODULITH_VERSION` | 占位初值 `'0.0.0-unknown'`，不是真实版本 |
| `refreshHostVersion()` | 从后端读取权威版本并更新宿主 |
| `getHostVersion()` | 同步取得当前已解析版本 |

`MODULITH_VERSION` 只在后端不可用时被读到，例如纯前端预览。真实版本以 `getHostVersion()` 为准。

### 8.2 状态

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `subscribePlugins(listener)` | `() => void` | 订阅插件状态变化 |
| `getInstalledPlugins()` | `InstalledPlugin[]` | 已安装插件 |
| `getLoadStates()` | `Map<string, PluginLoadState>` | 全部加载状态 |
| `getLoadState(pluginId)` | `PluginLoadState \| undefined` | 单个加载状态 |

### 8.3 操作

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `reloadPluginRuntime(onProgress?, options?)` | `Promise<InstalledPlugin[]>` | 重新加载全部插件；回调报告进度 |
| `loadPluginsInBackground(options?)` | `Promise<PluginLoadSummary>` | 后台加载插件，不阻塞调用方；重入时复用同一次加载 |
| `setPluginEnabled(id, enabled)` | `Promise<void>` | 启用或禁用 |
| `uninstallPlugin(id)` | `Promise<void>` | 卸载 |
| `installPluginFromPackage(path)` | `Promise<InstalledPlugin>` | 从文件安装 |
| `installPluginFromFolder(path)` | `Promise<InstalledPlugin>` | 从目录安装 |
| `installPluginFromUrl(url)` | `Promise<InstalledPlugin>` | 从地址安装 |
| `unloadPlugin(pluginId)` | `void` | 卸载运行时资源与模块 |

`reloadPluginRuntime` 的回调签名为 `(done, total, detail?) => void`，`detail` 为当前处理的插件名。

`options` 支持两个字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `number` | 单个插件的加载超时。超时后该插件被标记为失败并跳过，后续插件继续加载 |
| `listOnly` | `boolean` | 只读取插件清单与注入宿主 API，**不执行任何插件 bundle** |

`listOnly` 供「插件延后加载」使用：启动阶段先知道有哪些插件，真正的执行推迟到应用可用之后。其代价是**插件顶层的同步死循环无法被中断**——JS 单线程没有抢占式调度，`timeoutMs` 只能保证后续插件不被拖累，不能救回已经卡住的主线程。见[已知问题与技术债](../06-项目/已知问题与技术债.md)第 4.4 节。

### 8.4 类型

`PluginStatus`、`InstalledPlugin`、`PluginLoadState`、`PluginLoadSummary`、`PluginManifest`、`PluginAuthor`、`PluginRepository`、`PluginEngines`、`PluginModuleRegistration`、`ModulithHost`。

`InstalledPlugin.engineAdvisory` 是引擎范围不匹配时的提示，**不代表插件不可用**：

```ts
interface EngineAdvisory {
  required: string;  // 插件声明的范围，如 "^1.0.0"
  host: string;      // 当前宿主版本
  message: string;   // 可直接展示的中文说明
}
```

后端在每次 `list_plugins` 时按当前宿主版本重新计算它（不落盘），因此应用升级后提示会自动更新。界面应把它渲染成提示（琥珀色）而不是错误（红色）——插件真的跑不起来时，`getLoadState()` 会单独给出 `status: 'error'` 与原因。详见[插件系统架构](../02-开发指南/插件开发/插件系统架构.md)第 3.1 节。

## 9. theme

主题模式与动效开关。深色模式的实现方式见[设计规范](../05-设计系统/设计规范.md)。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `ThemeMode` | 类型 | `'light' \| 'dark' \| 'system'` |
| `ResolvedTheme` | 类型 | `'light' \| 'dark'` |
| `THEME_STORAGE_KEY` | 常量 | `'modulith.theme'`，首帧缓存用的 localStorage 键 |
| `isThemeMode(value)` | `boolean` | 类型守卫，拒绝非法值 |
| `systemPrefersDark()` | `boolean` | 系统是否偏好深色 |
| `resolveTheme(mode)` | `ResolvedTheme` | 把模式解析为实际主题 |
| `primeThemeFromDocument()` | `void` | 从 index.html 已写入的属性同步内存状态 |
| `watchSystemTheme()` | `() => void` | 监听系统主题变化，返回取消订阅函数 |
| `subscribeTheme(listener)` | `() => void` | 订阅主题变化 |
| `getThemeMode()` / `getResolvedTheme()` | 同步读取 | 当前模式与实际主题 |
| `setThemeMode(mode)` | `void` | 应用主题（不负责持久化） |
| `getReduceMotion()` | `boolean` | **有效**动效状态（下面两个开关的并集），`MotionConfig` 与 CSS 都读它 |
| `setReduceMotion(enabled)` | `void` | 应用「关闭界面动画」（不负责持久化） |
| `getPerformanceMode()` / `setPerformanceMode(enabled)` | | 应用「性能模式」；开启时会连带把有效动效置为已关闭 |

主题有两个来源，职责明确分开：后端 `settings.json` 是权威来源，`localStorage` 只是**首帧缓存**——WebView 在 JS bundle 求值前就会绘制一次，等后端返回再决定配色会看到闪烁。`setThemeMode` 只负责应用，持久化由 `saveAppSettings` 完成，避免出现「设置没写成功但界面已经变了」。

动效有**两个**开关（「关闭界面动画」与「性能模式」），但只有一个有效值：它由 `src/utils/motionPreference.ts` 的 `isMotionReduced(setting, performance)` 合并，结果同时喂给 CSS 类 `.lc-reduce-motion` 与 `MotionConfig`。性能模式包含关闭动画，反向不成立。详见[性能与内存](../02-开发指南/性能与内存.md)第 2 节。

### 9.1 usePerformanceMode

`src/hooks/usePerformanceMode.ts`。当**渲染**需要跟着开关变化时用它（而不是直接读设置）：

| 导出 | 说明 |
| --- | --- |
| `usePerformanceMode()` | 性能模式是否开启 |
| `useReduceMotion()` | 动效是否应当停用（两个开关的并集） |

两者都通过 `subscribeTheme` 订阅，设置一改立即重渲染。典型用法是关掉那些「不受 `reducedMotion` 约束」的持续循环装饰（例如授权界面的粒子背景：framer-motion 只对位置类属性短路，`opacity` 循环会一直跑）。

## 10. accent

主题配色（强调色）。与 `theme` 正交：`theme` 决定明暗，本模块决定色相。配色表见 `src/config/accentTheme.ts`，CSS 消费层见 `src/styles/global/accent.css`。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `ACCENT_STORAGE_KEY` | 常量 | `'modulith.accent'`，首帧缓存用的 localStorage 键 |
| `buildAccentVariables(themeId)` | `Record<string, string>` | 由基色推导出整套 `--accent-*` 变量（纯函数） |
| `subscribeAccent(listener)` | `() => void` | 订阅配色变化 |
| `getAccentId()` | `string` | 当前配色 id |
| `setAccentId(id)` | `void` | 应用配色（不负责持久化） |
| `primeAccentFromDocument()` | `void` | 从 index.html 已写入的变量同步内存状态 |
| `accentVariablesFor(id)` | `Record<string, string>` | `buildAccentVariables` 的别名，供首帧脚本复用 |

`buildAccentVariables` 只接受一个基色，其余档位按 HSL 明度规律推导。推导用的明度表与 Tailwind 官方调色板的构造方式一致，因此各档必然协调。无彩色主题（`gray`）把饱和度归零、浅底改用中性灰，否则会与界面自身的灰阶撞色。

**同步点（重要）。** `index.html` 的内联首帧脚本为了让配色不闪，内联了一份基色表与明度表——它与 `accentTheme.ts` / `accent.ts` 是**两份实现**。改配色表或推导算法时**必须同时改两处**，否则首帧与后续渲染会出现色差。

## 11. logger

前端到后端日志文件的那条通道。在此之前前端的所有错误只有一个出口：WebView 的 devtools 控制台，而 release 版用户打不开它。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `LogLevel` | 类型 | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'` |
| `logMessage(level, message, context?)` | `void` | 写一条日志；`context` 会变成后端日志的 target |
| `reportCrash(message, detail?)` | `void` | 报告一次崩溃，写进崩溃日志 |
| `getLogDir()` | `Promise<string>` | 日志目录 |
| `readLogTail(maxBytes?)` | `Promise<LogTail>` | 读取运行日志尾部（默认 32 KB） |
| `clearLogs()` | `Promise<number>` | 清空全部日志文件 |

三条硬约束：**永不抛错、永不 reject**；**失败一次就永久回落到控制台**（否则失败 → `console.error` → 被全局错误处理器接住 → 再调用这里，形成回环）；**不 await**（调用方是错误处理器与插件代码，不该因为写日志而变成异步）。

调用点：`globalErrorHandlers`、`AppErrorBoundary`、`ModuleRenderer` 的模块边界、`ModuleEmbed` 的内嵌边界、`pluginRuntime` 的 `ctx.logger`、`appUpdater` 与 `pluginMarket` 的汇总失败。详见[日志系统](../02-开发指南/日志系统.md)。

## 12. networkDiagnostics / netControl

网络诊断：把「直连」与「下载源」两条路各实测一遍。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `ProbeTarget` / `ProbeRow` / `ProbeReport` | 接口 | 请求与结果的形状（见[后端命令参考](后端命令参考.md)第 4.3 节） |
| `registryProbeTargets(now?)` | `ProbeTarget[]` | 插件仓库的两条待探测地址 |
| `probeNetwork(targets?)` | `Promise<ProbeReport>` | 执行诊断 |

只负责组织**插件仓库**那两条地址；更新清单那几条由后端从 `tauri.conf.json` 追加。返回的行数通常多于传入的目标数，因为后端会为每条目标补上「经下载源」那一版。

出站管控（`netControl.ts`）是同一条链路的另一半：诊断自己也要受策略约束，因此离线模式下它会逐行显示"离线模式已开启"，而不是笼统的连接失败。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `NetPolicyMode` / `NetLogEntry` | 接口 | 档位描述与一条日志的形状 |
| `loadPolicyModes()` | `Promise<NetPolicyMode[]>` | 三档策略的 label / hint / 是否可用 |
| `loadNetLog(limit?)` | `Promise<NetLogEntry[]>` | 最近的出站记录，最新的在前 |
| `clearNetLog()` / `netLogLength()` | `Promise<void>` / `Promise<number>` | 清空 / 取条数 |
| `OUTCOME_LABELS` | 常量 | 四种结果的显示文案 |
| `describeSource(source)` | `string` | `plugin:com.x` → `插件 com.x` |
| `splitUrl(url)` | `{ host, path, hasQuery }` | **丢掉查询串**（它常带令牌，而日志会被截图） |

**前端不做策略判定，也不手写档位描述。** 判定在 Rust（请求由它发起），档位与原因由 `net_policy_modes` 给出 —— 前端手写一份的后果是某一档后来实现了、界面还标着"未实现"，或者反过来。这与权限注册表是同一个理由：同一份名单的第二份副本必然漂移。

## 13. globalErrorHandlers

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `installGlobalErrorHandlers()` | `() => void` | 安装全局监听，返回卸载函数；重复调用不会重复注册 |

捕获 `window.onerror` 与 `unhandledrejection`。这类错误**不在 React 错误边界的覆盖范围内**：错误边界只捕获渲染、生命周期与构造函数中同步抛出的错误，事件处理器、`setTimeout` 回调与未处理的 Promise 拒绝都会漏掉，而它们恰好是插件最容易踩的地方。

该模块只记录日志、不弹窗——事件处理器里的错误不该让整个应用弹出错误页。它会尝试从堆栈中识别插件来源并在日志中标注。

对应的 React 侧边界是 `src/components/AppErrorBoundary.tsx`（根级），以及 `src/components/ModuleRenderer.tsx` 内的模块级边界。三者的分工见[已知问题与技术债](../06-项目/已知问题与技术债.md)第 4.4 节。

## 14. tabStore

模块标签页的唯一状态来源。「当前显示哪个模块」由它持有，`SidebarContext.activeModule` 读的是它。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `TabState` | 接口 | `{ openTabs, activeTab, mountedTabs }` |
| `initializeTabs(initialModule)` | `void` | 幂等初始化；从设置恢复标签，恢复不出来时用启动模块兜底 |
| `isTabsInitialized()` | `boolean` | 是否已初始化 |
| `getTabState()` | `TabState` | 同步读取 |
| `subscribeTabs(listener)` | `() => void` | 订阅变化 |
| `openTab(id)` | `OpenTabResult` | 打开并激活；返回 `{ ok: false, reason: 'limit' \| 'missing' }` 表示被拒绝 |
| `closeTab(id)` | `void` | 关闭；关闭激活标签时激活右邻，没有右邻则激活左邻 |
| `closeOtherTabs(id)` / `closeTabsToTheRight(id)` / `closeAllTabs()` | `void` | 标签栏右键菜单的三个批量操作 |
| `moveTab(from, to)` | `void` | 拖拽排序 |
| `activateTabAt(index)` | `boolean` | `Ctrl+1..9` 使用（从 0 开始） |
| `activateRelativeTab(offset)` | `void` | `Ctrl+Tab` / `Ctrl+Shift+Tab` 使用 |
| `getFallbackModule()` / `openFallbackTab()` | `string` / `void` | 空态里「打开默认模块」的入口 |
| `resyncTabsFromSettings()` | `void` | 「恢复默认设置」后显式重新同步 |

三条不可违反的约束：**惰性挂载 + 保活**（`mountedTabs` 里的标签切走不卸载）、**插件加载期间不对账**（否则重启会误删全部插件标签）、**不订阅 `subscribeSettings` 自动接管**（乐观更新会形成回路）。理由见 `前端架构` 第 3.2 节。

`openTab` 被拒绝时会自己弹一条提示，调用方无需处理。

## 15. notifications

应用内通知的前端封装。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `HOST_SOURCE` | 常量 | 宿主来源标识，值为 `'host'` |
| `AppNotification` | 接口 | `{ id, title, body, level, source, createdAt, read, dedupeKey, count }` |
| `loadNotifications()` | `Promise<AppNotification[]>` | 从后端读取并缓存 |
| `subscribeNotifications(listener)` | `() => void` | 订阅变化 |
| `getNotifications()` | `AppNotification[]` | 同步读取（新的在前） |
| `getUnreadCount()` | `number` | 未读总数 |
| `getUnreadCountForSource(source)` | `number` | 某个模块的未读数 |
| `getNotificationSummary()` | `{ total, unread }` | 概览 |
| `pushNotification(input)` | `Promise<void>` | 推送；`input` 见下 |
| `notifyHost(title, options?)` | `Promise<void>` | 宿主自身通知的便捷封装（`source` 固定为 `host`） |
| `markNotificationRead(id)` / `markAllNotificationsRead()` | `Promise<void>` | 标记已读 |
| `dismissNotification(id)` / `clearNotifications()` | `Promise<void>` | 移除 / 清空 |

`PushNotificationInput` 字段：`title`、`body?`、`level?`（`info` / `success` / `warning` / `error`）、`category?`（`general` / `app-update`）、`source?`、`dedupeKey?`、`silent?`。

浮层的展示规则由这里决定：`silent` 为真时不弹；**合并键命中已有未读时不弹**（只增加计数），因为模块很容易在重试循环里反复推同一条；其余情况弹一次，时长由级别决定（错误级不自动消失）。后端不可用时推送仍会弹一次浮层，只是这条不会进通知中心。

`category` 在这里被翻译成浮层的 `variant`（见第 16 节）：`app-update` 的浮层**不自动消失**，并带「查看更新」入口。映射写在这一层而不是让调用方自己传变体 —— 类别是持久化在通知里的信息，变体是它的呈现结果，分开传迟早会出现「存的是更新、弹的是普通」。之所以不让 `toast.ts` 直接认识 `NotificationCategory`，是因为 `notifications.ts` 已经 import 了 `toast.ts`，反向依赖会成环。

## 16. toast

不持久化的一次性反馈队列。与 `notifications` 的分工见该文件头的说明。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `MAX_VISIBLE_TOASTS` | 常量 | 同时显示上限，值为 5，超出丢弃最旧的 |
| `ToastVariant` | 类型 | `'default' \| 'update'`。与 `level` 正交：`level` 说有多严重，变体说是不是一件要用户做决定的事 |
| `showToast(input)` | `Toast` | 显示一条 |
| `dismissToast(id)` / `clearToasts()` | `void` | 关闭 / 清空 |
| `getToasts()` / `subscribeToasts(listener)` | `Toast[]` / `() => void` | 读取与订阅 |

时长优先级是 `durationMs` > 变体规则 > 级别默认值。`'update'` 变体的规则是**不自动消失**（0）：这类提示不该在用户看到之前走掉。之所以用变体而不是新增一个 level：level 在后端是严格反序列化的枚举，加值会让旧的通知文件解析失败，而这是一个纯呈现层的需求。

**定时器不在这个服务里，而在 `ToastLayer`**。自动消失需要支持「鼠标悬停时暂停」，那是纯粹的界面行为；服务层只维护「当前该显示哪些」。浮层实现的是「按剩余时间继续」而不是「移开后重新计时」——后者等于没暂停。

## 17. commandRegistry

全局搜索的命令注册表。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `registerCommand(cmd)` / `registerCommands(cmds)` | `void` | 注册（或覆盖） |
| `unregisterCommandsByPrefix(prefix)` | `number` | 按 ID 前缀批量注销，插件卸载时使用 |
| `getRegisteredCommands()` | `Command[]` | 不含模块派生项 |
| `subscribeCommands(listener)` | `() => void` | 订阅注册表变化 |
| `getRecentCommands()` | `Command[]` | 最近使用的命令 |
| `searchCommands(query, limit?)` | `CommandSearchResult[]` | 搜索；空查询返回「最近使用 + 按名称排序的模块」 |
| `runCommand(cmd)` | `Promise<void>` | 执行并记录到最近使用 |
| `scoreMatch(query, candidate)` | `number \| null` | 匹配打分（纯函数，刻意导出以便独立验证） |
| `registerHostCommands(hooks)` | `void` | 注册宿主内置命令，需注入 `onOpenSettings` / `onOpenNotifications` / `onRefreshPlugins` |

`Command` 的 `group` 取 `modules` / `actions` / `settings`，用于分组显示。模块条目由 `deriveModuleCommands()` 在每次搜索时从目录派生，不进入注册表。

**本文件刻意不 import `pluginRuntime`**：插件运行时要反过来 import 它（为了暴露注册命令的宿主 API），若这里也 import 就会形成循环依赖。因此与插件运行时有关的动作由调用方通过 `HostCommandHooks` 注入。

## 18. eventBus

进程内跨模块事件总线。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `publish(topic, payload?, source?)` | `void` | 发布，同步投递 |
| `subscribe(topic, handler, options?)` | `() => void` | 订阅；`options` 为 `{ source?, receiveOwn? }` |
| `unsubscribeBySource(source)` | `number` | 按来源批量注销 |
| `isValidTopic(topic)` | `boolean` | 主题名是否合法 |
| `getSubscriptionCount()` / `getSubscribedTopics()` | `number` / `string[]` | 自检与调试 |

主题名只能是 `^[a-z0-9][a-z0-9._-]*$`，最长 64 字符。默认**收不到自己发布的事件**（`receiveOwn: false`），以打断「发布 → 自己处理 → 再发布」的回环。单个处理函数抛错会被捕获，不影响其余处理函数与发布方。

## 19. searchFocus

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `FOCUS_SEARCH_EVENT` | 常量 | 事件名 `'modulith:focus-search'` |
| `requestSearchFocus()` | `void` | 派发聚焦请求 |

用 DOM 事件而不是状态或 Context：触发方是挂在 `window` 上的全局快捷键（不在 React 树内），接收方是标题栏里的搜索框。让快捷键持有搜索框的 ref 会引入跨组件的命令式耦合。

## 20. lazyLoad

| 导出 | 签名 |
| --- | --- |
| `createLazyComponent(importFn)` | `LazyExoticComponent<T> & { preload: () => Promise<...> }` |

包装 `React.lazy` 并在加载失败时输出错误日志。生成器为每个模块产出该函数的调用。返回对象上的 `preload()` 由启动流程的 `preload` 步骤调用：它先用 `resolveInitialModule()` 确定即将打开的模块，再取其描述符上的 `preload()` 预加载代码分块，以免进入首页时再出现一次加载态。`preload()` 内部带缓存，重复调用不会重复请求。

## 21. 使用建议

**订阅优先于轮询**。需要响应状态变化的组件应使用对应的 `subscribe*` 函数，而不是定时查询。

**区分缓存读取与异步查询**。`getCachedSettings`、`getCachedAuth`、`getTabState`、`getNotifications` 是同步的，返回最近一次的结果；`loadAppSettings`、`getAuthStatus`、`loadNotifications` 才真正访问后端。渲染路径中应使用同步版本，避免每次渲染触发 IPC。

**订阅建立前先同步一次**。`useUnreadCount` / `useModuleList` 这类 Hook 在 effect 里都是「先 `sync()` 再 `subscribe()`」。这不是冗余：事件可能在「首次渲染」与「订阅建立」之间到达，不补这一次同步就会漏掉它。本项目在这个竞态上踩过坑。

**服务层不持有 React 状态**。这些模块使用自己的订阅机制，组件通过 `useEffect`（配 `useState`）或 `useSyncExternalStore` 接入。这样服务层可以脱离 React 被测试。

## 22. 相关文档

- 命令的 Rust 侧定义：[后端命令参考](后端命令参考.md)
- 启动时序：[启动流程](../01-架构/启动流程.md)
- 服务层在整体结构中的位置：[架构总览](../01-架构/架构总览.md)
- 配色的视觉约定：[设计规范](../05-设计系统/设计规范.md)第 2.5 节
- 标签页、通知与搜索的设计取舍：[已知问题与技术债](../06-项目/已知问题与技术债.md)第 7.7 节
