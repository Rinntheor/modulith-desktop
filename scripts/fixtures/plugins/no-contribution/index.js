// 打包配置写错时的典型样子：bundle 跑起来了，但什么都没注册。
// 这条检查在 1.2.0 被换掉了判据（由"必须注册模块"改为"至少贡献一样东西"），
// 但它仍然要能抓住这个真实的错误。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('no-contribution:executed');
})();
