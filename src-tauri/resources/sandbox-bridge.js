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
// 插件自己写错了。`check:sandbox` 里有一条断言逐项比对两份清单。
//
// 两处**刻意不同**的地方：
//   * `ctx.fileDrop` 不存在（拖放是窗口级事件，沙箱 webview 是子窗口，
//     主窗口收到的事件到不了这里）；
//   * `registerModule` 的**含义**不同：in-process 是"向宿主注册一个组件"，
//     沙箱是"把我这个组件挂到本界面上"（插件自己就是界面）。名字与入参形状
//     刻意保持一致，因此同一份插件代码在两侧都能跑。
// 第一条是**能力差异**，不是"还没做" —— 它写进插件开发文档。
//
// 另外三个只在沙箱里有的成员：`React` / `jsx` / `jsxs` / `Fragment` /
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

  var RPC_ROOT = '/' + PLUGIN_ID + '/rpc/';
  var DATA_ROOT = '/' + PLUGIN_ID + '/data/';

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
     * 数据根目录当前是否可用。
     *
     * 这个值是**文档加载时**宿主注入的快照，因此它同步可读（插件在顶层就能用它
     * 决定"先建目录还是先提示用户去配置"）。要拿实时状态用 `status()`。
     */
    available: DATA_AVAILABLE,

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

  var clipboard = {
    read: function () {
      if (!has('clipboard')) {
        return Promise.reject(new Error('这个插件没有声明 clipboard 权限'));
      }
      return navigator.clipboard.readText();
    },
    write: function (text) {
      if (!has('clipboard')) {
        return Promise.reject(new Error('这个插件没有声明 clipboard 权限'));
      }
      return navigator.clipboard.writeText(String(text));
    },
  };

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

  var events = {
    /** 发一条跨插件事件。需要 plugin-communicate 权限。 */
    emit: function (name, payload) {
      return rpc('events.emit', { name: String(name), payload: payload });
    },

    /**
     * 订阅一条跨插件事件。返回取消订阅的函数。
     *
     * 处理器收到 (payload, source) —— **来源是宿主给的**，不是发送方自报的：
     * 一个插件不该能冒充另一个插件发事件。
     */
    on: function (name, handler) {
      if (typeof handler !== 'function') {
        throw new Error('ctx.events.on 需要一个函数');
      }
      var key = String(name);
      if (!eventHandlers[key]) eventHandlers[key] = [];
      eventHandlers[key].push(handler);

      return function () {
        var list = eventHandlers[key] || [];
        eventHandlers[key] = list.filter(function (item) {
          return item !== handler;
        });
      };
    },
  };

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
    /** 与 in-process 同名同义。插件用 `Modulith.createContext(...)` 建自己的 context */
    createContext: PLUGIN_REACT ? PLUGIN_REACT.React.createContext : undefined,

    /** 沙箱里退化成"把自己挂到本界面" —— 见上面的说明 */
    registerModule: registerModule,

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

    notifications: {
      /** 推一条通知。需要 `notification` 权限。 */
      notify: function (input) {
        var input0 = input || {};
        return rpc('notify', {
          title: input0.title,
          body: input0.body === undefined ? '' : input0.body,
          level: input0.level === undefined ? 'info' : input0.level,
          dedupeKey: input0.dedupeKey === undefined ? null : input0.dedupeKey,
        });
      },
    },

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
