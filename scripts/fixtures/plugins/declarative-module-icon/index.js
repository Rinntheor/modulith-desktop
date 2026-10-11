// 声明式 + 按需激活 + **模块级** icon.svg 路径。
//
// 与 `declarative-icon` 的差别：那个的图标只在清单顶层声明（`icon: "icon.svg"`），
// 所有模块共用那一张；这个的第二个模块自己写了一张图（`panels/own.svg`），
// 于是宿主必须按**模块**读回它自己那张，而不是把插件级图标套给所有模块。
//
// 这一段代码在宿主补图标时一行都不会跑（按需激活），因此能证明图标确实来自
// 清单 + 资源读取，而不是来自 bundle 执行。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('declarative-module-icon:executed');
  window.Modulith.registerModule({
    id: 'own-icon-panel',
    name: '自带图标面板',
    component: function () { return null; },
  });
  window.Modulith.registerModule({
    id: 'brand-panel',
    name: '品牌图标面板',
    component: function () { return null; },
  });
})();
