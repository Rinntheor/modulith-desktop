# 插件运行时稳定性夹具

```
pnpm check:plugin-runtime
# 等价于
node --import ./scripts/harness/loader.mjs scripts/check-plugin-runtime.ts
```

这套夹具把**真实的** `pluginRuntime` 装进一个 Node 进程，用一组合成插件去撞它的边界。
它回答的是静态阅读与纯逻辑断言都回答不了的问题：**插件代码到底跑没跑**。

## 三个文件

| 文件 | 职责 |
| --- | --- |
| `loader.mjs` / `resolve-hook.mjs` | 给省略扩展名的相对 import 补 `.ts`（Node 能直接跑 TS，但 ESM 要求显式扩展名） |
| `dom-shim.ts` | 最小浏览器环境。**`<script>` 的 textContent 会被真正执行**（`vm.runInThisContext`） |
| `plugin-host.ts` | 桩后端（`list_plugins` / `read_plugin_asset` / `plugin_storage_*` …）与夹具装载 |

夹具插件在 `scripts/fixtures/plugins/<名字>/`，每个是 `manifest.json` + `index.js`。

## 为什么不用 jsdom / vitest

本项目的依赖里没有它们，而夹具的价值恰恰在于能在**没有任何网络与安装动作**的环境里
跑起来。**这个取舍的代价必须说清楚：夹具测的是「运行时在这套垫片上的行为」，不是
「在真实浏览器里的行为」。** 因此垫片只实现被真正用到的那部分 API，并且刻意照抄浏览器
语义 —— 最典型的一处是 `executeScript`：`<script>` 里的异常**不会**从 `appendChild`
抛出，而是走 `window` 的 error 事件，插件运行时正是靠那条路径把"插件坏了"反映到界面上。
语义走样比 API 缺失更危险，因为前者会让人对测试结果产生错误信心。

## 加一个夹具

1. 在 `scripts/fixtures/plugins/` 下新建目录，写 `manifest.json` + `index.js`。
   `manifest.name` 是插件 ID（目录名只给人看）。
2. 夹具里用 `window.__FIXTURE_LOG__` 记录自己的执行（与宿主侧的
   `shim.executedScripts` 互为独立证据，两边都对才说明真的跑了）。
3. 在 `check-plugin-runtime.ts` 里用 `loadCatalog([...])`（只建目录、不执行）或
   `loadAll([...])`（会执行 eager 插件）选它，然后断言。

## 桩后端必须如实拒绝

`plugin_storage_*` 的桩会照 Rust 侧的 `require_permission("storage")` 拒绝没有声明
该权限的插件。**一个比真实宿主更宽松的桩比没有桩更糟** —— 它会让夹具显示"没有权限
也能读写设置"，而那正是真实运行时不成立的事。将来接入出站管控时，这里的网络桩要
照抄的是同一件事：策略。

## 已经覆盖的边界

| 场景 | 断言要点 |
| --- | --- |
| 旧式插件 | 行为与 1.2.0 之前逐字一致 |
| 声明式 + 按需激活 | 目录先到、**代码一行没跑**、打开模块才激活、激活原因正确、幂等 |
| 纯命令插件 | 没有模块也不再判为失败；命令在代码执行前就已可见 |
| 后台服务插件 | 零界面也能加载；清理函数**逆序**执行、单个抛错不牵连其余、只执行一次 |
| 顶层抛错 | 只影响自己；错误信息来自插件自身 |
| 什么都不注册 | 仍被判为失败（这条检查在 1.2.0 换了判据，但要保留抓错能力） |
| 模块 ID 冲突 | 抢占被拒绝，归属不变 |
| 命令声明与卸载 | 卸载后声明仍在（1.2.0 修掉的缺陷） |
| 设置读取时机 | `ctx.settings` 在顶层同步可用；没有 `storage` 权限时标记为不可用 |
| 规模 | 8 个插件里只有 5 个被执行 —— 「装了 N 个」≠「跑 N 段代码」 |

## 还没覆盖的

- **React 渲染。** 断言止于"拿到了组件"，没有真的渲染（那需要 DOM 与 React 的
  渲染器）。模块崩了会不会被错误边界接住，不在这里验。
- **顶层同步死循环。** 它无法被中断（JS 单线程），因此不可能"测过去"，
  只能如实写在文档里。
