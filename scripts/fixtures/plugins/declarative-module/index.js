// 声明式 + 按需激活：条目在清单期就进目录，这段代码只在有人打开该模块时才跑
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('declarative-module:executed');
  window.Modulith.registerModule({
    id: 'port-panel',
    name: '端口面板',
    component: function () { return null; },
  });
})();
