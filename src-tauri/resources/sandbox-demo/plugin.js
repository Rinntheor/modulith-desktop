// resources/sandbox-demo/plugin.js
//
// 宿主内置的演示插件。它**不是一个真插件**，只用一次：证明"一个普通插件代码
// 走沙箱这条链路"是通的 —— 资源从目录里读、入口文档由宿主合成、桥接层给出身份、
// RPC 真的到达宿主。
//
// 它**不是已安装的插件**（只登记在沙箱注册表里，不在 `PluginManager` 里），
// 因此第 4 项检查的是**存储被正确拒绝**（fail-closed），而不是读写成功。
// 存储的正常路径要用一个真插件来验 —— 那属于增量 C。
//
// 它刻意用最朴素的写法（没有框架、没有构建步骤）：如果它跑不起来，问题一定在
// 沙箱这一侧，而不是在打包工具链里。
//
// 它跑在一个**独立的 webview** 里。因此下面这些都不成立（这正是沙箱要的效果）：
//
//   * 读不到宿主的 React 状态、内存里的凭据、任何模块作用域；
//   * 调不动宿主的 120 条命令 —— 它的 webview 不匹配任何 capability；
//   * 不能直接 `fetch('https://…')` —— 文档的 CSP 只留了它自己的来源。
//
// 它做得到的事只有一件：通过 `window.Modulith` 跟宿主说话。

(function () {
  'use strict';

  var M = window.Modulith;

  // 桥接层失败时这里会是 undefined。直接说清楚，而不是抛一个看不懂的
  // "Cannot read properties of undefined"。
  if (!M) {
    document.body.innerHTML =
      '<p class="fail">桥接层没有加载 —— 宿主合成的入口文档里 script 顺序或路径有问题。</p>';
    return;
  }

  var results = [];

  function record(name, ok, detail) {
    results.push({ name: name, ok: ok, detail: detail });
    var line = ok ? '[沙箱演示] 通过  ' + name + '：' + detail
                  : '[沙箱演示] 失败  ' + name + '：' + detail;
    if (ok) {
      M.log.info(line);
    } else {
      M.log.error(line);
    }
    render();
  }

  function render() {
    var rows = results
      .map(function (item) {
        return (
          '<dt>' + escape(item.name) + '</dt>' +
          '<dd class="' + (item.ok ? 'ok' : 'fail') + '">' + escape(item.detail) + '</dd>'
        );
      })
      .join('');

    root.innerHTML =
      '<h1>' + escape(M.plugin.name) + '</h1>' +
      '<p class="id">' + escape(M.plugin.id) + ' · v' + escape(M.plugin.version) + '</p>' +
      '<dl><dt>声明权限</dt><dd>' +
      (M.plugin.permissions.length ? escape(M.plugin.permissions.join('、')) : '（无）') +
      '</dd>' + rows + '</dl>';
  }

  function escape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var root = document.getElementById('modulith-root');
  var PROBE_KEY = 'sandbox.probe';
  var stamp = new Date().toISOString();

  // ---- 1. 身份来自宿主 ------------------------------------------------
  record(
    '身份',
    M.plugin.id === 'com.modulith.sandbox-demo',
    '宿主给出的 id 是 ' + M.plugin.id
  );

  // ---- 2. 权限探测（不依赖任何调用） ----------------------------------
  record(
    '权限可见性',
    M.has('storage') === true && M.has('process-spawn') === false,
    'has("storage")=' + M.has('storage') + '，has("process-spawn")=' + M.has('process-spawn')
  );

  // ---- 3. 资源路径确实通 ----------------------------------------------
  //
  // 这一条已经隐含成立了（本脚本就是通过 `/<id>/asset/plugin.js` 加载并执行到这里
  // 的），但把结论写进日志比"它显然能跑"更可靠 —— 读日志的人不必自己推断。
  record('资源加载', true, 'plugin.js 与 plugin.css 都从插件目录里读出来了');

  // ---- 4. 未安装的插件必须被拒绝（fail-closed）----------------------
  //
  // 这个演示插件**不是已安装的插件** —— 它是宿主内置的夹具，只登记在沙箱注册表里，
  // 不在 `PluginManager` 的注册表里。因此存储必须**被拒绝**。
  //
  // 这一条测的是一个真实的安全性质，不是"把失败说成成功"：
  // 一条沙箱对未知身份"放行、但换个默认目录兜住"才是真正的漏洞形态 ——
  // 它看起来能用，而配额、备份、卸载清理**全都绕过去了**。所以"拒绝"必须被钉住。
  //
  // 存储的**正常路径**（已安装插件读写自己的数据，含权限判定与配额）本项不覆盖 ——
  // 它要用一个真插件来验，见 docs/06-项目/已知问题与技术债.md §7.40。
  M.storage.set(PROBE_KEY, { stamp: stamp }).then(
    function () {
      record(
        'fail-closed',
        false,
        '未安装的插件竟然写成功了 —— 存储路径上少了一道身份检查'
      );
      finish();
    },
    function (error) {
      var message = String(error.message || error);
      var refused = /插件不存在|not found|NotFound/i.test(message);
      record(
        'fail-closed',
        refused,
        refused
          ? '被拒绝了：' + message
          : '被拒绝了，但原因不是身份：' + message
      );
      finish();
    }
  );

  function finish() {
    var passed = results.filter(function (r) {
      return r.ok;
    }).length;
    M.log.info('[沙箱演示] 汇总 ' + passed + '/' + results.length + ' 项通过');
  }
})();
