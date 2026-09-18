# 快捷启动 —— Modulith 示例插件

把常用程序收在一处，点一下就打开。

这是第二个示例插件。`hello-plugin` 演示「最小可用插件」的全部关键环节，本示例
补上它没碰的一面：**需要宿主提供原生能力的插件怎么写**，以及一个真实插件应有的
完整形态。

> **本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。**
> 宿主框架是 GPL-3.0，但示例目录刻意用 MIT —— 示例的用途就是被复制。
> 依据 [PLUGIN-EXCEPTION.md](../../PLUGIN-EXCEPTION.md)，你自己的插件可以用任意许可
> （含闭源），只要**不复制框架的实现代码**。复制时请替换名称、作者与图标。
> 详见[版权与授权](../../docs/07-法务/版权与授权.md)。

## 功能

| 功能 | 怎么用 |
| --- | --- |
| 添加 | 右上角「添加」，或**把程序文件直接拖进窗口** |
| 分类 | 顶部「+ 分组」新建；右键分组可重命名/删除；右键条目「移入分组」 |
| 视图 | 右上角切换 **网格 / 列表 / 紧凑**，选择会记住 |
| 打开 | **双击**卡片，或右键 →「打开」 |
| 打开所在文件夹 | 右键 →「打开所在文件夹」 |
| 备注 | 右键 →「编辑…」填写；之后**鼠标悬浮**在卡片上即显示 |
| 编辑 | 右键 →「编辑…」（名称、路径、参数、分组、备注） |
| 删除 | 右键 →「删除」 |
| 复制路径 | 右键 →「复制路径」 |

卡片上**没有任何按钮** —— 全部操作走右键菜单，这也是为了界面干净。

图标与分组、视图偏好都存在插件私有存储里，卸载插件时一并清除。

## 申请的三项权限

| 权限 | 用途 | 风险 |
| --- | --- | --- |
| `storage` | 保存条目、分组、视图偏好与图标缓存 | 低 |
| `process-spawn` | 启动你添加的程序 | **高** |
| `filesystem-read` | 提取程序图标、在文件管理器中定位、接收拖入的文件路径 | 中 |

`process-spawn` 让插件能运行本机上的任意程序，权限等同于你自己的用户账户 ——
安装前请确认你信任该插件的来源。这与「安装插件视同运行本机程序」是同一件事的
两种说法。

## 已知限制

**启动参数不支持引号。** 「启动参数」输入框按空格切分，因此带空格的参数没法写。
参数本身是作为独立的 argv 项传给系统的（不经过 shell，因此没有注入问题），
缺的只是输入层的引号解析。

**拖入只接受文件，目录会被忽略。** 判断依据是文件名是否含扩展名 —— 插件拿不到
文件类型，这是唯一可行的粗判。目录会被跳过并给出一条提示。

**卡片不能拖到分组上。** 这是一个被平台限制堵住的交互，值得单独说明：Tauri 的
`dragDropEnabled` 默认为 `true` 时会拦截系统拖放，**此时 WebView 内的 HTML5
拖放整体不可用**（Tauri 文档明确要求关闭它才能启用 HTML5 拖放）。因此
「把卡片拖到分组」需要自己用指针事件实现一遍，本示例没有做，改用右键菜单归类。
文件拖入不受影响 —— 它走的是 Tauri 的窗口级事件，正是本示例用的那条通道。

**图标提取目前只在 Windows 上实现。** 其他平台调用 `ctx.icons.extract()` 会明确
报错（而不是返回占位图），卡片回退为「名称首字母」色块。图标取自文件的图标资源，
因此没有图标资源的文件（例如 `.txt`）会提取失败，同样回退到色块。

## 为什么这个示例没有构建步骤

示例的价值在于可读、可复制。用 esbuild/rollup 打包会让「源码」与「你看到的代码」
之间隔一层配置，读者得先搭一遍工具链才能改一行试试。因此 `index.js` 直接写成宿主
能加载的形式：一个立即执行函数，不使用 `import` / `export`。

代价是不能用 JSX，因此代码里全部是 `React.createElement`（简写为 `h`）。

两条必须遵守的约定（与是否用构建工具无关）：

1. **不要自己 import React。** 宿主与插件必须共用同一份 React 实例，否则 hooks
   会报错。用 `Modulith.React`。
2. **必须在加载期同步调用 `registerModule()`**（即 IIFE 顶层，不能放进异步回调）。
   宿主按「加载结束时是否注册了模块」判断插件是否加载成功。

## 目录结构

```
quick-launch/
├── manifest.json      清单（声明 storage / process-spawn / filesystem-read）
├── icon.svg           图标（SVG 文本会被直接内联渲染）
├── index.js           手写 IIFE，无构建步骤
├── index.css          插件自带样式
└── README.md          会显示在插件详情抽屉里
```

打成 `.lcp` 的方式就是把这个目录压缩成 zip 后改扩展名：

```powershell
Compress-Archive -Path .\quick-launch\* -DestinationPath .\quick-launch.lcp
```

## 实现上值得注意的几点

### 图标单独存，不塞进主状态

图标是几十 KB 的 PNG data URL。若把它们一起放进条目数组，**改个名字也要重写整份
数据**。因此每个条目的图标存在独立的键 `icon.<条目ID>` 下，主状态始终保持很小。

顺带一个容易踩的坑：存储键只允许字母数字与 `.` `_` `-`，所以用 `icon.` 前缀而不是
`icon:` —— 冒号会被后端直接拒绝。

### 弹窗必须自己限制在模块区域内

`position: fixed` 是相对**窗口**定位的。插件写在模块里的弹窗如果直接 `inset: 0`，
就会盖住标题栏与二级标题栏 —— 那些是宿主的外壳，不该被模块内容压住。

宿主的布局是「每个标签一个独立的滚动容器」（这是滚动位置保活的前提），
**那个容器的可见矩形就是模块可见区域**。因此正确做法是：找到最近的可滚动祖先，
实测它的 `getBoundingClientRect()`，再拿它当固定定位弹窗的 `top/left/width/height`：

```js
function findScrollAncestor(node) {
  let el = node && node.parentElement;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}
```

这里刻意**按计算样式判断，而不是 `closest('.lc-tab-panel')`**：插件不该依赖宿主的
内部类名，「最近的可滚动祖先」是通用的 CSS 语义，宿主换布局也不会失效。

实测而不是写死 `76px`（标题栏 40 + 二级标题栏 36）还有一个好处：初始化告警条出现、
侧边栏折叠等情况下内容区的起点会变，实测会自动跟上。

同一个边界也用在右键菜单与备注提示上 —— 根因相同：固定定位不认识模块的边界。

### 拖放只在模块可见时订阅

`ctx.fileDrop` 的事件是**窗口级**的：只要有文件被拖进窗口就会触发，与当前显示哪个
模块无关。因此订阅前必须判断可见性：

```js
const active = Modulith.useModuleActive();
React.useEffect(() => {
  if (!active) return;
  return ctx.fileDrop.subscribe(handle);
}, [active]);
```

少了这一步，插件会在后台抢走本该属于其它模块的拖放。

### 存储格式变更时向前兼容

`normalizeState()` 兼容最早那版把条目数组直接存在 `shortcuts` 下的格式。用户的数据
只有一份，**读的时候容错比写的时候谨慎更重要** —— 读失败就全丢了。

### 错误直接显示给用户

路径不存在、不是绝对路径、没有声明权限、启动失败 —— 这些都由 Rust 侧拒绝并返回
可读文案，本示例把它显示在界面顶部，而不是吞掉。静默失败会让人以为是路径写错了。

## 可用的运行时 API

```js
const ctx = Modulith.createContext();

// 存储（需要 storage）
await ctx.storage.get('key', fallback);
await ctx.storage.set('key', value);
await ctx.storage.delete('key');
await ctx.storage.keys();

// 启动程序（需要 process-spawn）
await ctx.launcher.launch('C:\\path\\app.exe', ['--flag']);

// 图标与文件管理（需要 filesystem-read）
const dataUrl = await ctx.icons.extract('C:\\path\\app.exe');
await ctx.shell.revealInFolder('C:\\path\\app.exe');

// 接收拖入（需要 filesystem-read，且是窗口级事件）
const off = ctx.fileDrop.subscribe((e) => {
  if (e.type === 'drop') console.log(e.paths);
});

// 网络（需要 network）
await ctx.http.get(url);

ctx.logger.info('消息', extra);
```

完整签名见[宿主 API 参考](../../docs/02-开发指南/插件开发/宿主API参考.md)。
