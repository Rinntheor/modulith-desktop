// scripts/harness/loader.mjs
//
// 注册 TS 解析钩子：`node --import ./scripts/harness/loader.mjs <入口>`
//
// 为什么需要它：Node 24 已经能直接执行 `.ts`（类型擦除默认开启，本项目的
// check-*.ts 一直这么跑），但 ESM 的解析规则要求**显式扩展名**，而应用源码里的
// 相对 import 一律省略扩展名（`'../utils/lazyLoad'`）。钩子只补这一件事。
//
// 为什么不用 tsx / esbuild —— 两个理由，缺一不可：
//   1. 它们要通过管道启动子进程。受限环境里这是被禁的（spawn EPERM），
//      而那正是这套夹具最需要能跑起来的地方。
//   2. **根本用不到 JSX 转换。** `generated/moduleRegistry.ts` 里对 `.tsx` 的引用
//      全是动态 import（`lazy(() => import('./../modules/x/X.tsx'))`），
//      只有 React 真正渲染那个懒组件时才会被拉取。而夹具断言的是**宿主行为**
//      （目录、激活状态、收尾、命令绑定），不是渲染结果，因此那条路根本不会被走到。
//
// 零依赖也正好是本项目 check 脚本的既定取向（见插件仓库的「三支零依赖脚本」）。

import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);
