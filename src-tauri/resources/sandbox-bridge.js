// resources/sandbox-bridge.js
//
// 沙箱插件的桥接层。**它是宿主的一部分，不是插件的。**
//
// 它由协议处理器直接提供（走 `/<插件 id>/bridge.js`），不来自插件目录 ——
// 插件因此改不了它，也无法抢在它前面执行：入口文档由宿主合成，脚本顺序是
// 桥接层在前、插件入口在后，中间没有第三方能插进来。
//
// 它做三件事：
//
//   1. 把 `ctx.*` 变成对宿主的 RPC（走自定义协议，不是 Tauri 的 IPC）；
//   2. 把插件身份与已声明的权限**同步**交给插件 —— 插件在顶层就能读到，
//      不必先 await 一次；
//   3. 不提供任何别的东西。插件拿不到 DOM 之外的宿主对象、拿不到 require、
//      拿不到原生的 `fetch` 之外的网络能力（那被 CSP 限制在插件自己的来源上）。
//
// 文件里的 `__PLUGIN_*__` 占位符由宿主在**每次响应时**替换（见 sandbox.rs 的
// `bridge_script`）。因此这段脚本虽然是一个静态文件，交给插件的却是带身份的那一份。
//
// 注意上面写的是 `__PLUGIN_*__` 而不是某个具体占位符：`bridge_script` 会断言
// "替换之后一个原始占位符都不剩"，因此**连注释里也不能出现它们**。
// 这里曾经因为注释里原样写了一遍而让那条断言在 debug 构建里直接 panic。
//
// ============================================================
// 关于 fetch
// ============================================================
//
// 这里用的是页面自己的 `fetch`。它受文档的 CSP 约束：
// `connect-src` 只留了插件自己的来源，因此这条 RPC 通得了，而
// `fetch('https://…')` 通不了。**那是引擎执行的**，插件改不掉。

(function () {
  'use strict';

  var PLUGIN_ID = '__PLUGIN_ID__';
  var PLUGIN_NAME = '__PLUGIN_NAME__';
  var PLUGIN_VERSION = '__PLUGIN_VERSION__';
  var PERMISSIONS = __PLUGIN_PERMISSIONS__;

  var RPC_ROOT = '/' + PLUGIN_ID + '/rpc/';

  /**
   * 发一条 RPC。
   *
   * 失败一律抛异常，**并把宿主给的原因原样带出去** —— 宿主那边的错误消息是写给
   * 插件作者看的（配额超限会带上"哪一档、上限多少、已用多少、本次多少"四个数字），
   * 在这一层改写它只会把那些数字弄丢。
   */
  function rpc(method, args) {
    return fetch(RPC_ROOT + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    }).then(
      function (response) {
        // 这条通道上的失败都是应用层的，宿主一律以 200 返回。
        // 真的拿到非 200，说明问题出在通道本身，而不是某次调用。
        if (!response.ok) {
          throw new Error('沙箱通道异常：HTTP ' + response.status);
        }
        return response.json();
      },
      function (error) {
        throw new Error('沙箱通道不可用：' + (error && error.message ? error.message : error));
      }
    ).then(function (payload) {
      if (!payload || payload.ok !== true) {
        throw new Error(
          payload && payload.error ? payload.error : '未知的沙箱调用失败'
        );
      }
      return payload.value;
    });
  }

  function log(level) {
    return function (message) {
      // 记日志**刻意不返回 Promise**：插件不该为了写一行日志去 await。
      // 失败也不抛 —— 日志写不进去不该打断插件自己的逻辑。
      try {
        rpc('log', { level: level, message: String(message) }).catch(function () {});
      } catch (error) {
        /* 忽略 */
      }
    };
  }

  var Modulith = {
    /** 沙箱插件的身份。**宿主给出的**，不是插件自报的。 */
    plugin: {
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      permissions: PERMISSIONS.slice(),
    },

    /**
     * 声明了某个权限没有。
     *
     * 插件应当用它做特性探测，而不是去比较宿主版本 —— 与 `Modulith.capabilities`
     * 的既有约定一致。未声明的能力即使被调用，宿主也会拒绝。
     */
    has: function (permission) {
      return PERMISSIONS.indexOf(permission) !== -1;
    },

    log: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },

    storage: {
      /**
       * 读一个键。不存在时返回 `fallback`。
       *
       * 值以 JSON 存储，因此对象、数组、数字都能原样取回。
       */
      get: function (key, fallback) {
        return rpc('storage.get', { key: key }).then(function (raw) {
          if (raw === null || raw === undefined) return fallback;
          try {
            return JSON.parse(raw);
          } catch (error) {
            return fallback;
          }
        });
      },

      set: function (key, value) {
        return rpc('storage.set', { key: key, value: JSON.stringify(value) });
      },

      delete: function (key) {
        return rpc('storage.delete', { key: key });
      },

      keys: function () {
        return rpc('storage.keys', {}).then(function (value) {
          return value || [];
        });
      },
    },
  };

  Object.defineProperty(window, 'Modulith', {
    value: Modulith,
    writable: false,
    configurable: false,
  });
})();
