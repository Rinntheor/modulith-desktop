// 声明式 + 按需激活：只有一条右键菜单贡献与它引用的命令。
//
// 这个夹具的关键点是**清单顶层 icon 是 lucide 名（`Package`）**，而且没有任何模块
// 声明 SVG 路径 —— 因此 `panels/menu.svg` 只被右键菜单项引用。图标补全的候选过滤
// 若只看"插件级图标 + 模块图标"，这个插件整条会被滤掉，那张图永远不会被读回来。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('context-menu-icon:executed');
  window.Modulith.registerCommand({
    id: 'run',
    title: '运行一次',
    run: function () { log.push('context-menu-icon:ran'); },
  });
})();
