# 速记本 —— Modulith 示例插件

这是最小的可用插件，用来演示插件系统的全部关键环节：

| 环节 | 位置 |
| --- | --- |
| 清单声明 | `manifest.json` |
| 注册模块 | `dist/index.js` 里的 `Modulith.registerModule(...)` |
| 插件独立存储 | `dist/index.js` 里的 `ctx.storage.get/set` |
| 样式注入 | `manifest.json` 的 `style` → `dist/index.css` |
| 自定义图标 | `manifest.json` 的 `icon: "icon.svg"` |

> **本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。**
>
> 宿主框架是 GPL-3.0，但示例目录刻意用 MIT —— 示例的用途就是被复制，若它是 GPL，
> 每个照它起步的新插件都会从「复制 GPL 代码」开始。依据 [PLUGIN-EXCEPTION.md](../../PLUGIN-EXCEPTION.md)，
> 你自己的插件可以用任意许可（含闭源），只要**不复制框架的实现代码**。
> 复制本示例时请替换其中的名称、作者与图标。详见[版权与授权](../../docs/07-法务/版权与授权.md)。

## 安装方式

任选其一：

1. **从插件包**：插件页 → 安装插件 → 从插件包安装 → 选择 `hello-plugin.lcp`
2. **从目录**（开发时更方便）：插件页 → 安装插件 → 从本地目录安装 → 选择本目录

安装后侧边栏与仪表盘会立刻出现「速记本」。

## 目录结构

```
hello-plugin/
├── manifest.json      清单
├── icon.svg           图标（SVG 文本会被直接内联渲染）
├── dist/
│   ├── index.js       IIFE bundle
│   └── index.css      样式
└── README.md          会显示在插件详情抽屉里
```

打成 `.lcp` 的方式就是把这个目录压缩成 zip 后改扩展名：

```powershell
Compress-Archive -Path .\hello-plugin\* -DestinationPath .\hello-plugin.lcp
```

## 自己写一个插件要注意什么

1. **不要自己 import React**。用 `window.Modulith.React`，或把 `react` / `react-dom` /
   `react/jsx-runtime` 全部设为 external 并映射到 `Modulith.*`。宿主与插件必须是同一份
   React 实例，否则 hooks 会报错。
2. **在加载期间调用 `Modulith.createContext()`**。它会返回绑定到本插件的
   `storage` / `http` / `logger` / `manifest`。在加载期之外调用会抛错。
3. **bundle 必须在顶层同步调用 `registerModule()`**。运行时按「一个插件 → 一个或多个模块」
   注册；如果加载完成后一个模块都没注册，插件会被标记为加载失败。
4. **模块 `id` 不能与内置模块或其它插件冲突**，冲突会被拒绝并打印错误。

## 可用的运行时 API

```js
const ctx = Modulith.createContext();

await ctx.storage.get('key', fallback);   // 读取（JSON 反序列化）
await ctx.storage.set('key', value);      // 写入（JSON 序列化）
await ctx.storage.delete('key');
await ctx.storage.keys();
await ctx.storage.clear();

await ctx.http.get(url);                  // 需要 network 权限
await ctx.http.post(url, data);           // 访问外部域名还需要 network-external

ctx.logger.info('消息', extra);           // 带 [plugin:<id>] 前缀
ctx.manifest;                             // 本插件的清单
```
