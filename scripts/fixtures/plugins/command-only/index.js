// 1.2.0 解锁的那一类：没有任何模块，只有命令。此前它会被判为加载失败。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('command-only:executed');
  window.Modulith.registerCommand({
    id: 'ping',
    title: '探测一次',
    run: function () { log.push('command-only:ran'); },
  });
})();
