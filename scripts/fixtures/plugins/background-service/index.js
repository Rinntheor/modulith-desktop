// 功能型插件的最小形态：有行为、无界面，并且**必须自己登记收尾**。
//
// 三个清理函数刻意安排成能验证三条保证：
//   1. 逆序执行（后登记的先跑）：C → B → A
//   2. 单个抛错不牵连其余：B 故意抛错，A 与 C 仍要跑到
//   3. 每个只执行一次（宿主重复卸载不会重复跑）
//
// 定时器如果不 unref，Node 的事件循环会被它吊住 —— 这里显式说明这一点，
// 因为"宿主不知道插件创建了什么"正是 disposables 要解决的问题。
(function () {
  var log = (window.__FIXTURE_LOG__ = window.__FIXTURE_LOG__ || []);
  log.push('background-service:executed');

  var ctx = window.Modulith.createContext();
  var timer = setInterval(function () {}, 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();

  ctx.disposables.add(function () {
    log.push('dispose:A');
    clearInterval(timer);
  });
  ctx.disposables.add(function () {
    log.push('dispose:B');
    throw new Error('fixture: 清理函数故意抛错（验证它不牵连其余）');
  });
  ctx.disposables.add(function () {
    log.push('dispose:C');
  });
})();
