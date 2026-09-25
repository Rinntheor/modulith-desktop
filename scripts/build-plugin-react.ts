// scripts/build-plugin-react.ts
//
// 为**沙箱插件**准备一份 React + ReactDOM + JSX 运行时，产物落在
// `src-tauri/resources/react-runtime.js`（由 `sandbox.rs` 用 include_str! 编进二进制，
// 再经插件协议发给插件的入口文档）。
//
//   node scripts/build-plugin-react.ts
//
// ============================================================
// 为什么是"宿主发过去"而不是"插件各打一份"
// ============================================================
//
// 插件仓库的构建脚本把 `react` 与 `react/jsx-runtime` 标成 external，并把它们
// 接到 `globalThis.Modulith.React` 与 `globalThis.Modulith` 上（见那里的
// REACT_SHIM）。那份约定不是随便定的：**同一个文档里只允许有一个 React 实例** ——
// 两个实例互相不认识，context 取不到、hook 调用错乱。
//
// in-process 插件拿的是宿主页面那个实例。沙箱插件是**独立文档**，宿主页面上的
// 东西一个都到不了，因此必须由宿主把自己这一份送过去。这样做的两个后果都是想要的：
//
//   * 插件代码**一行都不用改** —— 它的 `Modulith.React` 依然存在，只是来自桥接层；
//   * 版本仍然只有一处事实来源（本仓库的 package.json），不会出现"某个插件
//     钉着 18、某个钉着 19"这种只在其一里复现的 bug。
//
// ============================================================
// 为什么产物入库
// ============================================================
//
// 与 `sandbox-bridge.js` 同样的理由：它是**宿主的一部分**，必须随源码可审查、
// 可逐字节复现，而不是"谁的机器上构建出来就是什么"。它也进不了任何
// capability（插件协议按 webview 身份鉴权，不看文件从哪来）。
//
// 因此这个脚本的作用是**可复现地重新生成**它，`check:sandbox` 会核对
// 产物里写着的那行版本号与 `package.json` 是否一致 —— 升级 React 却忘了
// 重新生成时，门禁会直接指出该跑哪条命令。

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printTitle, printSuccess, printKeyValue, printError } from './colors.ts';

// ============================================================
// 为什么 esbuild 是从 vite 那里解析来的，而不是自己声明一份
// ============================================================
//
// esbuild 是 **vite 的**依赖，本仓库并没有直接依赖它。再声明一份（哪怕版本号
// 写成同一个）会让磁盘上出现两个 esbuild：Vite 用它的那个，这个脚本用这个。
// 两者一旦漂开，症状是"宿主前端转译用的语法"与"这份运行时用的语法"不同 ——
// 那类问题只在低版本引擎上复现，而这里恰恰是宿主送给插件的代码。
//
// 代价是这个脚本跟着 Vite 的依赖走。失败方式是**明确的**：Vite 哪天换掉 esbuild，
// 这里会以"找不到模块 esbuild"直接报错，而不是静默用一个陈旧版本。
const requireFromVite = createRequire(import.meta.resolve('vite/package.json'));
const esbuild = requireFromVite('esbuild') as typeof import('esbuild');

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(here, '..');
const OUTFILE = join(PROJECT_ROOT, 'src-tauri/resources/react-runtime.js');

// 版本从 `node_modules` 里**实际装到的**那一份读，而不是读 package.json 的范围
// 字符串 —— 后者是 `^19.1.0`，与 `19.2.7` 直接比会永远"不一致"（这里踩过一次）。
// package.json 与装到的版本是否吻合是包管理器的事；这个脚本要记录的是
// **这份产物里到底打进了哪个版本**，`check:sandbox` 再拿它与宿主页面用的是不是
// 同一份来核对。
const reactVersion = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'node_modules/react/package.json'), 'utf8')
).version as string;
const reactDomVersion = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'node_modules/react-dom/package.json'), 'utf8')
).version as string;

if (reactVersion !== reactDomVersion) {
  printError(
    'react 与 react-dom 的版本不一致',
    `react ${reactVersion} / react-dom ${reactDomVersion} —— 两者必须同版本，否则 hooks 会在运行期报错`
  );
  process.exit(1);
}

const entry = `
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as JsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactDomClient from 'react-dom/client';

globalThis.__MODULITH_PLUGIN_REACT__ = {
  version: ${JSON.stringify(reactVersion)},
  reactDomVersion: ${JSON.stringify(reactDomVersion)},
  React: React,
  JsxRuntime: JsxRuntime,
  JsxDevRuntime: JsxDevRuntime,
  ReactDomClient: ReactDomClient,
};
`;

printTitle('Modulith Desktop · Plugin React Runtime');
console.log();

await esbuild.build({
  stdin: { contents: entry, resolveDir: PROJECT_ROOT, loader: 'ts' },
  bundle: true,
  format: 'iife',
  // 与宿主的构建目标一致。写低了会把 React 19 用到的语法转译掉，
  // 让"插件里跑的 React"与"宿主里跑的"变成两份不同的代码。
  target: 'es2021',
  platform: 'browser',
  // **压缩。** 这与"插件产物不压缩"那条规则刻意相反，理由不是双标：
  // 插件产物是**要被人读的**（审核靠人工读代码），而这一份是 React 自己的代码，
  // 没有人会读它 —— 可审查的是**这个脚本**。600 KB 未压缩的库同时进 git 与二进制，
  // 换来的是零收益。
  //
  // legalComments 保留 inline：React 是 MIT，版权声明必须随分发一起走，
  // 而压缩过程最容易顺手把它删掉。
  minify: true,
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `/* 由 scripts/build-plugin-react.ts 生成，请勿手改。
 * react ${reactVersion} / react-dom ${reactDomVersion}
 * 重新生成：node scripts/build-plugin-react.ts
 */`,
  },
  outfile: OUTFILE,
});

const written = readFileSync(OUTFILE, 'utf8');
printKeyValue('产物', OUTFILE.replace(`${PROJECT_ROOT}\\`, ''));
printKeyValue('体积', `${(written.length / 1024).toFixed(1)} KB`);
printKeyValue('React', `${reactVersion} / react-dom ${reactDomVersion}`);
console.log();

// 自检：产物必须真的挂上了那个全局，否则宿主发过去的是一份没用的脚本，
// 而症状是"插件里 Modulith.React 是 undefined"——看起来像桥接层写错了。
for (const marker of [
  'globalThis.__MODULITH_PLUGIN_REACT__',
  reactVersion,
  'createRoot',
]) {
  if (!written.includes(marker)) {
    printError('产物里缺少预期的标记', marker);
    process.exit(1);
  }
}

printSuccess('已生成', `${(written.length / 1024).toFixed(1)} KB`);
