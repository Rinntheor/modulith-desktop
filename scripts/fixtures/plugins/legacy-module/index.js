// 旧式插件：清单里没有 contributes，行为必须与 1.2.0 之前逐字一致
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('legacy-module:executed');
  window.Modulith.registerModule({
    id: 'legacy-panel',
    name: '旧式面板',
    component: function () { return null; },
  });
})();
