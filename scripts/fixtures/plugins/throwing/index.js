// 顶层抛错。浏览器里这不会从 appendChild 抛出，而是走 window 的 error 事件 ——
// 插件运行时正是靠那条路径把失败反映到界面上的。
throw new Error('fixture: bundle 顶层抛错');
