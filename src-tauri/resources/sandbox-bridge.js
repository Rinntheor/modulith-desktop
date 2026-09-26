// resources/sandbox-bridge.js
//
// 沙箱插件的桥接层。**它是宿主的一部分，不是插件的。**
//
// 它由协议处理器直接提供（走 `/<令牌>/bridge.js`），不来自插件目录 ——
// 插件因此改不了它，也无法抢在它前面执行：入口文档由宿主合成，脚本顺序是
// 桥接层在前、插件入口在后，中间没有第三方能插进来。
//
// 它做三件事：
//
//   1. 把 `ctx.*` 变成对宿主的 RPC（走自定义协议，不是 Tauri 的 IPC）；
//   2. 把插件身份与已声明的权限**同步**交给插件 —— 插件在顶层就能读到，
//      不必先 await 一次；
//   3. 不提供任何别的东西。插件拿不到 require、拿不到宿主的对象、
//      也拿不到一个能绕开宿主的网络出口（CSP 把它限制在插件自己的来源上）。
//
// 文件里的 `__PLUGIN_*__` 占位符由宿主在**每次响应时**替换（见 sandbox.rs 的
// `bridge_script`）。因此这段脚本虽然是一个静态文件，交给插件的却是带身份的那一份。
//
// 注意上面写的是 `__PLUGIN_*__` 而不是某个具体占位符：`bridge_script` 会断言
// "替换之后一个原始占位符都不剩"，因此**连注释里也不能出现它们**。
// 这里曾经因为注释里原样写了一遍而让那条断言在 debug 构建里直接 panic。
//
// ============================================================
// 这一层为什么必须与宿主侧的 ctx 一一对应
// ============================================================
//
// 同一个插件可以在 `runtime: "in-process"` 与 `"sandboxed"` 之间切换，而它的
// 代码不该因此改一行。因此 `Modulith` 暴露的名字必须与宿主侧 `ctx` 的成员完全
// 一致 —— 少一个的表现是插件在沙箱里拿到 `undefined`，而那种错误看起来像
// 插件自己写错了。`check:sandbox` 第 20 节**从两侧的源码各自推导出成员表**
// 再逐个比对，差异清单必须恰好是下面那两条（多一条少一条都会打红）。
//
// 两侧刻意不同的地方，只有一条：
//   * `ctx.manifest` 不存在（宿主只送 id / 名称 / 版本 / 权限 / 界面表，
//     没有送整份清单 —— 见下面的 `Modulith.plugin` 与 `Modulith.surfaces`）。
// 这是**能力差异**，不是"还没做" —— 它写进插件开发文档。
//
// ============================================================
// `ctx.fileDrop` 曾经"补不了"，平台迁移顺手解掉了它
// ============================================================
//
// 它长期记在"沙箱里没有"那一栏，理由是拖放是窗口级事件、子 webview 收不到。
// 核对 wry 之后发现那个理由只对了一半：wry 在 Windows 上把拖放处理器注册在
// **webview 自己的 HWND 及其全部子窗口**上（`wry-0.55.1/src/webview2/drag_drop.rs:50`
// 枚举子窗口并按个 `RegisterDragDrop`）。子 webview 有自己的 HWND，而它**没有**
// 注册处理器 —— 于是落在它上面的文件既不进宿主窗口的处理器，也没有东西接住。
// 那条路径从根上是断的，与权限无关。
//
// 现在插件界面是宿主 webview 里的一个 iframe：指针底下始终是**主 webview 的
// HWND**，处理器照常触发，事件里还带指针位置（物理像素）。于是它变成一件能在
// 前端做出来的事：按位置命中哪一块界面，就 `postMessage`（channel `file-drop`）
// 进去。宿主侧只转给清单里声明了 `filesystem-read` 的界面 —— 判定在
// `sandbox_surface_open` 返回值的那一位上，**不在这一层**。
//
// 与 in-process 的一处**语义差别**（更好的那种）：in-process 的拖放是窗口级的，
// 插件必须自己用 `useModuleActive()` 判断当前可不可见；沙箱里宿主已经按位置筛过，
// 收到就是"拖到了我这一块上"。
//
// `registerModule` 则**两边都有，但含义不同**：in-process 是"向宿主注册一个组件"，
// 沙箱是"把我这个组件挂到本界面上"（插件自己就是界面）。名字与入参形状刻意
// 保持一致，因此同一份插件代码在两侧都能跑。
//
// 另外几个只在沙箱侧出现的成员：`React` / `jsx` / `jsxs` / `jsxDEV` / `Fragment` /
// `createContext`。它们不是宿主能力，而是**宿主把自己那份 React 借给插件**，
// 理由见 `sandbox.rs` 里 `PLUGIN_REACT_JS` 的说明。
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
  var PLUGIN_HOST_VERSION = '__PLUGIN_HOST_VERSION__';
  var PLUGIN_SURFACE = '__PLUGIN_SURFACE__';
  var PLUGIN_RUNTIME = '__PLUGIN_RUNTIME__';
  var ACTIVATION_EVENT = '__PLUGIN_ACTIVATION__';
  var PERMISSIONS = __PLUGIN_PERMISSIONS__;
  var DATA_AVAILABLE = __PLUGIN_DATA_AVAILABLE__;
  var SURFACES = __PLUGIN_SURFACES__;

  // ============================================================
  // 我是谁：从**地址**读，不从插件 id 拼
  // ============================================================
  //
  // 令牌是本界面每一条请求的路径第一段（见 sandbox.rs 文件头的"令牌是身份"）。
  // 它就在 `location.pathname` 里，因此这里不需要宿主再送一个占位符进来 ——
  // 少一个占位符就少一处能漂的约定。
  //
  // **必须用令牌，不能用插件 id。** 协议处理器按令牌查身份，用 id 拼出来的地址
  // 会被它拒掉，而症状是资源与 RPC **一起** 404。
  var TOKEN = (function () {
    var path = String(window.location.pathname || '');
    return path.replace(/^\/+/, '').split('/')[0] || '';
  })();

  var RPC_ROOT = '/' + TOKEN + '/rpc/';
  var DATA_ROOT = '/' + TOKEN + '/data/';

  // ============================================================
  // 守卫：这个文档里**不该**有宿主的 IPC
  // ============================================================
  //
  // 沙箱依赖 Tauri 一侧的两件事：它不给子框架注入 IPC 初始化脚本，且 IPC 处理器
  // 要求一个只注入主框架的随机键。这两件事**都会静默失效** —— 哪一天不成立了，
  // 这里不会报错、不会变慢、没有任何症状，只是插件忽然能 invoke 全部应用命令。
  //
  // 所以这里主动查一次，查到就大声说出来。**它不是一道拦截**（插件也不该靠它），
  // 它是一盏灯：正常运行时什么都不做，边界塌了的时候立刻进日志与自检页。
  //
  // 为什么放在这里而不是等插件来问：插件不一定会问，而这件事不该由插件决定
  // 自己要不要被检查。
  function assertNoHostIpc() {
    var found = [];

    if (typeof window.__TAURI_INTERNALS__ !== 'undefined') found.push('__TAURI_INTERNALS__');
    if (typeof window.__TAURI__ !== 'undefined') found.push('__TAURI__');
    if (typeof window.isTauri !== 'undefined') found.push('isTauri');
    // `window.ipc` 是 Tauri 在 Windows 上的那条原生 IPC 桥，**不受 CSP 管辖** ——
    // 它是"fetch 那条被 connect-src 挡住了"之后还会剩下的那一条路。
    if (typeof window.ipc !== 'undefined') found.push('ipc');

    if (found.length === 0) return true;

    var detail =
      '这个插件文档里出现了宿主 IPC（' + found.join('、') + '）。插件界面本应跑在一个' +
      '拿不到 IPC 的跨源 iframe 里 —— 出现这些名字意味着它不在。';
    console.error('[Modulith] 沙箱边界失效：' + detail);

    // 也交给宿主写进文件日志：控制台在 release 版里看不到，而这一条恰恰是最不该
    // 只留在控制台里的。
    try {
      rpc('log', { level: 'error', message: '沙箱边界失效：' + detail }).catch(function () {});
    } catch (error) {
      /* 上报失败不再抛一次 */
    }

    return false;
  }

  /** 这个文档里有没有宿主 IPC。自检页会读它。 */
  var HOST_IPC_ABSENT = assertNoHostIpc();

  // ============================================================
  // 同一个来源带来的共享存储：封掉
  // ============================================================
  //
  // 全部插件界面共享 `http://modulith-plugin.localhost` 这一个来源，因此
  // `localStorage` / `sessionStorage` / `indexedDB` / `caches` 是**公用**的：
  // 插件 A 写进去的东西插件 B 读得到。插件要持久化就用 `Modulith.storage` 与
  // `Modulith.dataDir` —— 那两条是宿主按插件分开的。
  //
  // **必须用不可重定义的属性。** 插件跑在同一个 realm 里：一个 `configurable: true`
  // 的覆盖它自己 `delete` 一下就没了，那样封了等于没封。
  //
  // 这里选择**抛错**而不是给一个空壳：给空壳的话，插件会以为"写进去了"，
  // 而数据其实哪里都没到 —— 那比一句明确的拒绝难查得多。
  function freezeOriginStorage() {
    var denied = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'];

    denied.forEach(function (name) {
      var present = false;
      try {
        // 有些环境里读一下这个属性本身就会抛（隐私模式、被策略关闭）。
        present = typeof window[name] !== 'undefined';
      } catch (error) {
        present = false;
      }
      if (!present) return;

      try {
        Object.defineProperty(window, name, {
          configurable: false,
          enumerable: true,
          get: function () {
            throw new Error(
              '[Modulith] 沙箱插件不能使用 ' +
                name +
                '：它与其它插件共享同一个来源。要持久化请用 Modulith.storage 或 Modulith.dataDir。'
            );
          },
        });
      } catch (error) {
        // 封不上就说出来 —— 这一条失败的方向是"插件之间能互相看到对方的存储"。
        console.error('[Modulith] 无法封掉 ' + name + '：' + error);
      }
    });

    // `document.cookie` 单独处理：**读**返回空串而不是抛。
    // 读的人多半是某个捆绑进来的库在做特性探测，让它们抛会把一个无关的插件
    // 直接打挂；而返回空串同样不泄露任何东西。**写**必须失败 —— 写才是那条
    // "把数据留给下一个插件"的路。
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: false,
        get: function () {
          return '';
        },
        set: function () {
          throw new Error(
            '[Modulith] 沙箱插件不能写 document.cookie：它与其它插件共享同一个来源。'
          );
        },
      });
    } catch (error) {
      console.error('[Modulith] 无法封掉 document.cookie：' + error);
    }
  }

  freezeOriginStorage();

  function has(permission) {
    return PERMISSIONS.indexOf(permission) !== -1;
  }

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

  // ============================================================
  // 数据目录
  // ============================================================
  //
  // 读写走 `/<id>/data/<相对路径>` 这条**原始字节**通道，不是 RPC：
  // 请求体/响应体就是文件内容，没有 base64、没有中间字符串。
  // 这是文档、图库一类"几百 MB"的插件唯一能用的路径。
  //
  // `rel` 里的 `..`、盘符、保留设备名由宿主侧的 `data_dir::resolve` 拒绝，
  // 而不是在这里过滤 —— 边界只有一处实现，才不会两处漂开。

  function dataUrl(rel) {
    // 逐段编码，**不编码斜杠**：整个相对路径编码成一段会让宿主的路径解析
    // 收到一个 `%2F` 而认不出目录层级。
    var segments = String(rel === undefined || rel === null ? '' : rel)
      .split('/')
      .filter(function (segment) {
        return segment.length > 0;
      })
      .map(encodeURIComponent);
    return DATA_ROOT + segments.join('/');
  }

  /**
   * 把插件给的东西变成可以放进请求体的字节。
   *
   * 接受 `ArrayBuffer` / 类型化数组 / `Blob` / 字符串。字符串按 **UTF-8** 编码
   * （`TextEncoder`），而不是 `fetch` 默认的 latin-1 —— 中文写进去变成乱码
   * 是一类很难自查的问题，因为它在 ASCII 上完全正常。
   */
  function toBody(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    throw new Error('ctx.dataDir.write 需要字符串、ArrayBuffer、类型化数组或 Blob');
  }

  function dataRequest(rel, init) {
    return fetch(dataUrl(rel), init).then(
      function (response) {
        if (!response.ok) {
          // 404 是"这个文件不在"，其余是宿主拒绝（路径越界、配额、数据根不可用）。
          // 两者都抛，但**消息不同** —— 插件据此能分辨"该建这个文件"与"该提示用户"。
          if (response.status === 404) {
            throw new Error('文件不存在：' + rel);
          }
          return response.text().then(function (message) {
            throw new Error(message || '数据通道失败：HTTP ' + response.status);
          });
        }
        return response;
      },
      function (error) {
        throw new Error('数据通道不可用：' + (error && error.message ? error.message : error));
      }
    );
  }

  var dataDir = {
    /**
     * 数据根目录当前是否可用。**异步**，与 in-process 同名同形。
     *
     * 这里曾经是一个**同步的布尔值**（宿主在建这个文档时注入的快照）。那是个
     * 形状差异：in-process 的写法是 `await ctx.dataDir.available()`，而沙箱里
     * `ctx.dataDir.available` 是个布尔 —— 前者会抛 "not a function"，
     * 后者在 in-process 里永远为真（函数对象恒真）。两边都错，只是错法不同。
     *
     * 快照仍然有用：它说"不可用"时不必往返一趟问宿主 —— 而"不可用"是常见状态
     * （数据目录还没配置）。要那句话给用户看的理由，用 `status()`（沙箱侧多出来的，
     * 宿主没有；插件不该依赖它）。
     */
    available: function () {
      if (!DATA_AVAILABLE) return Promise.resolve(false);
      return rpc('data.available', {}).then(function (state) {
        return !!(state && state.available);
      });
    },

    /**
     * 问一次宿主的**当前**状态：`{available, configured, path, reason}`。
     *
     * 与上面那个布尔值的分工：不可用时 `reason` 是给用户看的一句话
     * （"数据目录不存在" / "未配置" / "不可写"），插件据此能告诉用户该做什么，
     * 而不是只报一句"用不了"。
     */
    status: function () {
      return rpc('data.available', {});
    },

    /** 列一个目录。`rel` 省略表示数据根。 */
    list: function (rel) {
      return rpc('data.list', { rel: rel === undefined ? '' : rel });
    },

    /** 取元信息。不存在时返回 `null`（不是错误）。 */
    stat: function (rel) {
      return rpc('data.stat', { rel: rel });
    },

    /** 读成 `ArrayBuffer`。 */
    read: function (rel) {
      return dataRequest(rel, { method: 'GET' }).then(function (response) {
        return response.arrayBuffer();
      });
    },

    /** 读成文本（按 UTF-8）。 */
    readText: function (rel) {
      return dataRequest(rel, { method: 'GET' }).then(function (response) {
        return response.text();
      });
    },

    /** 覆盖写入。内容原样进请求体，不经过 base64。 */
    write: function (rel, data) {
      return dataRequest(rel, {
        method: 'PUT',
        body: toBody(data),
        headers: { 'Content-Type': 'application/octet-stream' },
      }).then(function () {});
    },

    /** 覆盖写入一段文本（UTF-8）。 */
    writeText: function (rel, text) {
      return dataDir.write(rel, String(text));
    },

    /** 建目录（含中间层）。 */
    mkdir: function (rel) {
      return rpc('data.mkdir', { rel: rel });
    },

    /** 删除文件或整棵目录树。 */
    remove: function (rel) {
      return rpc('data.remove', { rel: rel });
    },

    /** 这个插件的数据目录当前占了多少字节。 */
    used: function () {
      return rpc('data.used', {});
    },

    /**
     * 读成 base64 字符串。
     *
     * 只在小内容上用它（把图片塞进 CSS 的 `url()`、塞进一个 JSON 字段）。
     * 大文件用 `read()` —— 这一条会多出 33% 体积与一次完整字符串。
     */
    readBase64: function (rel) {
      return rpc('data.read', { rel: rel });
    },

    /** 从 base64 字符串写入。同样只建议小内容。 */
    writeBase64: function (rel, base64) {
      return rpc('data.write', { rel: rel, content: String(base64) });
    },
  };

  // ============================================================
  // 剪贴板
  // ============================================================
  //
  // 用页面自己的 `navigator.clipboard`。这不是"绕开宿主"——它就是浏览器 API，
  // 插件本来就能直接调它；宿主在这里提供的价值是**统一的形状与权限提示**，
  // 而不是一道能真正挡住谁的门。权限表里这一项标的是 `frontend` 强制，
  // 与 Rust 侧一致（见 permissions.rs 与 pluginRuntime.ts 的说明）。
  //
  // `http://<名字>.localhost` 被浏览器当作**可信来源**，因此不需要 https 就能
  // 用剪贴板 API —— 这是这条自定义协议能承载完整插件界面的一部分原因。

  // ============================================================
  // 剪贴板（`ctx.clipboard`）
  // ============================================================
  //
  // **方法名必须与 in-process 一致**：宿主是 `{ isAvailable, readText, writeText }`，
  // 这里曾经叫 `{ read, write }`。同一类错误在这次迁移里出现三次（还有
  // `ctx.notifications` 与 `ctx.events`），根因都是早先的核对只比**成员名**。
  var clipboard = (function () {
    var allowed = has('clipboard');

    var warned = false;
    function warnOnce() {
      if (warned) return;
      warned = true;
      console.warn(
        '[Modulith] 插件调用了剪贴板，但清单里没有声明 "clipboard" 权限，调用被拒绝（后续同类调用不再重复提示）'
      );
    }

    function guard() {
      if (allowed) return true;
      warnOnce();
      return false;
    }

    return {
      /** 权限是否已声明（插件据此自行降级，而不必看控制台）。 */
      isAvailable: function () {
        return allowed;
      },

      /**
       * 读剪贴板文本。
       *
       * **可能失败，而且失败不是缺陷**：浏览器要求页面处于聚焦状态、也可能要求
       * 用户手势，剪贴板还可能被别的程序独占。调用方应当准备好回退路径。
       */
      readText: function () {
        if (!guard()) return Promise.reject(new Error('这个插件没有声明 clipboard 权限'));
        return navigator.clipboard.readText();
      },

      writeText: function (text) {
        if (!guard()) return Promise.reject(new Error('这个插件没有声明 clipboard 权限'));
        return navigator.clipboard.writeText(String(text));
      },
    };
  })();

  // ============================================================
  // 清理登记
  // ============================================================
  //
  // 纯 JS，不经过宿主：它登记的是**这个文档里**的资源（定时器、监听器、
  // 观察者），而文档被销毁时它们本来就随之消失。宿主那一侧的 `disposables`
  // 是为"卸载插件但页面还活着"（in-process）准备的。

  var disposables = (function () {
    var list = [];

    function runOne(fn) {
      try {
        fn();
      } catch (error) {
        // 一个清理函数抛错不该让其余的清理不执行 —— 那会把一次小错误
        // 放大成"后面那些资源全都泄漏了"。
        console.error('[Modulith] 清理函数执行出错:', error);
      }
    }

    return {
      add: function (dispose) {
        if (typeof dispose !== 'function') {
          throw new Error('ctx.disposables.add 需要一个函数');
        }
        list.push(dispose);
        return dispose;
      },
      size: function () {
        return list.length;
      },
      /** 执行并清空。宿主在页面销毁前会调一次（见 pagehide 的接线）。 */
      flush: function () {
        var pending = list;
        list = [];
        pending.forEach(runOne);
        return pending.length;
      },
    };
  })();

  // 页面消失时把清理函数跑掉。**这不是可选的整洁**：沙箱界面在切换标签时是
  // `hide` 而不是销毁，但驻留淘汰与关闭会真的销毁它 —— 而那时如果插件的
  // 定时器还在跑，它会在一个已经不可见的文档里继续消耗 CPU。
  window.addEventListener('pagehide', function () {
    disposables.flush();
  });

  // ============================================================
  // 跨插件事件
  // ============================================================
  //
  // 发送走 RPC（宿主再广播给后台插件与其余界面）；接收走宿主推过来的一段脚本。
  //
  // **宿主推给每一个还活着的界面，由这里过滤**。原因见 SandboxSurfaces::live：
  // 登记订阅需要多一整套会漂的状态（注册 / 注销 / 界面销毁时清理），而活着的
  // 界面数量受驻留上限约束，推一圈的代价是有界的。

  var eventHandlers = Object.create(null);

  /**
   * 宿主推来一条事件时调用的入口。
   *
   * 名字以双下划线 modulith 开头是刻意的：插件一眼能看出这是宿主的东西，
   * 而不是它自己的某个全局。宿主调用它之前会先判它存不存在（见 rpc.rs）。
   */
  window.__modulithDeliver = function (envelope) {
    if (!envelope || typeof envelope.name !== 'string') return;

    var list = eventHandlers[envelope.name];
    if (!list || list.length === 0) return;

    // 复制一份再遍历：处理器里取消订阅会让原数组在遍历中变短，
    // 于是后面几个处理器被静默跳过 —— 而那看起来像"订阅偶尔不生效"。
    list.slice().forEach(function (handler) {
      try {
        handler(envelope.payload, envelope.source);
      } catch (error) {
        console.error('[Modulith] 事件处理器抛错（' + envelope.name + '）:', error);
      }
    });
  };

  // ============================================================
  // 跨插件事件（`ctx.events`）
  // ============================================================
  //
  // **形状必须与 in-process 的 `ctx.events` 逐字一致**：那边是
  // `{ publish, subscribe, isAvailable }`。这里曾经叫 `{ emit, on }` —— 名字都在
  // 另一个集合里，于是 `kanban` 调 `ctx.events.publish(...)` 直接 TypeError、
  // 界面白屏。
  //
  // 这正是"只比成员名"这类核对查不出的错误：`ctx.events` **在**，只是它上面挂的
  // 方法名是另一套。见 `staging/audit-plugin-methods.cjs`。
  var events = (function () {
    var allowed = has('plugin-communicate');

    var warned = false;
    function warnOnce() {
      if (warned) return;
      warned = true;
      console.warn(
        '[Modulith] 插件调用了跨模块通信，但清单里没有声明 "plugin-communicate" 权限，调用被忽略（后续同类调用不再重复提示）'
      );
    }

    return {
      /** 发一条跨插件事件。需要 `plugin-communicate` 权限。 */
      publish: function (topic, payload) {
        if (!allowed) {
          warnOnce();
          return;
        }
        return rpc('events.emit', { name: String(topic), payload: payload });
      },

      /**
       * 订阅一条跨插件事件。返回取消订阅的函数。
       *
       * 处理器收到 `(payload, source)` —— **来源是宿主给的**，不是发送方自报的：
       * 一个插件不该能冒充另一个插件发事件。
       */
      subscribe: function (topic, handler) {
        if (!allowed) {
          warnOnce();
          return function () {};
        }
        if (typeof handler !== 'function') {
          throw new Error('ctx.events.subscribe 需要一个函数');
        }

        var key = String(topic);
        if (!eventHandlers[key]) eventHandlers[key] = [];
        eventHandlers[key].push(handler);

        return function () {
          var list = eventHandlers[key] || [];
          eventHandlers[key] = list.filter(function (item) {
            return item !== handler;
          });
        };
      },

      /** 权限是否已声明（插件据此自行降级，而不必看控制台）。 */
      isAvailable: function () {
        return allowed;
      },
    };
  })();

  // ============================================================
  // 主题
  // ============================================================
  //
  // 令牌已经在**入口文档**里注入了（宿主合成的那一段 style 元素），因此插件的
  // CSS 直接 var(--accent-500) 就行 —— 与宿主同名、同值。
  //
  // 这里给的是**用 JS 拿颜色**的那条路：画到 canvas、算对比度、生成 SVG。
  // 没有它的话那些插件只能自己读 getComputedStyle，还要自己订阅主题变化再读一次。

  var themeState = __PLUGIN_THEME__;
  var themeHandlers = [];

  /** 宿主换主题时调用的入口（见 sandbox.rs 的 apply_theme）。 */
  window.__modulithThemeChanged = function (next) {
    themeState = next || themeState;

    // 复制一份再遍历：处理器里取消订阅会让原数组在遍历中变短。
    themeHandlers.slice().forEach(function (handler) {
      try {
        handler(themeState);
      } catch (error) {
        console.error('[Modulith] 主题变化处理器抛错:', error);
      }
    });
  };

  var theme = {
    /** 当前主题：resolved / reduceMotion / glass / tokens */
    current: function () {
      return themeState;
    },

    /** 问宿主再取一次。正常情况下不必用 —— 变化会被主动推过来。 */
    tokens: function () {
      return rpc('theme.tokens', {}).then(function (value) {
        themeState = value || themeState;
        return themeState;
      });
    },

    /**
     * 主题变化时被调用。返回取消订阅的函数。
     *
     * 它**同步先调一次**：插件多半想先把当前的画一遍，而异步的首调会让第一帧
     * 是空的（或者要插件自己写一段重复的初始化）。
     */
    onChange: function (handler) {
      if (typeof handler !== 'function') {
        throw new Error('ctx.theme.onChange 需要一个函数');
      }
      themeHandlers.push(handler);
      try {
        handler(themeState);
      } catch (error) {
        console.error('[Modulith] 主题变化处理器抛错:', error);
      }

      return function () {
        themeHandlers = themeHandlers.filter(function (item) {
          return item !== handler;
        });
      };
    },
  };

  // ============================================================
  // 快捷键
  // ============================================================
  //
  // ============================================================
  // 这一段解决的是"焦点在插件里时宿主快捷键全都不响应"
  // ============================================================
  //
  // 键盘焦点一旦落进这个 webview，keydown 就只在**本文档**里派发 ——
  // 宿主窗口上的监听器什么都收不到。因此用户在插件界面里按 Ctrl+K（全局搜索）、
  // Ctrl+W（关闭标签）、Ctrl+Tab（切标签）会**一点反应都没有**。
  //
  // 这件事无法在宿主那一侧补救，必须是这里接住并转回去。
  //
  // ============================================================
  // 为什么挂在**冒泡**阶段而不是捕获阶段
  // ============================================================
  //
  // 冒泡到 window 时，插件自己在元素上注册的处理器**已经跑过了**。
  // 如果它调了 `preventDefault()`，我们就不转发 —— 一个编辑类插件需要能用
  // Ctrl+B 加粗，而宿主不该把它抢走。
  //
  // 挂在捕获阶段的话宿主永远赢，而那个方向是不可协商的。

  var shortcutTable = __PLUGIN_SHORTCUTS__;

  /** 把一次 keydown 规范化成与宿主一致的组合键写法 */
  function normalizeCombo(event) {
    var parts = [];

    // `mod` 在 Windows / Linux 上是 Ctrl，在 macOS 上是 Cmd。宿主用的是同一个
    // 名字，因此这里**不**自己判断平台 —— 那是宿主规范化规则的职责，
    // 两份实现一定会漂，而漂开的表现是"某些组合在插件里按了没反应"。
    if (event.ctrlKey || event.metaKey) parts.push('mod');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    var key = String(event.key || '').toLowerCase();
    if (!key) return null;

    // 只按修饰键本身不算一次组合（Ctrl 单独按下不该触发任何东西）
    if (key === 'control' || key === 'meta' || key === 'shift' || key === 'alt') return null;

    // 空格键的 `key` 是一个空格字符，而宿主那边写的是 `space`
    if (key === ' ') key = 'space';

    parts.push(key);
    return parts.join('+');
  }

  function findShortcut(normalized) {
    var entries = (shortcutTable && shortcutTable.entries) || [];
    for (var index = 0; index < entries.length; index += 1) {
      // 取**第一个**匹配项，与宿主的"按注册顺序取第一个"一致 ——
      // 两边取的不是同一条时，表现是"按了之后执行的是另一个动作"。
      if (entries[index].normalized === normalized) return entries[index];
    }
    return null;
  }

  function onKeyDown(event) {
    // 插件自己处理过了：这是它的快捷键，不是宿主的。
    if (event.defaultPrevented) return;

    var normalized = normalizeCombo(event);
    if (!normalized) return;

    var shortcut = findShortcut(normalized);
    if (!shortcut) return;

    // 输入框里的规则由**宿主**那条记录说了算（`allowInInput`）。
    // 在这里自己判断"正在打字就不转发"是错的：宿主有几条快捷键
    // （Ctrl+K）是刻意在输入框里也生效的。
    if (isTypingTarget(event.target) && !shortcut.allowInInput) return;

    // 拦掉默认行为再转发。不拦的话引擎可能同时执行它自己的处理
    // （例如某些组合上的滚动、查找）。
    event.preventDefault();

    rpc('shortcut.trigger', { normalized: normalized }).catch(function (error) {
      // 转发失败**只记日志**：宿主那边拒绝说明这个组合已经不是快捷键了
      // （表刚变过），而那不是插件能补救的事。
      console.warn('[Modulith] 转发快捷键失败:', error);
    });
  }

  /** 与宿主 `isTypingTarget` 同义：焦点在输入框 / 可编辑区域里 */
  function isTypingTarget(target) {
    if (!target || !target.tagName) return false;
    var tag = String(target.tagName).toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return target.isContentEditable === true;
  }

  var shortcuts = {
    /** 宿主当前的快捷键表（`{ entries: [...] }`） */
    current: function () {
      return shortcutTable;
    },

    /** 问宿主再取一次表。正常情况下不必用 —— 变化会被主动推过来。 */
    refresh: function () {
      return rpc('shortcuts.list', {}).then(function (value) {
        shortcutTable = value || shortcutTable;
        return shortcutTable;
      });
    },

    /**
     * 某个组合是不是被宿主占用了。
     *
     * 插件**应当**用它来避免把自己的快捷键绑到同一个组合上 —— 绑了的话它的
     * 处理器永远收不到，因为事件在到达它之前就被这里转发走了。
     */
    isTaken: function (combo) {
      return findShortcut(String(combo)) !== null;
    },
  };

  var shortcutsInstalled = false;

  /** 装上监听。宿主推来新表时会重新调一次（幂等）。 */
  function installShortcutListener() {
    if (shortcutsInstalled) return;
    shortcutsInstalled = true;
    window.addEventListener('keydown', onKeyDown, false);
  }

  installShortcutListener();

  /** 宿主换了快捷键表时调用的入口（见 sandbox.rs 的 apply_shortcuts）。 */
  window.__modulithShortcutsChanged = function (next) {
    shortcutTable = next || shortcutTable;
    installShortcutListener();
  };

  // ============================================================
  // 宿主渲染的浮层
  // ============================================================
  //
  // 这两条**会阻塞到用户做出选择**（宿主的等待上限是 5 分钟），插件那边就是
  // 一次普通的 await。
  //
  // 为什么不能自己画：这个文档跑在一个原生子 webview 里，宿主页面里的浮层会被
  // 它盖住 —— 那是两套渲染层的顺序问题，z-index 解决不了。而让插件自己在这里
  // 画一个"像宿主的"对话框，等于让它**冒充宿主界面**。

  var ui = {
    /**
     * 一个**由宿主渲染**的对话框。
     *
     * 返回 `{ confirmed, selected, dismissed }`：
     *   · `confirmed` —— 用户点了确定；
     *   · `dismissed` —— 用户直接关掉了（点了别处 / Esc）。它与"点了取消"
     *     不同：取消是一个明确的回答，而这个是**没回答**。
     *
     * 选项 `{ tone, title, message, confirmLabel, cancelLabel }`，
     * 其中 tone 取 info / question / warning / error。
     * 不给 cancelLabel 时只有一个确定按钮。
     */
    dialog: function (options) {
      var options0 = options || {};
      return rpc('ui.dialog', {
        tone: options0.tone === undefined ? 'info' : options0.tone,
        title: options0.title,
        message: options0.message === undefined ? '' : options0.message,
        confirmLabel: options0.confirmLabel === undefined ? '确定' : options0.confirmLabel,
        cancelLabel: options0.cancelLabel === undefined ? null : options0.cancelLabel,
      });
    },

    /**
     * 宿主渲染的右键菜单。
     *
     * items 是 `[{ id, label, accelerator?, separator?, disabled? }]`，
     * 返回 `{ selected, dismissed }` —— selected 是被选中项的 id。
     *
     * **由宿主渲染**的理由与 dialog 一样，另外还有一条：宿主自己的右键菜单
     * 也走这个窗口，因此插件贡献的菜单项与宿主的菜单**长成同一个样子**。
     *
     * `includeDeclared` 缺省为 **true**：清单里 `contributes.contextMenus` 声明的
     * 条目会被自动并进来（排在临时条目之后，中间一条分隔线）。选中它们时宿主走的是
     * 插件的**命令机制** —— 也就是这里 `commands.on(菜单的 command, handler)`
     * 注册的那个处理器。
     *
     * 关掉它（`includeDeclared: false`）只在你**确切知道**这一次不需要清单条目时用；
     * 不传的话默认行为对绝大多数场景都是对的。
     */
    contextMenu: function (options) {
      var options0 = options || {};
      return rpc('ui.contextMenu', {
        title: options0.title === undefined ? null : options0.title,
        items: options0.items || [],
        includeDeclared: options0.includeDeclared === undefined ? true : !!options0.includeDeclared,
      });
    },

    // ============================================================
    // 多界面（api: 3）
    // ============================================================
    //
    // 一个界面就是一个 webview。这三条是**请求**，不是直接的窗口操作：
    //
    //   openSurface  → 宿主广播 → 前端开一个标签 → 前端量矩形 → 建 webview
    //
    // 之所以绕这一圈：只有前端知道界面该放在哪（标签栏多高、侧边栏是否展开、
    // 分屏开没开）。宿主在这一侧建就只能自己猜一个矩形，而猜出来的界面会漂在
    // 某个不对的地方。**位置由宿主决定，插件只说要哪一个界面。**

    /**
     * 打开自己声明的某个界面。
     *
     * `id` 必须是清单里 `contributes.surfaces` 声明过的。返回时界面**还没有**
     * 建好 —— 这是一次请求，不是一次等待。要确认它开着，用 `listSurfaces()`。
     *
     * `options.bounds` 目前只是**建议**，宿主以自己量出来的为准。
     */
    openSurface: function (id, options) {
      return rpc('ui.openSurface', { id: String(id) });
    },

    /** 关闭自己开着的某个界面。没开着时静默成功。 */
    closeSurface: function (id) {
      return rpc('ui.closeSurface', { id: String(id) });
    },

    /**
     * 自己声明的全部界面，以及**哪些开着**。
     *
     * 每一项：`{ id, name, primary, open, current }`。
     *   · `open` —— 宿主那一侧确认已经建出来了；
     *   · `current` —— 发起这次调用的就是它（后台插件拿到的全是 false，
     *     因为它没有界面）。
     *
     * 值来自宿主而不是本页的猜测：本页只知道自己在哪一块 webview 里，
     * 不知道别的界面开没开。
     */
    listSurfaces: function () {
      return rpc('ui.listSurfaces', {}).then(function (value) {
        return value || [];
      });
    },

    // ============================================================
    // 宿主渲染的状态指示（徽标 / 进度 / 启动占位）
    // ============================================================
    //
    // 这三样**只能由宿主画**：徽标与进度在宿主的侧边栏 / 标签栏上，插件的文档
    // 碰不到；而启动占位要覆盖插件那一块**位置**，原生 webview 盖在宿主 DOM 之上
    // —— 宿主想在那里画东西，就得先把 webview 收起来（那件事由前端做，插件看不到）。

    /**
     * 侧边栏 / 标签栏上的徽标。`badge(null)` 清掉。
     *
     * `{ text, tone }`，tone 取 info / success / warning / error（缺省 info）。
     * 文本超过 28 个字符会被宿主截断 —— 再长它会把模块名挤掉。
     */
    badge: function (value) {
      if (value === null || value === undefined) {
        return rpc('ui.badge', { text: null });
      }
      var value0 = typeof value === 'string' ? { text: value } : value;
      return rpc('ui.badge', {
        text: value0.text === undefined ? null : String(value0.text),
        tone: value0.tone === undefined ? null : String(value0.tone),
      });
    },

    /**
     * 进度指示。`progress(null)` 清掉。
     *
     *   progress({ value: 0.4, label: '索引中' })  → 定量
     *   progress({ label: '索引中' })              → 不定量（转圈）
     *   progress(null)                             → 清掉
     *
     * `value` 必须落在 0..1，否则宿主会拒绝这一次调用 —— 一个写着 40（当成百分比）
     * 的值会让进度条永远停在满格，而那种错误看起来像"进度算错了"。
     */
    progress: function (value) {
      if (value === null || value === undefined) {
        return rpc('ui.progress', { value: null, label: null });
      }
      var value0 = value || {};
      return rpc('ui.progress', {
        value: value0.value === undefined ? null : value0.value,
        label: value0.label === undefined ? null : String(value0.label),
      });
    },

    /**
     * 覆盖插件界面那一块位置的**启动占位**。`splash(null)` 清掉。
     *
     * ============================================================
     * 默认行为是对的，这一点值得说清楚
     * ============================================================
     *
     * 宿主打开一块界面时会立刻把那块位置让给一块"正在启动"的占位，并把插件的
     * webview 先收起来。占位什么时候撤？
     *
     *   * 插件从没调过 `splash()` → 文档加载完之后由桥接层自动撤掉（见下面的
     *     `load` 监听）。不这样的话，一个从不调它的插件会让占位**永远留在屏幕
     *     上**，而用户看到的是"这个插件打不开"；
     *   * 插件调过 `splash(...)` → 它接管了，只有它能撤（`splash(null)`）。
     *     这样"我正在索引十万条笔记"那块提示不会在文档加载完的一瞬间消失，
     *     而那时插件其实还在忙。
     *
     * 一段很长的启动过程因此可以写成：
     *
     *   Modulith.ui.splash({ text: '正在索引…', progress: 0.1 });
     *   await index();
     *   Modulith.ui.splash(null);
     */
    splash: function (value) {
      splashClaimed = true;
      if (value === null || value === undefined) {
        return rpc('ui.splash', { text: null, auto: false });
      }
      var value0 = typeof value === 'string' ? { text: value } : value;
      return rpc('ui.splash', {
        text: value0.text === undefined ? null : String(value0.text),
        tone: value0.tone === undefined ? null : String(value0.tone),
        progress: value0.progress === undefined ? null : value0.progress,
        auto: false,
      });
    },
  };

  // ============================================================
  // 文档加载完之后自动撤掉启动占位
  // ============================================================
  //
  // `load` 在**全部**经典脚本执行完之后才触发，因此走到这里意味着插件的入口
  // 已经跑完了同步那一段。这正是"该把占位让开了"的时刻。
  //
  // 只在插件**没有接管**时撤（`splashClaimed`）：接管了的话那块占位说的是
  // "我还在忙"，而它与文档加载完没有关系。
  var splashClaimed = false;

  window.addEventListener('load', function () {
    if (splashClaimed) return;
    rpc('ui.splash', { text: null, auto: true }).catch(function () {
      /* 撤不掉占位不该让插件的逻辑出错；前端那边还有超时兜底 */
    });
  });

  // ============================================================
  // 下载进度
  // ============================================================
  //
  // 进度不可能走 RPC 的返回值（那是"发出去、拿到结果"），因此宿主把它推过来 ——
  // 与主题、快捷键、命令同一条通道。
  //
  // 回调**按目标路径**存放：一个插件可以同时下好几个文件，而宿主的每一次推送都
  // 带着 `rel`。
  //
  // **不在这里"下载结束后删掉"**：最后一次进度是宿主从另一个任务推过来的，它可能
  // 比 RPC 的返回值晚到一点点 —— 那时删掉处理器就等于吞掉"100%"那一帧，而界面会
  // 永远停在 96%。留着的代价是"每个下载过的路径一个闭包"，那是有界的；下一个下载
  // 同一个路径时它会被覆盖。

  var downloadHandlers = Object.create(null);

  window.__modulithDownloadProgress = function (payload) {
    if (!payload || typeof payload.rel !== 'string') return;

    var handler = downloadHandlers[payload.rel];
    if (typeof handler !== 'function') return;

    try {
      handler({
        rel: payload.rel,
        received: payload.received,
        total: payload.total === undefined ? null : payload.total,
      });
    } catch (error) {
      console.error('[Modulith] 下载进度回调抛错（' + payload.rel + '）:', error);
    }
  };

  // ============================================================
  // 命令
  // ============================================================
  //
  // ============================================================
  // 为什么沙箱里的命令是**事件驱动**的，而不是交出函数
  // ============================================================
  //
  // 宿主那一侧的 `Modulith.registerCommand({ id, run })` 交出去的是一个**函数**，
  // 因为 in-process 插件与宿主在同一个 realm 里。沙箱插件不在 —— 函数的引用过
  // 一次 realm 边界就消失了。
  //
  // 因此在这里，命令的形态只能是"宿主告诉我有这么一条命令被触发了"，由插件
  // 在这里注册的处理器决定做什么。宿主那边也因此没有别的选择：它执行沙箱插件的
  // 命令时走的是"推一段脚本进来"，见 `sandbox.rs::deliver_command`。
  //
  // 少了处理器的命令被**静默忽略**。这是刻意的：沙箱插件的命令可以在它还没加载完
  // 时就被点（命令面板里那条条目从读清单时起就存在），那时没有处理器是正常状态。

  var commandHandlers = Object.create(null);

  /**
   * 宿主推来一条命令时调用的入口。
   *
   * 名字以双下划线 modulith 开头是刻意的：插件一眼能看出这是宿主的东西。
   */
  window.__modulithCommand = function (payload) {
    if (!payload || typeof payload.command !== 'string') return;

    var handler = commandHandlers[payload.command];
    if (typeof handler !== 'function') return;

    try {
      var outcome = handler();
      // 处理器返回 Promise 时**不 await**：这条通道的调用方（宿主）不会为它
      // 等待，而吞掉一个 rejection 会在控制台留下一条无人处理的错误。
      if (outcome && typeof outcome.catch === 'function') {
        outcome.catch(function (error) {
          console.error('[Modulith] 命令处理器抛错（' + payload.command + '）:', error);
        });
      }
    } catch (error) {
      console.error('[Modulith] 命令处理器抛错（' + payload.command + '）:', error);
    }
  };

  var commands = {
    /**
     * 注册一条命令的处理器。返回取消注册的函数。
     *
     * `id` 必须是清单里 `contributes.commands[].id` **或**
     * `contributes.contextMenus[].command` 里出现过的那个本地 id ——
     * 宿主只会在那两种时刻把命令推进来。
     */
    on: function (id, handler) {
      if (typeof handler !== 'function') {
        throw new Error('ctx.commands.on 需要一个函数');
      }
      var key = String(id);
      commandHandlers[key] = handler;

      return function () {
        if (commandHandlers[key] === handler) delete commandHandlers[key];
      };
    },

    /** 这条命令有没有注册处理器（用于自检与"我这块界面负不负责它"的判断）。 */
    has: function (id) {
      return typeof commandHandlers[String(id)] === 'function';
    },
  };

  // ============================================================
  // 对外的那一个对象
  // ============================================================


    // ============================================================
    // 结构化数据：每插件一个 SQLite 文件
    // ============================================================
    //
    // ============================================================
    // 为什么需要第三层
    // ============================================================
    //
    // `storage` 是一个小键值表，`dataDir` 是一个有界的文件目录 —— 它们装得下
    // 笔记正文与图片，但装不下**查询**：一个笔记插件要"按标签筛、按更新时间排、
    // 取第 3 页"时，前两层能做的只有把所有数据拉进 JS 自己过滤，而那正是
    // "一千条以后就开始卡"的来源。
    //
    // ============================================================
    // 边界在引擎里，这一层看不到它
    // ============================================================
    //
    // `ATTACH`、危险的 PRAGMA、`load_extension` 全部由宿主侧的 SQLite authorizer
    // 拒绝（见 `db.rs` 的文件头）。这里**不做**任何 SQL 文本过滤 —— 做了也只是
    // 一套会漂的规则，而文本过滤本来就挡不住注释、大小写与字符串字面量。

    /**
     * 值能不能跨 IPC。
     *
     * `BigInt` 明确不支持：宿主收的是 JSON，没有 int64 那种类型，而悄悄截断
     * 会让一个 id 变成另一个 id —— 那种错误要到很后面才会被发现。
     */
    function dbValue(value) {
      if (value === undefined) return null;
      if (typeof value === 'bigint') {
        throw new Error('ctx.db 不支持 BigInt，请先转成字符串或 Number');
      }
      return value;
    }

    /** 参数一律折成数组；`undefined` → `null`（宿主侧两者是同一件事）。 */
    function dbParams(params) {
      if (params === undefined || params === null) return [];
      var list = Array.isArray(params) ? params : [params];
      return list.map(dbValue);
    }

    /**
     * 把 `{columns, rows}` 拼成一组对象。
     *
     * 宿主**刻意**返回列与行分开的形状（见 `db.rs::QueryResult`）：SQL 允许重名
     * 列，而一个对象在那种情况下只能保留一个 —— 插件拿到的是一个悄悄少了东西的
     * 结果。绝大多数查询没有重名列，因此这一层替它们拼好；拼不了的用 `queryRaw`。
     *
     * 重名列时**后者覆盖前者**，并且**只警告一次** —— 那种查询本来就该改写成带
     * 别名的，而每次调用都刷一条日志会把真正的问题淹掉。
     */
    var duplicateColumnWarned = false;

    function rowsToObjects(result) {
      var columns = (result && result.columns) || [];
      var rows = (result && result.rows) || [];

      var seen = Object.create(null);
      var duplicated = false;
      for (var i = 0; i < columns.length; i += 1) {
        if (seen[columns[i]]) duplicated = true;
        seen[columns[i]] = true;
      }
      if (duplicated && !duplicateColumnWarned) {
        duplicateColumnWarned = true;
        console.warn(
          '[Modulith] 这次查询里有重名列 —— 对象形式只保留最后一个。' +
            '需要全部取值请用 ctx.db.queryRaw()，或给列起别名。'
        );
      }

      return rows.map(function (row) {
        var object = {};
        for (var index = 0; index < columns.length; index += 1) {
          object[columns[index]] = row[index];
        }
        return object;
      });
    }

    var db = {
      /**
       * 查询。返回**对象数组**（重名列只保留最后一个，需要全部用 `queryRaw`）。
       *
       * 参数用 `?1` / `?2` 占位，按数组顺序绑定 —— 不要自己拼字符串：那既是
       * 注入面，也会让语句无法被 SQLite 的语句缓存复用。
       */
      query: function (sql, params) {
        return rpc('db.query', { sql: String(sql), params: dbParams(params) }).then(rowsToObjects);
      },

      /**
       * 查询，返回**原始形状** `{ columns: [...], rows: [[...]] }`。
       *
       * 重名列、或者你只是想要数组时用它。
       */
      queryRaw: function (sql, params) {
        return rpc('db.query', { sql: String(sql), params: dbParams(params) });
      },

      /**
       * 执行一条写入 / DDL。返回 `{ changes, lastInsertRowId }`。
       *
       * **一次调用只能有一条语句**（多条会被宿主拒绝）。要一起成功或一起失败，
       * 用 `transaction`。
       */
      exec: function (sql, params) {
        return rpc('db.exec', { sql: String(sql), params: dbParams(params) });
      },

      /**
       * 一批语句，**全成功或全回滚**。
       *
       *   await Modulith.db.transaction([
       *     { sql: 'INSERT INTO notes (title) VALUES (?1)', params: ['一'] },
       *     { sql: 'INSERT INTO notes (title) VALUES (?1)', params: ['二'] },
       *   ]);
       *
       * 返回每条语句的 `{ changes, lastInsertRowId }`。
       *
       * ============================================================
       * 为什么没有 `begin()` / `commit()`
       * ============================================================
       *
       * 跨调用的显式事务是**会泄漏的状态**：插件在 `begin` 之后崩溃、被卸载、
       * 或者只是忘了 `commit`，那条写事务就一直挂着，而这个连接会被下一个打开
       * 数据库的实例继续用 —— 于是"我什么都没干，它却说数据库被锁住了"。
       *
       * 更要命的是没有 `finally`：插件那一侧拿不到一个"无论发生什么都会执行"的
       * 钩子（它的界面可能只是被隐藏，也可能整个文档已经被销毁）。因此事务的
       * 边界必须落在**这一次**调用里。
       */
      transaction: function (statements) {
        if (!Array.isArray(statements)) {
          return Promise.reject(new Error('ctx.db.transaction 需要一个语句数组'));
        }
        return rpc('db.transaction', {
          statements: statements.map(function (statement) {
            var item = statement || {};
            return { sql: String(item.sql), params: dbParams(item.params) };
          }),
        });
      },
    };

  /**
   * 计时。in-process 的 `ctx.logger.trace(label)` 返回一个"结束计时"的函数。
   *
   * 沙箱里**能完整实现它** —— 它是纯本地逻辑（读一次时钟、返回一个闭包），
   * 不涉及任何跨 realm 的引用。因此这里不造假、也不省略：省略会让插件在
   * 沙箱里报 `logger.trace is not a function`，而那个错误看起来像插件自己写错了。
   */
  function trace(label) {
    var started = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return function () {
      var ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
      log('debug')(String(label) + '：' + (ended - started).toFixed(1) + ' ms');
    };
  }

  var logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    trace: trace,
  };

  // ============================================================
  // React：宿主那一份，经 `/<id>/react.js` 送过来
  // ============================================================
  //
  // 它由入口文档在**桥接层之前**加载（宿主写死的顺序），因此这里同步就能读到。
  // 送过来的原因见 `sandbox.rs` 里 `PLUGIN_REACT_JS` 的说明：插件仓库的构建把
  // `react` / `react/jsx-runtime` 接到 `globalThis.Modulith.React` 与
  // `globalThis.Modulith` 上，而那条约定的前提是**一个文档里只有一个 React 实例**。
  //
  // `null` 是可能的（脚本没加载起来）。那种情况下 `Modulith.React` 就是
  // `undefined`，插件报的是 "Cannot read properties of undefined" —— 看起来像
  // 它自己写错了。因此这里留一条明确的告警，并把原因说清楚。
  var PLUGIN_REACT = window.__MODULITH_PLUGIN_REACT__ || null;

  if (!PLUGIN_REACT) {
    log('error')(
      '宿主的 React 运行时没有加载（/<id>/react.js 没到）—— 用到 React 的插件会在这里失败'
    );
  }

  /**
   * 在沙箱里挂载一个 React 组件。
   *
   * **这是与 in-process 唯一需要说清楚的区别。** 那边的 `registerModule` 是向宿主
   * 注册一个组件，由宿主决定何时渲染、渲染到哪；这里插件**自己就是界面**，
   * 于是它退化成"把组件挂到我这块区域上"。
   *
   * 入参形状刻意与 in-process 一致（`{ id, name, description, icon, priority,
   * component }`），因为同一份插件代码可能跑在任一侧 —— 多出来的那几个字段
   * （侧边栏要靠的 name / icon / priority）在沙箱里由**清单的 `contributes.modules`**
   * 提供，不再由运行期声明。因此这里只认 `component`，其余忽略而不是报错。
   */
  function registerModule(definition) {
    var options = definition || {};
    var component = options.component;

    if (typeof component !== 'function') {
      log('error')('registerModule 需要一个 component 函数（收件到的类型：' + typeof component + '）');
      return { dispose: function () {} };
    }
    if (!PLUGIN_REACT) {
      log('error')('没有 React 运行时，registerModule 无法挂载');
      return { dispose: function () {} };
    }

    var root = document.getElementById('modulith-root');
    if (!root) {
      log('error')('入口文档里没有 #modulith-root —— 这不是插件能改的东西，说明宿主合成文档时漏了');
      return { dispose: function () {} };
    }

    var mounted = PLUGIN_REACT.ReactDomClient.createRoot(root);
    mounted.render(PLUGIN_REACT.React.createElement(component));

    return {
      dispose: function () {
        mounted.unmount();
      },
    };
  }

  /**
   * 我这个模块是不是"当前可见的那个"。
   *
   * in-process 插件需要它，是因为同一份文档里同时住着宿主与所有插件 ——
   * 不判断就会在别人的模块里也抢快捷键、抢拖放。
   *
   * 沙箱里这个问题的**前提不存在**：一个界面一个文档，里面只有它自己。
   * 界面不可见时宿主会把整个 webview 收起来（`hide()`），文档里的监听本来
   * 也不会有人去触发。因此恒为 `true` 是**准确的**，不是偷懒 —— 返回 `false`
   * 反而会让插件误以为自己没在被用。
   */
  function useModuleActive() {
    return true;
  }

  // ============================================================
  // 宿主 → 这里：只能走 postMessage
  // ============================================================
  //
  // 从前宿主能直接 `eval` 一段脚本进这个文档。跨源 iframe 没有那回事 —— 父文档
  // 拿不到这里的 `window`，`eval` 更不可能。宿主因此改走两跳：一条 Tauri 事件到
  // 主窗口，前端按令牌找到这个 iframe 再 `postMessage` 进来（见
  // `src/services/sandboxSurface.ts` 的 `postToSurface`）。
  //
  // ============================================================
  // 为什么认 `__modulith` 这个标记
  // ============================================================
  //
  // 它挡的不是宿主（宿主本来就发得对），而是**别的**能往这个窗口发消息的人：
  // 浏览器扩展、将来嵌进来的第三方内容、以及插件自己。少了这个标记，任何一条
  // 能走到这个窗口的消息都可能被当成宿主的命令。
  //
  // 身份判据是 `event.source`，不是 `event.origin`：来源字符串是发送方自己声明的，
  // 而窗口引用不能伪造 —— 只有宿主那个窗口能等于 `window.parent`。

  // ============================================================
  // 根类名
  // ============================================================
  //
  // 插件的 CSS 与宿主一样用 `:root.dark .foo` 写深色规则，而宿主挂在它自己
  // `documentElement` 上的 `.dark` **不会继承到这个文档**。入口文档里已经带了
  // 初始的那一份；这里负责换主题时把它改掉。
  //
  // 为什么令牌（`var(--x)`）对得上还不够：变量靠"重新声明"生效，类选择器靠
  // **属性匹配**生效。只换样式文本时，8 个插件的深色规则会全部静默失效。
  //
  // 白名单在这里是必要的，不只是防御：`classList` 被写进一个跨边界传过来的
  // 数组时，没有白名单就等于允许"用一条推送往根元素上挂任意属性"。
  var ROOT_CLASS_NAMES = ['dark', 'lc-reduce-motion', 'lc-no-glass'];

  /**
   * 把根元素上的主题类名换成宿主说的那一份。
   *
   * **只动自己管的那三个名字**，绝不整份重写 `className` —— 插件可能在根元素上
   * 挂了自己的类，整份重写会把它们一起抹掉，而那种损失是静默的。
   */
  function applyRootClasses(classes) {
    if (!Array.isArray(classes)) return;

    var root = document.documentElement;

    // 先摘掉"该消失的"，再挂上"该出现的"。顺序无所谓（两个集合不相交），
    // 但固定下来能让这里的行为可预测。
    ROOT_CLASS_NAMES.forEach(function (name) {
      if (classes.indexOf(name) === -1) root.classList.remove(name);
    });

    ROOT_CLASS_NAMES.forEach(function (name) {
      if (classes.indexOf(name) !== -1) root.classList.add(name);
    });
  }

  var PUSH_HANDLERS = {
    theme: function (payload) {
      var style = document.getElementById('modulith-theme');
      if (style && payload && typeof payload.css === 'string') style.textContent = payload.css;

      // 类名与样式文本**必须一起换**。只做上面那一步的表现是：令牌全对，
      // 而所有 `:root.dark …` 规则一条都不生效。
      if (payload) applyRootClasses(payload.rootClasses);

      if (window.__modulithThemeChanged) {
        window.__modulithThemeChanged(payload ? payload.described : null);
      }
    },

    shortcuts: function (payload) {
      if (window.__modulithShortcutsChanged) {
        window.__modulithShortcutsChanged(payload ? payload.table : null);
      }
    },

    command: function (payload) {
      if (window.__modulithCommand && payload) window.__modulithCommand(payload);
    },

    'download-progress': function (payload) {
      if (window.__modulithDownloadProgress && payload) {
        window.__modulithDownloadProgress(payload);
      }
    },

    event: function (payload) {
      if (window.__modulithDeliver && payload) window.__modulithDeliver(payload);
    },

    // 文件拖放。**与别的通道不同，这一条不是"转发给某个全局钩子"，而是扇出给
    // 插件自己注册的那些处理器** —— 因为 `ctx.fileDrop` 的形态就是这样：
    // `subscribe(handler)` 收一个回调，而不是让插件去挂一个全局名字。
    //
    // 权限**不在这里判**。宿主只把拖放转给清单里声明了 `filesystem-read` 的界面
    // （`sandbox_surface_open` 的返回值里带这一位），因此走到这里的每一条都是
    // 该收的。在这里再查一遍 `PERMISSIONS` 只会让人以为那是一道边界。
    'file-drop': function (payload) {
      if (!payload) return;

      // 快照后再遍历：处理器里退订是合法用法，边遍历边删会让 Set 的迭代行为
      // 变得难以推理（某些实现会因此跳过一项）。
      Array.from(FILE_DROP_HANDLERS).forEach(function (handler) {
        try {
          handler(payload);
        } catch (error) {
          // 与宿主侧的前端扇出同一条规矩：一个处理器出错不该让别的收不到。
          console.error('[Modulith] fileDrop 处理器抛出异常，已隔离：' + error);
        }
      });
    },
  };

  window.addEventListener(
    'message',
    function (event) {
      if (event.source !== window.parent) return;

      var data = event.data;
      if (!data || data.__modulith !== true) return;

      var handler = PUSH_HANDLERS[data.channel];
      // 认不出的 channel 一律忽略：宿主将来加一条新的推送时，一个**旧插件**不该
      // 因此报错，更不该把它当成别的东西。
      if (!handler) return;

      try {
        handler(data.payload);
      } catch (error) {
        // 一条推送处理失败不该把整块界面带走 —— 但也必须留下来。
        console.error('[Modulith] 处理宿主推送 ' + String(data.channel) + ' 失败：' + error);
      }
    },
    false
  );

  // ============================================================
  // 插件脚本抛错时，让它留下一句话
  // ============================================================
  //
  // **这是被一次真实事故逼出来的。** 8 个插件白屏那次，宿主这一侧的日志里
  // 什么都没有：插件脚本在顶层抛了 TypeError，而那个错误只存在于这个 iframe
  // 的控制台里 —— 用户在 release 版看不到控制台，宿主也拿不到它。于是现象是
  // "一块白板"，而原因在另一个进程里。
  //
  // 这两个监听器把"插件炸了"变成一条**宿主日志**。它们不捕获、不吞掉，
  // 只是报告 —— 控制台里那条仍然照常出现。
  function reportUncaught(label, detail) {
    var message = '[Modulith] ' + label + '：' + detail;
    console.error(message);

    // 给宿主写进文件日志：控制台在 release 版里看不到。
    try {
      rpc('log', { level: 'error', message: message }).catch(function () {});
    } catch (error) {
      /* 上报失败不再抛一次 */
    }

    // **并且投给前端，让它在界面上显示出来。**
    //
    // 只写日志不够：白屏那次的教训是"用户看到一块白板，而原因在另一个进程里"。
    // 前端把这条转成那一块界面上的错误提示，于是下一次失败是**看得见的**。
    try {
      window.parent.postMessage(
        { __modulith: true, channel: 'plugin-error', payload: { message: message } },
        '*'
      );
    } catch (error) {
      /* 够不到父窗口就算了 */
    }
  }

  window.addEventListener('error', function (event) {
    // `event.error` 有时是 null（跨源脚本、或某些语法错误），因此两条路都取。
    var detail = event && event.error && event.error.stack
      ? event.error.stack
      : String((event && event.message) || '未知错误');
    reportUncaught('插件脚本抛出未捕获的错误（界面会一直是白的）', detail);
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    reportUncaught(
      '插件里有一个 Promise 被拒绝且没有 catch',
      reason && reason.stack ? reason.stack : String(reason)
    );
  });

  // 宿主那一份 React 到底有没有送到。
  //
  // **这一条是"白屏"的另一个候选病因。** 插件文档的三个脚本是
  // `react.js → bridge.js → asset/main`，而 `PLUGIN_REACT` 是在桥接层**加载时**
  // 读的那个全局。`react.js` 要是没送到（路由、令牌、CSP 任何一处出问题），
  // 每个用 React 的插件都会在 `var React = Modulith.React;` 之后立刻炸 ——
  // 症状与 `createContext` 那次一模一样，都是一块白板。
  //
  // 放在这里报，是因为它比插件自己炸得早：它一条日志就能把两者分开。
  if (!PLUGIN_REACT) {
    reportUncaught(
      '宿主那一份 React 没有送到（react.js 没加载成功）',
      'window.__MODULITH_PLUGIN_REACT__ 是 ' +
        typeof window.__MODULITH_PLUGIN_REACT__ +
        '；用 React 的插件会因此整块白屏'
    );
  }

  // 告诉宿主"我起来了"。
  //
  // **这是唯一的就绪信号。** `iframe` 的 `load` 事件在一个加载失败的文档上照样会
  // 触发（引擎拿它自己画的那张错误页触发它），因此宿主那边不能用它判断成功 ——
  // 而这段代码跑到这里说明：文档加载了、脚本加载了、协议通了。
  //
  // 用 `'*'` 作为目标来源是必需的：这里读不到宿主自己的来源。它不构成泄露 ——
  // `postMessage` 只投递给 `window.parent` 一个窗口，而那条消息里只有这两个字段。
  try {
    window.parent.postMessage({ __modulith: true, channel: 'ready' }, '*');
  } catch (error) {
    /* 够不到父窗口时什么都不做：那时连这条日志都不一定出得去 */
  }

  // ============================================================
  // `Modulith.*` 那一张表上的运行时入口
  // ============================================================
  //
  // in-process 里 `Modulith.*` 与 `ctx.*` 是**两个**对象；沙箱里它们被并进了同一个
  // （沙箱没有 `ctx` 那个中间层）。因此**两张表里的成员这里都得有**。
  //
  // 而这件事长期没有被任何东西核对过：`check:sandbox` 的两侧比对只读了
  // `ctx.*`（`CONTEXT_MEMBERS`），`Modulith.*`（`HOST_MEMBERS`）那一侧从来没比过。
  // 一次针对"这 8 个插件能不能迁"的审计把它翻了出来 —— 缺了 5 个，
  // 而其中一个会让插件**根本加载不起来**。

  /** 平台标识。与宿主 `installHostGlobals` 里那个字面量一致。 */
  var platform = 'tauri';

  /**
   * 交出一条命令的行为函数。
   *
   * **写进与 `ctx.commands.on` 同一张表。** 宿主把命令推下来时，桥接层就是按
   * `commandHandlers` 找处理器的（见 `window.__modulithCommand`）—— 两条路各写
   * 一张表的话，`registerCommand` 注册的命令会永远收不到推送。
   *
   * ============================================================
   * 与 in-process 的一处真实差别
   * ============================================================
   *
   * in-process 的 `registerCommand` 在命令**没写进 `contributes.commands`** 时，
   * 会直接把它加进宿主的命令面板（并给一条警告）。沙箱做不到 —— 命令面板在宿主
   * 那一个文档里，而这个 iframe 改不了它。
   *
   * 因此沙箱里**只有清单声明过的命令**会被面板找到。这是能力差异，不是漏做：
   * 命令面板按定义是宿主的界面。它与 `ctx.manifest` 一样写进插件开发文档。
   */
  function registerCommand(command) {
    if (!command || !command.id || !command.title || typeof command.run !== 'function') {
      console.warn('[Modulith] registerCommand 需要 id、title 与 run，调用被忽略');
      return;
    }

    commands.on(command.id, command.run);
  }

  /**
   * 登记一个"插件被停用/卸载时执行"的清理函数。
   *
   * 与 `disposables.add` 是**同一件事的两个入口** —— in-process 侧也是这样
   * （`onDeactivate` 只是 `addDisposable` 的别名）。因此这里直接转发，
   * 而不是另起一张表：两张表意味着两种清理时机，而漏掉一种的表现是资源泄漏。
   *
   * **触发时机与 in-process 有一处差别。** 那边由宿主在停用/卸载时逐个调用；
   * 沙箱里这份文档的"停用"就是**它自己要被销毁**（宿主撤销令牌、前端卸掉 iframe），
   * 而文档消失前会收到 `pagehide` —— 桥接层已经在那条路径上接了 `flush()`。
   * 也就是说清理**仍然会发生**，但发生在文档消失的那一刻，而不是更早一点。
   */
  function onDeactivate(dispose) {
    if (typeof dispose !== 'function') {
      throw new TypeError('Modulith.onDeactivate 需要一个函数');
    }
    return disposables.add(dispose);
  }

  /** 文件拖放的订阅者。见 `PUSH_HANDLERS['file-drop']`。 */
  var FILE_DROP_HANDLERS = new Set();

  // ============================================================
  // 文件拖放（`ctx.fileDrop`）
  // ============================================================
  //
  // **形态必须与 in-process 的 `ctx.fileDrop` 完全一致**（`isAvailable` +
  // `subscribe`），否则同一个插件在两侧要改代码 —— 那正是这个文件开头那条承诺
  // 要防的事。
  //
  // 它为什么在 1.6.0 才出现：从前插件界面是一个**子 webview**，而 wry 在
  // Windows 上把拖放处理器注册在 webview 自己的 HWND 及其全部子窗口上
  // （wry-0.55.1/src/webview2/drag_drop.rs:50）。子 webview 有自己的 HWND 且没有
  // 注册处理器，于是落在它上面的文件既进不了宿主窗口的处理器、也没有东西接住。
  // 换成 iframe 之后，指针底下始终是**主 webview 的 HWND**，事件照常触发，
  // 而且带指针位置 —— 宿主据此只把它转给指针底下那一块界面。
  //
  // 与 in-process 的一处**语义差别**（更好的那种，写进文档）：in-process 的拖放是
  // **窗口级**的，插件必须自己用 `Modulith.useModuleActive()` 判断当前可不可见，
  // 否则后台插件会抢走本该属于别人的拖放。沙箱里不用 —— 宿主已经按位置筛过了，
  // 收到就是"拖到了我这一块上"。
  var fileDrop = {
    /**
     * 现在能不能收到拖放。
     *
     * 为假只有一种原因：清单里没有 `filesystem-read`。那时宿主根本不会把拖放转
     * 过来（判定在 `sandbox_surface_open` 里，见 `SurfaceHandle::file_drop`），
     * 因此这里的答案与"实际收不收得到"是一致的。
     */
    isAvailable: function () {
      return has('filesystem-read');
    },

    /**
     * 订阅拖放。返回取消订阅函数。
     *
     * 事件形状与 in-process 一致：`{ type: 'enter' | 'over' | 'drop' | 'leave',
     * paths: string[] }`。**没有指针位置** —— 那是宿主用来筛"该转给谁"的，
     * 对插件没有意义（它只可能收到落在自己身上那些）。
     */
    subscribe: function (handler) {
      if (typeof handler !== 'function') {
        throw new TypeError('fileDrop.subscribe 需要一个函数');
      }
      if (!has('filesystem-read')) {
        // 与宿主侧 `pluginFileDrop` 同一条规矩：未声明权限时降级为空订阅 +
        // 一次告警，而不是抛异常。拖放通常只是"再加一个条目"的便捷入口，
        // 让整个模块因为一个可选入口而不可用并不划算。
        console.warn(
          '[Modulith] 插件订阅了文件拖放，但清单里没有声明 "filesystem-read" 权限，订阅被忽略'
        );
        return function () {};
      }

      FILE_DROP_HANDLERS.add(handler);
      return function () {
        FILE_DROP_HANDLERS.delete(handler);
      };
    },
  };

  /**
   * 把 `post` / `put` 的 `data` 变成 JSON 请求体，并补上 `content-type`。
   *
   * 与 in-process 那边"先 `normalize(init)` 再 `JSON.stringify(data)`"是同一件事：
   * 插件传的是**对象**，序列化由这一层做。
   *
   * 调用方已经给了 `content-type` 时**不覆盖** —— 覆盖会让"我明明说了用别的类型"
   * 变成一句谎话，而那种错误表现为服务端解析失败，离真正的原因很远。
   */
  function withJsonBody(data, init) {
    var options = init || {};
    if (data === undefined) return options;

    var headers = {};
    var provided = options.headers || {};
    Object.keys(provided).forEach(function (key) {
      headers[key] = provided[key];
    });

    var hasContentType = Object.keys(headers).some(function (key) {
      return key.toLowerCase() === 'content-type';
    });
    if (!hasContentType) headers['content-type'] = 'application/json';

    return { headers: headers, body: JSON.stringify(data) };
  }

  var Modulith = {
    dataDir: dataDir,
     db: db,

    // ---- React：宿主那一份 ----
    //
    // `React` 与 `jsx` / `jsxs` / `Fragment` 分开给，不是为了整齐：
    // 插件仓库的 shim 把 `require('react')` 接到 `Modulith.React`、
    // 把 `require('react/jsx-runtime')` 接到 **`Modulith` 本身**。
    // 后者要的正是 `jsx` / `jsxs` / `Fragment` 这三个成员。
    // 两边对上，插件的 bundle 一个字都不用改。
    React: PLUGIN_REACT ? PLUGIN_REACT.React : undefined,
    jsx: PLUGIN_REACT ? PLUGIN_REACT.JsxRuntime.jsx : undefined,
    jsxs: PLUGIN_REACT ? PLUGIN_REACT.JsxRuntime.jsxs : undefined,
    jsxDEV: PLUGIN_REACT ? PLUGIN_REACT.JsxDevRuntime.jsxDEV : undefined,
    Fragment: PLUGIN_REACT ? PLUGIN_REACT.JsxRuntime.Fragment : undefined,

    /**
     * 创建插件上下文。**与 in-process 同名同义。**
     *
     * ============================================================
     * 这里曾经接错成 `React.createContext` —— 后果是 8 个插件全部白屏
     * ============================================================
     *
     * 插件在 bundle 顶层写 `var ctx = Modulith.createContext()`，拿到的却是一个
     * **React context 对象**：于是 `ctx.storage` 是 `undefined`，
     * `ctx.storage.get(...)` 抛 TypeError，bundle 在顶层就炸了，
     * `registerModule` **从来没有被调到** —— 屏幕上就是一块白的，而且宿主这一侧
     * 什么日志都没有。
     *
     * 9 个插件里只有 `hello` 活了下来，因为它直接用 `Modulith.storage`，不经过
     * `createContext`。这个错误因此躲过了当时所有的静态断言：那些断言查的是
     * "成员在不在对象上"，而 `createContext` **确实在** —— 只是它是另一个东西。
     *
     * ============================================================
     * 正确的做法：返回 `Modulith` 自己
     * ============================================================
     *
     * in-process 有**两个**对象（`Modulith` 是运行时入口，`ctx` 是能力），而
     * `createContext()` 就是从前者造出后者。沙箱里没有那个中间层 —— 两边被并进了
     * 同一个对象 —— 因此"造一个 ctx"在这里就是"返回我自己"。
     *
     * 返回**同一个对象**而不是副本：插件里有 `var ctx = Modulith.createContext()`
     * 然后长期持有它的写法，副本会让"往 `Modulith` 上加的东西在 `ctx` 上看不见"，
     * 而那种不同步没有任何症状。
     */
    createContext: function () {
      return Modulith;
    },

    /** 沙箱里退化成"把自己挂到本界面" —— 见上面的说明 */
    registerModule: registerModule,

    /** 平台标识。与 in-process 的 `Modulith.platform` 同一个字面量。 */
    platform: platform,

    /**
     * 交出一条命令的行为函数。见上面 `registerCommand` 的说明 ——
     * 沙箱里只有清单声明过的命令会被面板找到。
     */
    registerCommand: registerCommand,

    /**
     * 登记清理函数。与 `disposables.add` 同一个入口，触发时机见上面的说明。
     */
    onDeactivate: onDeactivate,

    /** 恒为 true；理由见上面的说明（沙箱里"别的模块"这个概念不存在） */
    useModuleActive: useModuleActive,

    // ---- 与 in-process ctx 同名的三个别名 ----
    //
    // 它们与下面的 `plugin` 是**同一份数据**，只是换了个形状。留着两份形状
    // 不是为了好看：in-process 插件读的是 `ctx.pluginId` / `ctx.pluginVersion` /
    // `ctx.version`，而沙箱这一侧原来只有 `plugin.id` / `plugin.version`。
    // 那意味着**同一个插件在两侧要改代码** —— 与这个文件开头"切换运行位置不改
    // 一行代码"的承诺直接矛盾，而且不一致的那一侧拿到的只是 `undefined`。
    //
    // `version` 是**宿主**版本（不是插件版本）：in-process 的 `ctx.version` 就是它，
    // 插件用它做特性探测之外的事都很容易搞混，因此注释写清楚。
    pluginId: PLUGIN_ID,
    pluginVersion: PLUGIN_VERSION,
    version: PLUGIN_HOST_VERSION,

    /** 沙箱插件的身份。**宿主给出的**，不是插件自报的。 */
    plugin: {
      id: PLUGIN_ID,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      runtime: PLUGIN_RUNTIME,
      permissions: PERMISSIONS.slice(),
      /**
       * 我现在在哪一个界面里。
       *
       * 主界面是 `"main"`。单界面插件看到的永远是它 —— 而多界面插件需要靠它
       * 分辨"我这份代码是被当成列表加载的，还是被当成详情加载的"。
       */
      surface: PLUGIN_SURFACE,
    },

    /**
     * 我声明了哪些界面：`[{ id, name, primary }]`。
     *
     * 这是**清单的投影**（同步可读），不是运行期状态。想知道哪些开着，
     * 用 `ui.listSurfaces()`。
     */
    surfaces: SURFACES,

    /** 本次由什么唤醒（沙箱界面总是 `open`：用户打开了它）。 */
    activationEvent: ACTIVATION_EVENT,

    /**
     * 声明了某个权限没有。
     *
     * 插件应当用它做特性探测，而不是去比较宿主版本 —— 与 `Modulith.capabilities`
     * 的既有约定一致。未声明的能力即使被调用，宿主也会拒绝。
     */
    has: has,

    /**
     * 日志。**两个名字指向同一个对象**：in-process 叫 `ctx.logger`，沙箱历史上
     * 叫 `Modulith.log`。留两个名字是因为"同一个插件两侧都能跑"这个承诺 ——
     * 而只留一个会让一半插件在另一侧拿到 `undefined`。
     */
    log: logger,
    logger: logger,

    storage: {
      /** 读一个键。不存在时返回 `fallback`。值以 JSON 存储，对象与数组原样取回。 */
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

      /**
       * 分页枚举键 —— 数据量大时**应当用这个**而不是 `keys()`。
       *
       * 游标是不透明的：原样回传 `nextCursor`，`null` 表示到底。
       */
      list: function (options) {
        var options0 = options || {};
        return rpc('storage.list', {
          prefix: options0.prefix === undefined ? '' : options0.prefix,
          cursor: options0.cursor === undefined ? null : options0.cursor,
          pageSize: options0.pageSize === undefined ? null : options0.pageSize,
        });
      },

      /** 当前用量（字节数与键数）。 */
      usage: function () {
        return rpc('storage.usage', {});
      },

      /** 读出全部键值。键数超过 500 时会**抛错**而不是截断。 */
      all: function () {
        return rpc('storage.all', {});
      },

      /** 清空这个插件的键值存储（不动数据目录）。 */
      clear: function () {
        return rpc('storage.clear', {});
      },
    },


    http: {
      /**
       * 受管网络请求。需要 `network`（本机/回环）或 `network-external` 权限。
       *
       * 它**不是** `window.fetch` 的别名：出口在宿主侧，因此权限与来源判定
       * 都在那里做，插件改不掉。
       */
      fetch: function (url, options) {
        var options0 = options || {};
        return rpc('http.fetch', {
          url: url,
          method: options0.method === undefined ? 'GET' : options0.method,
          headers: options0.headers === undefined ? null : options0.headers,
          body: options0.body === undefined ? null : options0.body,
        });
      },

      /**
       * 通用请求：`request(method, url, init?)`。与 in-process 同名同形。
       *
       * 下面四个是它的糖，形状与宿主逐字一致 —— 包括 `post` / `put` 收的是
       * **对象**（序列化由这一层做，插件不必自己 `JSON.stringify`）。
       */
      request: function (method, url, init) {
        var options = init || {};
        return rpc('http.fetch', {
          url: url,
          method: String(method).toUpperCase(),
          headers: options.headers === undefined ? null : options.headers,
          body: options.body === undefined ? null : options.body,
        });
      },

      get: function (url, init) {
        return http.request('GET', url, init);
      },

      post: function (url, data, init) {
        return http.request('POST', url, withJsonBody(data, init));
      },

      put: function (url, data, init) {
        return http.request('PUT', url, withJsonBody(data, init));
      },

      delete: function (url, init) {
        return http.request('DELETE', url, init);
      },

      /**
       * 把一个文件**直接下到数据目录**，不经过 JS 内存。
       *
       *   await Modulith.http.download(url, 'models/model.bin', function (p) {
       *     // p: { rel, received, total }，total 可能为 null（分块传输）
       *   });
       *   // → { rel, bytes, contentType, status }
       *
       * ============================================================
       * 为什么不能"先 fetch 再 dataDir.write"
       * ============================================================
       *
       * `http.fetch` 的响应体是**一个字符串**：整段字节会在宿主的 Rust 里驻留一次、
       * 编码成 JSON、过一遍 IPC、在你的 JS 堆里再驻留一次、再写回去。峰值内存是
       * 文件大小的好几倍 —— 对一个 200 MB 的模型文件，那就是几个 GB。
       *
       * 这一条从网络流直接写进磁盘，全程只有一个固定大小的缓冲区。
       *
       * ============================================================
       * 目标路径的上级目录必须**已经存在**
       * ============================================================
       *
       * 与 `dataDir.write` 同一条规则：不自动建父目录。先 `dataDir.mkdir('models')`。
       *
       * ============================================================
       * 落盘是"全有或全无"
       * ============================================================
       *
       * 失败（网络断、超出配额、HTTP 非 2xx）时目标文件**不会出现**，也**不会**
       * 留下一个被截断的版本 —— 而截断的版本看起来完全正常（图片能打开一半）。
       */
      download: function (url, rel, onProgress, options) {
        var options0 = options || {};
        var key = String(rel);

        if (typeof onProgress === 'function') {
          downloadHandlers[key] = onProgress;
        } else {
          // `download(url, rel, options)` 那种写法：第三个参数是选项
          if (onProgress && typeof onProgress === 'object') options0 = onProgress;
          delete downloadHandlers[key];
        }

        return rpc('http.download', {
          url: url,
          rel: key,
          headers: options0.headers === undefined ? null : options0.headers,
        });
      },
    },

    // ============================================================
    // 通知（`ctx.notifications`）
    // ============================================================
    //
    // **形状必须与 in-process 的 `ctx.notifications` 逐字一致**：那边是
    // `{ show, info, success, warn, error, isAvailable }`，参数是**位置参数**
    // `(title, body, dedupeKey)`。这里曾经是一个 `notify(input)` —— 于是
    // `pomodoro` 调 `ctx.notifications.isAvailable()` 直接 TypeError、界面白屏。
    //
    // 同一条错误在这次迁移里出现两次（还有 `ctx.events`），原因都是同一个：
    // 早先的核对只比**成员名**。见 `staging/audit-plugin-methods.cjs`。
    notifications: (function () {
      var allowed = has('notification');

      var warned = false;
      function warnOnce() {
        if (warned) return;
        warned = true;
        console.warn(
          '[Modulith] 插件调用了通知接口，但清单里没有声明 "notification" 权限，调用被忽略（后续同类调用不再重复提示）'
        );
      }

      function notify(title, body, level, dedupeKey) {
        if (!allowed) {
          warnOnce();
          // 与 in-process 一样**不抛**：通知是"顺带说一声"，让它失败会拖垮
          // 一个本来正常的流程。
          return Promise.resolve();
        }
        return rpc('notify', {
          title: title,
          body: body === undefined ? '' : body,
          level: level,
          dedupeKey: dedupeKey === undefined ? null : dedupeKey,
        });
      }

      return {
        show: function (title, body, dedupeKey) {
          return notify(title, body, 'info', dedupeKey);
        },
        info: function (title, body, dedupeKey) {
          return notify(title, body, 'info', dedupeKey);
        },
        success: function (title, body, dedupeKey) {
          return notify(title, body, 'success', dedupeKey);
        },
        warn: function (title, body, dedupeKey) {
          return notify(title, body, 'warning', dedupeKey);
        },
        error: function (title, body, dedupeKey) {
          return notify(title, body, 'error', dedupeKey);
        },
        /** 权限是否已声明（插件据此自行降级，而不必看控制台）。 */
        isAvailable: function () {
          return allowed;
        },
      };
    })(),

    launcher: {
      launch: function (program, args) {
        return rpc('system.launch', {
          program: program,
          args: args === undefined ? [] : args,
        });
      },
    },

    icons: {
      extract: function (path) {
        return rpc('system.icon', { path: path });
      },
    },

    shell: {
      revealInFolder: function (path) {
        return rpc('system.reveal', { path: path });
      },
    },

    audio: {
      /** 让用户选一个音频文件。返回可直接播放的 data URL，取消时为 `null`。 */
      pick: function () {
        return rpc('system.pickAudio', {});
      },
    },

    settings: {
      /**
       * 这块界面能不能用设置接口。
       *
       * 与 in-process 同名同形（那边是 `pluginSettingsAPI`）。**它曾经缺失** ——
       * 而 `isAvailable` 正是插件用来"自己降级、而不是去读控制台"的那个方法，
       * 缺了它插件只能猜。
       */
      isAvailable: function () {
        return has('storage');
      },

      /**
       * 读插件贡献的设置项。
       *
       * 值存在插件自己的存储里（键前缀由宿主保留），因此**需要 `storage` 权限**。
       * `fallback` 在没改过时返回 —— 缺省值写在清单里，插件自己知道它是什么。
       */
      get: function (id, fallback) {
        return rpc('settings.all', {}).then(function (all) {
          var values = all || {};
          return Object.prototype.hasOwnProperty.call(values, id) ? values[id] : fallback;
        });
      },

      all: function () {
        return rpc('settings.all', {});
      },

      set: function (id, value) {
        return rpc('settings.set', { id: id, value: value });
      },
    },

    clipboard: clipboard,

    /** 文件拖放。形态与 in-process 一致，语义差别见上面的 `fileDrop`。 */
    fileDrop: fileDrop,

    events: events,

    commands: commands,

    theme: theme,

    shortcuts: shortcuts,

    ui: ui,

    disposables: {
      add: disposables.add,
      size: disposables.size,
    },
  };

  Object.defineProperty(window, 'Modulith', {
    value: Modulith,
    writable: false,
    configurable: false,
  });
})();
