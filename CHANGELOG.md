# Changelog

本文件由 `pnpm ver bump` 依据 git 提交自动维护。
格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [1.2.0] - 2026-09-20

### Added

- 插件贡献模型：`contributes` 与 `activationEvents` 从「会被解析、没有消费方」变成宿主真正消费，支持模块 / 命令 / 设置 / 右键菜单四类贡献
- 设置 →「插件设置」分页：渲染插件通过清单声明的设置项，零代码贡献
- 外壳右键菜单支持插件贡献的条目
- `ctx.disposables` 与 `Modulith.onDeactivate()`：插件被禁用 / 卸载时的收尾
- `Modulith.capabilities`：宿主能力表，供插件做特性探测
- `ctx.activationEvent`：插件可以知道自己这次是为什么被激活
- `scripts/check-contributions.ts`：贡献模型的 90 项不变量断言，含对真实插件清单的归类回归

### Changed

- 插件加载拆成两趟：先由清单建立完整的界面目录（不执行任何插件代码），再按装载契约执行代码
- 加载成功的判据由「至少注册一个模块」改为「至少贡献一样东西」
- 声明式模块的 SVG 图标改为后台错峰读取，避免「插件数 × 一次 IPC」的启动尖峰

### Fixed

- 「功能性插件」被判为加载失败 —— 只加命令、只做后台监听的插件此前无法存在
- 禁用再启用插件会让命令面板丢掉清单里声明的命令条目

### Documentation

- 按代码事实更新清单文件参考、插件系统架构、已知问题与技术债、插件生态设计

## [1.1.8] - 2026-09-20

### Added

- 插件说明按 Markdown 渲染

### Fixed

- 发行版里毛玻璃开关失效 —— 只在打包后复现
- 修掉 private_interfaces 警告

### Documentation

- 同步文档，并记录本轮改动与一处未处理的注入面

## [1.1.7] - 2026-09-20

### Added

- 毛玻璃开关、通知提示音、备份机制，并修掉一批深色模式与外壳缺陷

### Documentation

- 按代码事实同步文档，并记录本轮改动

## [1.1.6] - 2026-09-19

### Added

- 窗口内分屏、全屏与开机自启动，并修正窗口状态的恢复开关

## [1.1.5] - 2026-09-19

### Changed

- Merge branch 'docs/factual-sync-1.1.4'（按代码事实校正文档）

### Fixed

- 插件命令的授权与路径收口，并校正过时文档

### Documentation

- 按代码事实校正文档，并补上遗漏的联网/日志/性能三篇索引
