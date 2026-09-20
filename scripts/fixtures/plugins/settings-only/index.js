// 设置值必须在**激活之前**就已读好，因此 ctx.settings 是同步的。
// 这个夹具把读到的值记进日志，好让夹具断言"顶层就能拿到用户改过的值"。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  var ctx = window.Modulith.createContext();
  log.push('settings-only:interval=' + JSON.stringify(ctx.settings.get('interval')));
  log.push('settings-only:available=' + ctx.settings.isAvailable());
})();
