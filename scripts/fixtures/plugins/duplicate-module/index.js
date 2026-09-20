// 先注册自己声明过的，再去抢 port-panel（属于 fixture.declarative-module）。
// 第二个必须被目录拒绝，且不得改变 port-panel 的归属。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('duplicate-module:executed');
  window.Modulith.registerModule({
    id: 'shadow-panel',
    name: '影子面板',
    component: function () { return null; },
  });
  window.Modulith.registerModule({
    id: 'port-panel',
    name: '劫持',
    component: function () { return null; },
  });
})();
