# Modulith Desktop

基于 Tauri 2 的高自由度模块化桌面框架。

Modulith Desktop 的核心主张是：**需要什么功能，就加什么模块**。框架本身只提供外壳、模块生命周期、访问授权与插件运行时，具体能力全部由模块与插件提供。

它要解决的是两件事：一是需求本身装不进单一软件，所以先有容器、再有内容；二是**切换软件会打断注意力** —— 把功能集中到一个外壳里，再让每个标签保留自己的界面状态，就不必反复重建「我刚才做到哪了」。

## 特性

**模块标签页与保活**

模块可以多开，像浏览器标签一样关闭、拖动排序、用 `Ctrl+1..9` 与 `Ctrl+Tab` 切换。切走的标签**不会卸载**：滚动位置、未提交的表单、正在编辑的草稿都留在原处。这正是「防止注意力中断」的实现方式 —— 重建现场比切窗口贵得多。

每个标签只在首次被激活时挂载，因此重启后恢复十个标签不会一次挂载十个模块。标签用独立的滚动容器并以 `visibility` 隐藏，而不是 `display:none`（后者会让浏览器丢掉 scrollTop）。模块可通过 `useModuleActive()` 得知自己是否真的可见，据此暂停后台轮询。

**全局搜索与命令面板**

标题栏正中的搜索框（`Ctrl+K`）同时搜索模块、子模块与宿主动作，支持模糊匹配与最近使用排序。用户不必先想起某个功能在哪个模块里 —— 那本身又是一种切换成本。

**应用内通知**

模块与插件产生的通知会持久化保存，带未读状态，在标题栏铃铛、侧边栏与标签页徽标上显示未读数，重启后仍在。同一条信息反复发生时按 `dedupeKey` 合并计数，不会刷满通知中心。插件通过 `ctx.notifications` 使用它（需声明 `notification` 权限）。

目前**只有应用内通知，没有系统级通知** —— 那需要新增 Tauri 插件依赖，当前版本刻意不引入。

**双扩展体系**

内建模块在编译期登记，适合框架自带能力与需要深度集成前端的核心功能；插件在运行期安装，以 `.lcp` 包分发，用户可自行装卸。两者在界面层走同一条渲染路径，插件模块的表现与内建模块一致。

**构建期代码生成**

模块注册表、图标导入、后端模块声明与命令注册均由脚本从同一份事实推导，因此不存在「新增模块忘记登记」这类遗漏。生成器覆盖前端 `moduleRegistry.ts`、`iconMap.ts` 与后端 `lib.rs`、`modules/mod.rs`。

**访问授权**

访问密钥使用 Argon2id 派生后存储，不保存明文，不内置默认密钥。「记住我」凭据由硬件指纹派生的 AES-256-GCM 密钥加密，换机即失效。配置损坏时回落为「需要授权」，而非放行。附失败次数限制、请求限流、已知设备与登录记录。

**诚实的启动进度**

启动流程分为五个有真实依赖顺序的阶段，进度由各阶段上报的实际完成量按权重折算，不使用定时器模拟推进。未就绪前上限为 99。插件加载失败不阻塞进入应用，而是作为可关闭的告警呈现。

**单一版本来源**

版本号只在 `version.toml` 中维护。运行时版本由后端以编译期常量下发，因此界面显示、插件读到的 `Modulith.version` 与插件兼容性校验基准三者不会分叉。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面运行时 | Tauri 2 |
| 后端 | Rust（edition 2021） |
| 渲染层 | React 19 + TypeScript 5.8 |
| 构建 | Vite 7 |
| 样式 | Tailwind CSS 4 |
| 动画 | framer-motion |
| 包管理 | pnpm |

## 快速开始

前置要求：Node.js 22 或更高、pnpm、Rust 稳定版工具链，以及平台相关的 WebView 与编译工具。详见[环境搭建](docs/02-开发指南/环境搭建.md)。

```bash
pnpm install
pnpm tauri dev
```

打包发布版本：

```bash
pnpm tauri build
```

## 核心概念

**内建模块**由一份 `module.toml` 与其入口组件构成，放在 `src/modules/<name>/` 下。需要后端能力时，在 `src-tauri/src/modules/<id>/` 增加对应的 Rust 模块。

**插件**是一个 zip 容器，含清单 `manifest.json` 与一个自执行代码包。代码包在运行时由宿主注入执行，通过 `window.Modulith.registerModule()` 注册界面，通过 `Modulith.createContext()` 取得绑定的存储、网络、日志、通知与事件服务。

插件与宿主运行在同一个 WebView 中，因此**安装插件视同运行本机程序**。权限声明里真正生效的只有 `network`、`network-external`（网络）与 `notification`、`plugin-communicate`（应用内通知与跨模块通信）四项，其余仅作意图声明。详情见[插件系统架构](docs/02-开发指南/插件开发/插件系统架构.md)第 6 节。

## 文档

完整文档位于 [`docs/`](docs/README.md)。

| 主题 | 入口 |
| --- | --- |
| 整体结构与关键设计 | [架构总览](docs/01-架构/架构总览.md) |
| 从零搭建开发环境 | [环境搭建](docs/02-开发指南/环境搭建.md) |
| 新增内建模块 | [模块开发](docs/02-开发指南/模块开发.md) |
| 编写插件 | [插件开发快速开始](docs/02-开发指南/插件开发/快速开始.md) |
| 后端命令与前端接口 | [后端命令参考](docs/03-参考/后端命令参考.md)、[前端服务 API](docs/03-参考/前端服务API.md) |
| 授权与安全模型 | [认证与安全](docs/04-安全/认证与安全.md) |
| 视觉规范 | [设计规范](docs/05-设计系统/设计规范.md) |
| 已知问题与待办 | [已知问题与技术债](docs/06-项目/已知问题与技术债.md) |
| 版权与插件授权 | [版权与授权](docs/07-法务/版权与授权.md) |

## 项目结构

```
modulith-desktop/
  src/                     前端源码
    components/            通用与布局组件
      Tabs/                模块标签页栏
      Notifications/       浮层提示与通知中心
      Titlebar/            标题栏与全局搜索
    contexts/              跨组件状态（侧边栏、模块运行时）
    hooks/                 复用逻辑（标签、目录、可见性、未读、快捷键）
    services/              业务逻辑与后端调用
    modules/               内建模块
    features/              启动页与解锁页
    generated/             构建期生成，不纳入版本控制
  src-tauri/               后端源码与 Tauri 配置
    src/core/              模块抽象与注册表
    src/modules/           内建后端模块
  scripts/                 构建与维护脚本
  samples/reference/       参考插件：只示范不需要危险权限的核心接口，可直接复制
  docs/                    文档
  version.toml             版本号唯一事实来源
```

完整说明见[项目结构](docs/03-参考/项目结构.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm tauri dev` | 启动完整开发环境 |
| `pnpm tauri build` | 打包应用 |
| `pnpm gen:modules` | 重新生成前端模块注册表 |
| `pnpm check:samples` | 检查示例插件的清单与代码是否一致 |
| `pnpm gen:backend update` | 重新生成后端声明与命令注册 |
| `pnpm gen:backend list` | 查看后端模块与命令 |
| `pnpm ver check` | 校验版本一致性 |
| `pnpm ver bump <类型>` | 升级版本并生成变更日志 |

## 提交前检查

```bash
pnpm ver check
pnpm gen:modules                      # 必须：src/generated 不入库，tsc 依赖它
npx tsc -p tsconfig.json --noEmit
cd src-tauri && cargo test --offline --lib
pnpm check:samples                    # 改了 samples/ 才需要
```

`cargo test` 里有一条检查**示例包是否与源码一致**：它解压那个 `.lcp` 并逐个文件比对，
因此改完插件忘记重新打包会直接失败（这个错我犯过两次，所以现在有测试兜着）。
`pnpm check:samples` 则检查示例插件的清单与代码对不对得上 —— 用了却没声明、
声明了却没用，两种都报。

`src/generated/` 是构建期产物，**不纳入版本控制**（`.gitignore` 已排除）。因此**全新 clone 之后必须先运行一次 `pnpm gen:modules`**，否则 `tsc` 会报 `Cannot find module '../generated/moduleRegistry'` 这类错误。

`pnpm build` 与 `pnpm dev` 会自动执行版本检查、后端生成与模块生成这三步，所以正常构建不需要手动跑。只有直接调用 `tsc` 时才要留意上面这条顺序。

提交规范见[贡献指南](docs/06-项目/贡献指南.md)。

## 命名说明

本项目的标识符在 1.0.0 从 `loopcore` 迁移到 `modulith`，各处的名字与含义如下：

| 位置 | 取值 | 说明 |
| --- | --- | --- |
| 产品显示名 | `Modulith Desktop` | 窗口标题、关于页、启动界面 |
| 简称 | `Modulith` | 空间受限处（侧边栏） |
| npm / Cargo 包名 | `modulith-desktop` | 构建产物，不面向用户 |
| 应用标识符 | `com.rinntheor.modulith` | **决定用户数据目录路径**，不可随意变动。只允许字母数字、连字符与句点 |
| 宿主接口对象 | `window.Modulith` | 插件读取的全局对象 |
| 插件兼容性字段 | `engines.loopcore` | 插件清单的**契约字段**，为兼容既有插件保持不变 |

产品名与展示名来自 `src/config/appInfo.ts` 与 `version.toml`，两者必须与 `tauri.conf.json` 的 `productName` 一致，`pnpm ver check` 会校验。

## 许可证

**框架以 GPL-3.0 发布；插件归插件作者所有，授权方式由作者自行决定。**

| 部分 | 许可证 |
| --- | --- |
| 框架（宿主全部源代码） | GPL-3.0 |
| 你的插件 | 由你决定（MIT、Apache-2.0、专有皆可） |
| `samples/` 示例插件 | MIT |

GPL-3.0 用于防止他人把本框架做成闭源商业产品。但插件不该被这件事牵连 —— 依据 GPL-3.0 第 7 条，本项目附加了**插件例外**：仅通过公开插件接口（`window.Modulith`、`ctx.*` 服务、公开类型与命令）交互的插件，不被视为框架的衍生作品，因此你可以自由选择自己插件的授权方式。

唯一的前提是：**不要复制框架的实现代码**再闭源分发 —— 那部分仍受 GPL-3.0 约束。

- 完整条款：[PLUGIN-EXCEPTION.md](PLUGIN-EXCEPTION.md)
- 中文说明：[版权与授权](docs/07-法务/版权与授权.md)
- 框架许可证全文：[LICENSE](LICENSE)
