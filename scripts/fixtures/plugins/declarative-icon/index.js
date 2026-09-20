// 声明式 + 按需激活 + SVG 图标文件。
//
// 与 `declarative-module` 的差别只有图标：那个写的是 lucide 名字（`Package`），
// 不需要读盘；这个写的是包内文件路径，因此图标必须由 `read_plugin_asset` 读回来
// 再补进目录 —— 那是一条异步的、会被"目录重建"打断的路径。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('declarative-icon:executed');
  window.Modulith.registerModule({
    id: 'icon-panel',
    name: '图标面板',
    component: function () { return null; },
  });
})();
