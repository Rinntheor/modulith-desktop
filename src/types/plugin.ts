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
//     * `PluginPermission`（权限名，kebab-case）
//     * `PluginNotificationAPI`（`ctx.notifications`）
//     * `PluginEventAPI` / `PluginBusEvent`（`ctx.events`）
//     * `PluginLauncherAPI`（`ctx.launcher`）
//     * `PluginIconAPI`（`ctx.icons`）
//     * `PluginShellAPI`（`ctx.shell`）
//     * `PluginFileDropAPI`（`ctx.fileDrop`）
//
//   【设计草案】—— 尚未实现的长期设想，**照它写会直接失败**：
//     * `PluginContext`（真实的上下文见 `createContext()`，字段是
//       `pluginId / pluginVersion / manifest / version / storage / http /
//       logger / notifications / events / launcher / icons / shell / fileDrop`，
//       与这里列的 commands / views / menus / fs / plugins 完全不同）
//     * `PluginLifecycle` 的各个钩子（`activate` / `deactivate` / `onInstall` …）
//       运行时都不会被调用，宿主也没有调用它们的时机
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
 * 插件权限类型（与 Rust `PluginPermission` 的 kebab-case 序列化保持一致）
 *
 * 注意「声明了」不等于「被强制」。当前真正生效的是七项：
 * `storage` / `network` / `network-external` / `process-spawn` / `filesystem-read`
 * 在后端检查（`filesystem-read` 另有一处前端检查，见 `ctx.fileDrop`），
 * `notification` / `plugin-communicate` 在前端检查。
 * 其余取值会被解析并保留，但不改变任何行为 —— 详见
 * docs/02-开发指南/插件开发/插件系统架构.md 第 6 节。
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
 * 插件沙箱级别
 */
export type SandboxLevel = 0 | 1 | 2 | 3;

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
 * 命令贡献定义
 */
export interface CommandContribution {
  command: string;
  title: string;
  icon?: string;
  category?: string;
  shortcut?: string;
}

/**
 * 视图贡献定义
 */
export interface ViewContribution {
  id: string;
  name: string;
  icon?: string;
  priority?: number;
  component?: string;
}

/**
 * 设置项定义
 */
export interface SettingContribution {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  default?: any;
  description?: string;
  enum?: any[];
  minimum?: number;
  maximum?: number;
}

/**
 * 菜单贡献定义
 */
export interface MenuContribution {
  location: string;
  command: string;
  group?: string;
  when?: string;
}

/**
 * 插件贡献点
 */
export interface PluginContributions {
  commands?: CommandContribution[];
  views?: ViewContribution[];
  settings?: SettingContribution[];
  menus?: MenuContribution[];
  themes?: ThemeContribution[];
  languages?: LanguageContribution[];
}

/**
 * 主题贡献定义
 */
export interface ThemeContribution {
  id: string;
  label: string;
  uiTheme: 'vs-dark' | 'vs-light' | 'hc-black';
  path: string;
}

/**
 * 语言贡献定义
 */
export interface LanguageContribution {
  id: string;
  aliases: string[];
  extensions: string[];
  configuration?: string;
}

/**
 * 激活事件
 */
export type ActivationEvent =
  | 'onStartup'                          // 应用启动时
  | `onCommand:${string}`                // 命令执行时
  | `onView:${string}`                   // 视图打开时
  | `onFile:${string}`                   // 文件类型匹配时
  | `onPlugin:${string}`                 // 依赖插件激活时
  | 'onRestore';                         // 工作区恢复时

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
  permissions?: PluginPermission[];
  sandboxLevel?: SandboxLevel;
  
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
 * 插件视图 API
 */
export interface PluginViewAPI {
  register(view: ViewContribution, component: React.ComponentType): () => void;
  unregister(viewId: string): void;
  focus(viewId: string): void;
}

/**
 * 插件菜单 API
 */
export interface PluginMenuAPI {
  register(menu: MenuContribution): () => void;
  unregister(location: string, command: string): void;
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
