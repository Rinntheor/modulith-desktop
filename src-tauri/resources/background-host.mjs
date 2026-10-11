// background-host.mjs
//
// 后台宿主：与界面无关的插件运行环境。
//
// ============================================================
// 为什么是独立的 Node 进程
// ============================================================
//
// 应用要有"在窗口之外继续工作"的能力（后台插件、使用情况监测）。这些能力要求
// **进程不随窗口关闭而结束**，而界面插件跑在主窗口的 WebView 里 —— 那个环境会被
// 降级（内存目标等级设为 Low）、会被隐藏、脚本会被浏览器冻结。
// 把"长期在后台跑着的事"托付给它，等于托付给一个随时可能被挂起的执行环境。
//
// 选 Node 而不是"再开一个隐藏 WebView"：隐藏 WebView 依然是一整套浏览器进程
// （实测 6~8 个、几百 MB），而这是一个进程、且能在不需要时被完全关掉。
//
// **每个后台插件一个进程**：崩溃与内存不互相影响。一个后台插件写出死循环时，
// 它只该弄死自己，而不是拖走其余全部后台插件。
//
// ============================================================
// 协议（与 src-tauri/src/modules/desktop/background/protocol.rs 一一对应）
// ============================================================
//
//   · stdin/stdout 上**每行一个 JSON**；stderr 留给日志（不做协议用）。
//   · 启动后第一件事是打印一行**问候**：`{"v":2,"runtime":"node/…"}`。
//     宿主会先读它再投入使用，因此协议版本错配在启动那一刻就暴露，
//     而不是在某个具体调用上以一个奇怪的字段缺失暴露。
//   · 每个方向都是 `{v,id,method,params?}` 与 `{v,id,result?|error?}`。
//   · 响应**恰好**有 result 或 error 之一：两者都缺或都有都会被宿主拒绝。
//
// ============================================================
// 两个方向的消息靠什么区分：`method`
// ============================================================
//
// 宿主 → 这里：带 `method` 的是请求，这里回答 `result` / `error`。
// 这里 → 宿主：插件的 `ctx.*` 调用同样带着 `method`，宿主回答 `result` / `error`。
//
// 也就是说这条线上**同时有**两条独立的 id 空间在跑，而它们不会混：收到一条
// 带 `method` 的，就是对面在问我；不带的就是在回答我。别加显式的 type 字段 ——
// 那会多一个两边都要维护、写错了还不会被发现的自由度。
//
// ============================================================
// 插件代码跑在哪：`node:vm` 上下文 + 白名单桥接
// ============================================================
//
// **必须说清楚这一层的强度。** Node 官方文档明确写着 `vm` 不是安全机制。
// 这里能给的是：
//
//   1. 插件拿不到 `require` / `import` / `process` / `Buffer` —— 它们只是
//      没有出现在那个上下文的 global 上；
//   2. 它只有一个冻结的 `Modulith` 对象，所有能力都经过宿主的方法；
//   3. **宿主进程本身**是用 `--permission` 启动的，只放开这个插件自己的
//      代码目录与数据目录。这一条才是真正由引擎执行的那层边界 ——
//      即便有人逃出了 vm，他也没有别的文件系统权限。
//
// 它**挡不住**一个蓄意逃逸的插件。这个进程里能做的事，它的上限由第 3 条划出，
// 而不是由 vm 划出。需要更强隔离的后台插件应当写成界面插件（那有真正的
// 渲染进程边界），而不是指望这一层。
//
// ============================================================
// 一条曾经的弯路，留在这里以免重走
// ============================================================
//
// 这里曾经实现过一套**定时任务**（间隔/每日/一次性），并让子进程主动向宿主
// 发 `schedule.fired` 事件。它被移除了 —— 连同它的出站事件机制一起。
//
// 那一次移除是对的：当时"后台能做什么"没有定义，而先做定时器等于先做一个
// 没有消费者的功能。**现在定义清楚了**（后台插件、完整的 ctx 子集），
// 因此它回来了 —— 但回来的是"插件自己持有定时器"，不再是宿主替它调度：
// 定时语义属于插件，宿主只负责让它活着与让它停。

import { createContext, Script } from 'node:vm';
import { readFileSync, realpathSync } from 'node:fs';

/** 协议版本。必须与 Rust 侧的 PROTOCOL_VERSION 一致。 */
const PROTOCOL_VERSION = 2;

/** 日志前缀。子进程的 stderr 会进应用日志，前缀便于过滤。 */
const LOG_PREFIX = '[background]';

/** 单次宿主调用的超时（毫秒）。与 Rust 侧的 REQUEST_TIMEOUT_MS 一致。 */
const HOST_CALL_TIMEOUT_MS = 10_000;

/** 一次插件入口执行的同步时间上限。超过它说明顶层有死循环。 */
const LOAD_TIMEOUT_MS = 5_000;

/** 进程启动时刻，用于 `status` 与 `shutdown` 上报的运行时长。 */
const startedAt = Date.now();

/**
 * 这个进程跑在 Windows 上吗。
 *
 * 它只服务两个同步的 `isAvailable()`（`ctx.hotkey` 与 `ctx.selection`）：两者的
 * 底层接口（`RegisterHotKey` / `SendInput`）都只存在于 Windows。**不问宿主**是有
 * 原因的 —— 那两个方法是同步的（插件在 bundle 顶层用它做特性探测），而这一侧与
 * 宿主只有请求—应答式的一条通道，等它回来时顶层早就跑完了。
 */
const WINDOWS = process.platform === 'win32';

/** 已处理过的请求数 */
let handled = 0;

// ============================================================
// 写出
// ============================================================

/**
 * 写出**一条**消息。
 *
 * 用一次 `process.stdout.write` 而不是分成多次：一条消息必须**一次**写出去，
 * 否则两条消息可能交错，对面会把它们当成同一行。Node 的 stdout 在管道上是
 * 异步的，但单次 write 的字节不会被别的 write 插进来。
 */
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 回答对面的一条请求。
 *
 * `error` 与 `result` **恰好给一个**：两者都给或都不给都会被对面拒绝
 * （见 protocol.rs 的 validate）。
 */
function respond(id, { result, error }) {
  const payload = { v: PROTOCOL_VERSION, id };
  if (error !== undefined) {
    payload.error = String(error);
  } else {
    payload.result = result === undefined ? null : result;
  }
  write(payload);
}

// ============================================================
// 反向调用：插件 → 宿主
// ============================================================

/** 等宿主回答的调用：id → {resolve, reject, timer} */
const pendingCalls = new Map();

let nextCallId = 1;

/**
 * 向宿主发起一次调用（插件的 `ctx.*` 都走它）。
 *
 * 超时是**必须**的：宿主若因为任何原因没有回答（崩了、卡住了、这条消息丢了），
 * 插件那边的 await 会永远挂着 —— 而"一个永远不 resolve 的 Promise"在插件作者
 * 看来是"我的代码没问题，就是没反应"，比一句错误难查得多。
 *
 * ============================================================
 * 唯一的例外：`untilUserAnswers`
 * ============================================================
 *
 * `ctx.ui.popover` 是**唯一**一条会等到用户做出动作的调用，而它的缺省形态是
 * "用户不关它就一直等着"。给它套一个 10 秒的计时器等于让那张卡片在用户还在看
 * 的时候被单方面作废：后台这一侧到点丢掉等待，宿主那一侧十秒之后才回话 ——
 * 答复落在一条没有人等的通道上（`收到没有等待者的响应 id=17`），
 * 而插件看到的是"调用宿主超时"，用户看到的是一张还留在屏幕上的卡片。
 *
 * 因此这一条**不给计时器**。它换来的代价必须说清楚：如果宿主那一侧永远不回答，
 * 这次等待就永远不结束。那一侧为此给了四条收场路径（用户关掉它 / 插件被停用
 * 或卸载 / 第二条卡片顶掉它 / 应用退出），而它们**都在宿主里**，插件不需要做
 * 任何事。宿主进程若整个消失，这个子进程也会被一起收掉 —— 那是最后一道兜底。
 *
 * `true` 只允许出现在一处（`ctx.ui.popover`）。给它再加一处，就意味着某条会
 * 自己结束的调用也永远不会超时。
 */
function callHost(method, params, options) {
  const id = nextCallId;
  nextCallId += 1;

  const untilUserAnswers = Boolean(options && options.untilUserAnswers);

  return new Promise((resolve, reject) => {
    const timer = untilUserAnswers
      ? null
      : setTimeout(() => {
          pendingCalls.delete(id);
          reject(new Error(`调用宿主超时（${HOST_CALL_TIMEOUT_MS}ms）：${method}`));
        }, HOST_CALL_TIMEOUT_MS);

    pendingCalls.set(id, { resolve, reject, timer });
    write({ v: PROTOCOL_VERSION, id, method, params });
  });
}

/** 把宿主发来的一条响应交给等待它的调用 */
function deliverResponse(message) {
  const waiter = pendingCalls.get(message.id);
  if (!waiter) {
    // 没有等待者：要么是超时之后的迟到响应，要么是宿主回了我们没有请求过的 id。
    // 后者说明协议实现有问题，因此如实记下来而不是静默丢掉。
    process.stderr.write(`${LOG_PREFIX} 收到没有等待者的响应 id=${message.id}\n`);
    return;
  }

  pendingCalls.delete(message.id);
  if (waiter.timer) clearTimeout(waiter.timer);

  if (message.error !== undefined) {
    waiter.reject(new Error(String(message.error)));
  } else {
    waiter.resolve(message.result === undefined ? null : message.result);
  }
}

// ============================================================
// 插件宿主
// ============================================================

/**
 * 已加载的插件：插件 id → 那一个上下文与它的资源登记。
 *
 * 用 `Map` 而不是单个变量：宿主脚本是**一个进程服务一个插件**，因此现在
 * 只会有一条。但把它写成表而不是单例，是因为"一个进程只服务一个插件"是
 * **启动参数决定的**，不是这段代码决定的 —— 写死成单例会让将来想在同一
 * 进程里跑多个插件时不得不重写整段。
 */
const plugins = new Map();

/**
 * 给插件用的 stderr 日志。
 *
 * **它绝不能写 stdout**：stdout 是协议专用通道，插件的一句 `console.log`
 * 混进去会让宿主把一行日志当成一条消息，然后报一句"无法解析的响应" ——
 * 而真正的原因（插件打了一行日志）在日志里根本看不出来。
 */
function pluginConsole(pluginId) {
  const emit = (level) => (...args) => {
    const text = args
      .map((value) => {
        if (typeof value === 'string') return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(' ');
    process.stderr.write(`${LOG_PREFIX} [${pluginId}] ${level}: ${text}\n`);
  };

  return { log: emit('log'), info: emit('info'), warn: emit('warn'), error: emit('error'), debug: emit('debug') };
}

/**
 * 造出插件的那个上下文。
 *
 * 只放**明确需要**的东西进去。没有 `require`、没有 `process`、没有 `Buffer`、
 * 没有 `globalThis.process` —— 这些不是"忘了加"，是刻意不给。
 */
function createPluginSandbox(identity, _unused) {
  const pluginId = identity.id;

  /** 清单里声明了某一项权限吗。与界面两侧的 `has('x')` 是同一条判据。 */
  const hasPermission = (permission) => identity.permissions.indexOf(permission) !== -1;

  // 定时器要**登记**才能被 unload 收掉。不登记的话，一个插件被卸载之后它的
  // setInterval 还在跑 —— 而它已经没有任何办法被停下来了（宿主手里没有句柄）。
  const timers = new Set();

  /**
   * 包一层定时器，让它可被回收。
   *
   * 一次性定时器在回调里把自己从表里摘掉，否则这张表会随运行时间线性增长 ——
   * 一个每小时跑一次的插件跑一年会留下一万多个已经死掉的句柄。
   */
  const track = (schedule) => (fn, ms, ...rest) => {
    const handle = schedule(() => {
      timers.delete(handle);
      try {
        fn();
      } catch (error) {
        process.stderr.write(
          `${LOG_PREFIX} [${pluginId}] 定时回调抛错：${error?.stack ?? error}\n`
        );
      }
    }, ms, ...rest);
    timers.add(handle);
    return handle;
  };

  const disposables = [];
  const handlers = new Map();

  /** 登记一个事件处理器，返回取消订阅的函数 */
  const subscribe = (key, handler, what) => {
    if (typeof handler !== 'function') {
      throw new Error(`${what} 需要一个函数`);
    }
    const list = handlers.get(key) || [];
    list.push(handler);
    handlers.set(key, list);
    return () => {
      const current = handlers.get(key) || [];
      handlers.set(
        key,
        current.filter((item) => item !== handler)
      );
    };
  };

  // ============================================================
  // ctx：后台插件能用的一切
  // ============================================================
  //
  // **刻意是界面 ctx 的子集**：没有 `theme` / `fileDrop` /
  // `db` / `icons` / `audio`。它们要么是 DOM，要么是窗口级的东西，而这里没有窗口。
  // 少给一个成员的表现是插件拿到 `undefined`，因此这份清单必须与
  // `pluginRuntime.ts` 的对应关系写清楚（见插件开发文档的"两个运行位置"一节）。
  //
  // 两处**部分存在**的成员，都写明了少的是哪一半与为什么：
  //
  //   * `clipboard` —— 只有 `writeText`（见下面那一段）。观察那一半要一条
  //     宿主 → 插件的推送通道，而这里没有界面承载它；
  //   * `ui` —— 只有 `popover`（它是这一族里唯一不需要界面上下文的那一个）。
  //
  // `secrets` 此前也在这份"没有"的清单里，而那**不是**刻意排除 —— 它是遗漏：
  // 三个运行位置里只有后台少了它，后果是一个无界面插件存令牌只能走明文
  // `ctx.storage`。它现在与另外两处同形（见下面 `secrets` 那一段）。此后往
  // 这份清单里加成员时，请先问一句"另外两个运行位置有没有它" —— 两边不一致
  // 才是需要写理由的那种情况。
  //
  // ============================================================
  // 两个**不是子集**的例外：`ctx.ui.popover` 与 `ctx.hotkey` / `ctx.selection`
  // ============================================================
  //
  // 上面那句话说的是"界面位置有、这里没有"，而下面这三个是反过来的：它们在这里
  // 不只是"也有"，而是**主要用途就在这里**。`ctx.ui.popover` 是后台插件唯一的
  // 结果出口，而 `ctx.hotkey` + `ctx.selection` 合起来正是"选中即翻译"型插件的
  // 全部：一个没有窗口的进程，要在用户**在别的程序里**选中文本并按键时被唤醒。
  // 把它们当成"界面的子集"来理解会得出错误的结论（"后台少一个能力"），而事实是
  // 后台位置才是它们最该被用到的地方。
  //
  // ============================================================
  // 唯一的例外：`ctx.ui.popover`
  // ============================================================
  //
  // 它是这条"子集"里**唯一**的 `ui` 成员，而且这个例外是刻意的 —— 它不是
  // "少给了一个 DOM 对象"，恰恰相反：一个后台插件**最需要**把结果拿给用户看，
  // 而它本来一条出口都没有。
  //
  // 它与其他 `ui.*` 的差别不在强度，而在**它需要什么**：dialog / contextMenu /
  // openSurface 那一族要么挂在"我在哪个界面里"，要么要一块属于插件的 webview
  // 可覆盖 —— 后台插件两样都没有，硬给它一个永远拒绝的桩只会让作者以为
  // "我写错了"。结果卡片是一个独立窗口、贴的是屏幕上的光标，与"我在哪里"
  // 无关，因此它是这一族里唯一在三个运行位置上都成立的那一个。
  //
  // 它依然要 `notification` 权限（与在界面上调用时**同一条判定**：三者都走
  // `rpc.rs` 的 `ui.popover`）。
  //
  // **剪贴板监测（`ctx.clipboard.subscribe` 一类）也刻意不在这里**，而且理由与
  // 上面那几种不同，值得单独写一句：它不是"缺一个 DOM 对象"，而是**方向不对**。
  // 变化是宿主进程里的 Win32 轮询观察到的（`GetClipboardSequenceNumber`），宿主
  // 把它推给"订阅者所在的界面"；而后台插件既没有界面可以承载那条推送，也没有一条
  // 从宿主主动回到它的通道（这里只有请求-应答式的 `callHost`）。
  // 硬给它一个永远收不到东西的 `subscribe` 只会让作者以为"我订阅上了"。需要
  // 剪贴板历史的插件必须是界面插件 —— 那也正是它能展示历史的前提。

  const ctx = {
    // ---- 身份（宿主给的，插件伪造不了）----
    pluginId: identity.id,
    pluginVersion: identity.version,
    pluginName: identity.name,
    manifest: identity.manifest,
    activationEvent: identity.activation,

    // ---- 全局热键（`ctx.hotkey`）----
    //
    // ============================================================
    // 后台位置**恰恰是**全局热键最该用的地方
    // ============================================================
    //
    // 这一个成员在界面位置上是"方便"，而在后台位置上是**这项能力成立的前提**：
    // 用户按 Ctrl+Q 时焦点在别的程序里，而一个没有界面的翻译插件要做到"选中即翻译"，
    // 它必须能在没有窗口的情况下被唤醒。换句话说，`ctx.hotkey` 是后台运行位置上
    // **唯一一个**"不是子集、而是主要用途"的能力。
    //
    // ============================================================
    // 触发是宿主 → 这里的，因此有一处与别处不同的形状
    // ============================================================
    //
    // 这一侧唯一与宿主通话的方式是 `callHost`（请求—应答），而"用户按了键"是
    // **反向**的。因此宿主用 `plugin.dispatch` 的 `hotkey` 类型派发进来（与
    // `start` / `interval` / `command` / `event` 完全同一条路，见下面的方法表），
    // 而 `subscribe` 除了登记处理函数，还要**告诉宿主"这个插件想收"** ——
    // 宿主那一侧的表决定触发时往哪几处投。
    //
    // `isAvailable()` 是同步的，因此它只能靠**本地**能知道的两件事：清单里声明了
    // 没有、以及这个进程跑在哪个平台上（`RegisterHotKey` 只在 Windows 上存在）。
    // 它与另外两个位置上的同一句话是同一条判据 —— 三处的答案必须一样，否则
    // "同一个插件换个运行位置"就会表现不同。
    hotkey: {
      isAvailable: () => hasPermission('global-hotkey') && WINDOWS,

      register: (combo) => callHost('ctx.hotkey.register', { combo: String(combo) }),

      unregister: (combo) => callHost('ctx.hotkey.unregister', { combo: String(combo) }),

      list: () => callHost('ctx.hotkey.list', {}).then((value) => value || []),

      subscribe: (handler) => {
        // `subscribe('hotkey', …)` 登记的键与宿主派发时的 `type` 逐字相同 ——
        // 对不上时处理器一个都收不到，而那是静默的。
        const release = subscribe('hotkey', handler, 'ctx.hotkey.subscribe');

        // 宿主那一侧的表按插件 id 记，因此**第一个**处理函数到来时才需要通知它。
        const list = handlers.get('hotkey') || [];
        if (list.length === 1) {
          callHost('ctx.hotkey.subscribe', {}).catch((error) => {
            // 失败**必须说出来**：插件会以为自己订阅成功了（`subscribe()` 没有抛），
            // 而宿主那边一次触发都不会来。
            process.stderr.write(
              `${LOG_PREFIX} [${pluginId}] 热键订阅没有登记成功，将收不到触发：${error}\n`
            );
          });
        }

        let released = false;
        return () => {
          // 幂等：插件把它存进 `disposables` 之后又自己调一次是常见写法。
          if (released) return;
          released = true;
          release();
          if ((handlers.get('hotkey') || []).length === 0) {
            callHost('ctx.hotkey.unsubscribe', {}).catch(() => {});
          }
        };
      },
    },

    // ---- 读取选中文本（`ctx.selection`）----
    //
    // ============================================================
    // 它在宿主那一侧会**改用户的剪贴板**
    // ============================================================
    //
    // 实现是"向前台程序合成 Ctrl+C → 读剪贴板 → 把原内容写回"（见宿主侧
    // `selection.rs` 的文件头）。因此 `read()` 的三种结果必须被分开处理：
    // `string`（读到了）、`null`（捕获成功但剪贴板上没有文本）、以及**抛错**
    // （这次捕获根本没成功）。把后两者混成 `null` 会让作者写出一个永远走不到的分支。
    selection: {
      isAvailable: () => hasPermission('read-selection') && WINDOWS,

      read: () => callHost('ctx.selection.read', {}),
    },

    // ---- 日志 ----
    logger: {
      debug: (message) => callHost('ctx.log', { level: 'debug', message: String(message) }).catch(() => {}),
      info: (message) => callHost('ctx.log', { level: 'info', message: String(message) }).catch(() => {}),
      warn: (message) => callHost('ctx.log', { level: 'warn', message: String(message) }).catch(() => {}),
      error: (message) => callHost('ctx.log', { level: 'error', message: String(message) }).catch(() => {}),
    },

    // ---- 数据 ----
    //
    // 全部经过宿主。插件在这个进程里**没有**直接的文件系统权限（子进程用
    // `--permission` 启动，只放开了它自己的代码目录），因此这里不是"多一层
    // 检查"，而是它唯一能碰数据的方式。
    storage: {
      get: (key, fallback) =>
        callHost('ctx.storage.get', { key: String(key) }).then((raw) => {
          if (raw === null || raw === undefined) return fallback;
          try {
            return JSON.parse(raw);
          } catch {
            return fallback;
          }
        }),
      set: (key, value) => callHost('ctx.storage.set', { key: String(key), value: JSON.stringify(value) }),
      delete: (key) => callHost('ctx.storage.delete', { key: String(key) }),
      keys: () => callHost('ctx.storage.keys', {}).then((value) => value || []),
      list: (options) => callHost('ctx.storage.list', options || {}),
      usage: () => callHost('ctx.storage.usage', {}),
      all: () => callHost('ctx.storage.all', {}),
      clear: () => callHost('ctx.storage.clear', {}),
    },

    // ---- 加密的密钥存储（`ctx.secrets`）----
    //
    // ============================================================
    // 后台位置**没有**别的路可走，因此这个成员必须在这里
    // ============================================================
    //
    // 后台插件落盘只有两条路：`ctx.storage`（明文 JSON，插件自己拼得出路径、
    // 而且进「插件数据」备份类别）与 `ctx.dataDir`（同样是插件自己的文件）。
    // 两者都**不是**放 API key 的地方。在 `ctx.secrets` 于此处缺失的那段时间里，
    // 一个无界面的翻译插件要把本地模型服务的令牌存下来，除了明文 `ctx.storage`
    // 没有任何选择 —— 而"把凭据写进会被备份复制走的明文文件"恰恰是这个成员
    // 存在的全部理由。它此前是这条"后台 ctx 是界面 ctx 的子集"清单里**唯一的
    // 一处缺口**，不是刻意排除：界面两处（in-process / 沙箱）都有它。
    //
    // ============================================================
    // 这里为什么一行 Rust 都不用改
    // ============================================================
    //
    // `plugins.rs` 把子进程发来的 `ctx.*` 调用剥掉前缀后交给**共用的**
    // `rpc::dispatch(app, plugin_id, None, method, args)`，而 `secrets.get/set/
    // delete/keys/clear` 五个分支早就在那张表里，权限判定走
    // `checked_secrets_dir`（`secrets` 权限 + 按插件 id 拼出的密钥目录）。
    // 也就是说这项能力在宿主侧**已经完整**，缺的只是后台这一侧把它接出去。
    // 明确写下来，是因为"看起来像 JS 一行、其实要动 Rust"是这类改动最常见的误判。
    //
    // ============================================================
    // 方法与降级：与另外两个运行位置**逐条同形**
    // ============================================================
    //
    // 六个名字与形状照抄 `sandbox-bridge.js` 的 `secrets` 与
    // `pluginRuntime.ts` 的 `pluginSecrets`：`isAvailable` / `get` / `set` /
    // `delete` / `keys` / `clear`。同一个插件换个运行位置就该拿到同一份形状，
    // 这是本项目在沙箱迁移里反复栽过的那一个坑。
    //
    // 未声明 `secrets` 权限时**降级**而不是抛在顶层：与 `storage` / `dataDir`
    // 同一条规矩（"不够就降级，而不是未知即支持"）。`get` 在降级时也返回拒绝，
    // 而不是 `null` —— `null` 是一个看起来完全正常的答案，作者会据此以为用户
    // 还没配置密钥，然后引导他重新输入一遍，而真正的原因是他没有声明权限。
    secrets: (() => {
      if (!hasPermission('secrets')) {
        /** 只提示一次：一个后台插件在 `setInterval` 里读密钥会刷爆日志。 */
        let warned = false;
        const deny = () => {
          if (!warned) {
            warned = true;
            process.stderr.write(
              `${LOG_PREFIX} [${pluginId}] 插件使用了 ctx.secrets，但清单里没有声明 ` +
                `"secrets" 权限，调用被拒绝（后续同类调用不再重复提示）\n`
            );
          }
          return Promise.reject(new Error('插件未声明 "secrets" 权限，无法读写密钥'));
        };

        return {
          /** **同步**布尔。与 `Modulith.has('secrets')` 同义，供插件做特性探测。 */
          isAvailable: () => {
            if (!warned) {
              warned = true;
              process.stderr.write(
                `${LOG_PREFIX} [${pluginId}] 插件使用了 ctx.secrets，但清单里没有声明 ` +
                  `"secrets" 权限，调用被拒绝（后续同类调用不再重复提示）\n`
              );
            }
            return false;
          },
          get: deny,
          set: deny,
          delete: deny,
          /** 空列表在这里是**如实的答案**：它一个键都拿不到 */
          keys: () => {
            if (!warned) {
              warned = true;
              process.stderr.write(
                `${LOG_PREFIX} [${pluginId}] 插件使用了 ctx.secrets，但清单里没有声明 ` +
                  `"secrets" 权限，调用被拒绝（后续同类调用不再重复提示）\n`
              );
            }
            return Promise.resolve([]);
          },
          clear: deny,
        };
      }

      // 密文落在 `<app_data_dir>/plugin_secrets/<id>.json` —— 插件数据目录
      // **之外**。因此这个进程里没有任何一条路径能拼出它（子进程只被放开读它
      // 自己的代码目录），下面这五个方法就是这项能力的**全部**入口。
      //
      // 加密强度与代价见宿主侧 `plugins/secrets.rs` 的文件头：密文由**本机硬件
      // 指纹**派生，换机器之后解不开 —— 那时 `get` 会抛错，而不是返回 `null`。
      return {
        isAvailable: () => true,
        /** 未知的键返回 `null`；密文解不开时抛错（值仍在磁盘上）。 */
        get: (key) => callHost('ctx.secrets.get', { key: String(key) }),
        set: (key, value) => callHost('ctx.secrets.set', { key: String(key), value: String(value) }),
        delete: (key) => callHost('ctx.secrets.delete', { key: String(key) }),
        /** 列出**键名**。值一个都不返回。 */
        keys: () => callHost('ctx.secrets.keys', {}).then((value) => value || []),
        /** 清空**本插件**的密钥。别的插件的密钥不受影响。 */
        clear: () => callHost('ctx.secrets.clear', {}),
      };
    })(),

    // ---- 写系统剪贴板（`ctx.clipboard.writeText`）----
    //
    // ============================================================
    // 这里**只有写入**，没有读、没有订阅 —— 三条都缺得有理由
    // ============================================================
    //
    //   * `subscribe` / `canMonitor` / `readFormats` / `readImage` 是**观察**那一半：
    //     变化由宿主进程里的 Win32 轮询看到，宿主再把它推给订阅者所在的**界面**。
    //     这个进程没有界面可以承载那条推送，也没有一条从宿主主动回到它的通道
    //     （这里只有请求—应答式的 `callHost`）。给一个永远收不到东西的 `subscribe`
    //     只会让作者以为"我订阅上了" —— 需要剪贴板历史的插件必须是界面插件。
    //   * `readText` **刻意不给**：沙箱那一侧它是 `navigator.clipboard`，而这个
    //     进程里没有 `document`。宿主这一侧要读就得再开一条 RPC，而"一个后台插件
    //     去读用户此刻的剪贴板"没有任何正当用途 —— 它连界面都没有，读到的东西
    //     只能进日志或网络，两者都是这个项目明确拒绝的方向。真要读选中文本，
    //     那件事有**专属且代价写得清清楚楚**的 `ctx.selection.read`。
    //   * `writeText` 是**唯一真正需要**的那一个：结果卡片上的按钮只回一个 action
    //     id，把结果放进剪贴板必须由插件这一侧发起。宿主为此提供了
    //     `rpc.rs` 的 `clipboard.write`（沙箱那条走浏览器 API，不经过它）。
    clipboard: {
      /** 权限已声明**且**这个平台有 Win32 剪贴板。与 `hotkey` / `selection` 同一形状。 */
      isAvailable: () => hasPermission('clipboard') && WINDOWS,

      writeText: (text) => callHost('ctx.clipboard.write', { text: String(text) }),
    },

    dataDir: {
      status: () => callHost('ctx.data.available', {}),
      list: (rel) => callHost('ctx.data.list', { rel: rel ?? '' }),
      stat: (rel) => callHost('ctx.data.stat', { rel: rel ?? '' }),
      mkdir: (rel) => callHost('ctx.data.mkdir', { rel }),
      remove: (rel) => callHost('ctx.data.remove', { rel }),
      used: () => callHost('ctx.data.used', {}),
      /**
       * 读一个文件（base64）。
       *
       * **这条路径上没有原始字节通道** —— 后台插件不经过 HTTP，它的每一句话
       * 都是一行 JSON。因此 base64 是这里唯一可用的形式，而这也正是"几百 MB
       * 的文件该由界面插件处理"的原因之一：那条路径有原始字节通道
       * （`/<id>/data/<rel>`），后台这条没有。
       */
      readBase64: (rel) => callHost('ctx.data.read', { rel }),
      writeBase64: (rel, content) => callHost('ctx.data.write', { rel, content }),
      readText: (rel) =>
        callHost('ctx.data.read', { rel }).then((base64) =>
          Buffer.from(base64, 'base64').toString('utf8')
        ),
      writeText: (rel, text) =>
        callHost('ctx.data.write', {
          rel,
          content: Buffer.from(String(text), 'utf8').toString('base64'),
        }),
    },

    http: {
      fetch: (url, options) => {
        const options0 = options || {};
        return callHost('ctx.http.fetch', {
          url,
          method: options0.method ?? 'GET',
          headers: options0.headers ?? null,
          body: options0.body ?? null,
        });
      },
    },

    settings: {
      /**
       * 全部设置值。
       *
       * 名字与 in-process / 沙箱一致（`ctx.settings.getAll`）。此前这里叫 `all`
       * —— 同一个能力在三个运行位置上出现两个名字，正是"同一个插件换个运行位置
       * 就得改代码"的来源。
       */
      getAll: () => callHost('ctx.settings.all', {}),
      /** 兼容别名，服务 `stand-up@1.x`。新代码用 `getAll`。 */
      all: () => callHost('ctx.settings.all', {}),
      get: (id, fallback) =>
        callHost('ctx.settings.all', {}).then((values) =>
          Object.prototype.hasOwnProperty.call(values || {}, id) ? values[id] : fallback
        ),
      set: (id, value) => callHost('ctx.settings.set', { id, value }),
      /**
       * 设置能力是否可用 —— 与 in-process 同一条判据（要 `storage`）。
       *
       * **这里没有 `onChange`，这是刻意不做的。** 宿主没有"设置变了"的推送通道
       * 给后台进程，而造一个永远不触发的函数比没有它更坏：作者会写
       * `onChange` 然后等一个永不到来的回调。这是后台位置与另外两个位置之间
       * **仍然存在**的一处差异，已记进 `现行问题` —— 不假装已经统一。
       */
      isAvailable: () => identity.permissions.indexOf('storage') !== -1,
    },

    notifications: {
      /**
       * 发一条应用内通知。**名字与签名与 in-process / 沙箱一致**
       * （那边是 `ctx.notifications.show(title, body, dedupeKey)`）。
       */
      show: (title, body, dedupeKey) =>
        callHost('ctx.notify', {
          title,
          body: body ?? '',
          level: 'info',
          dedupeKey: dedupeKey ?? null,
        }),

      /** 与 `show` 同一件事、同一个级别，只是名字不同 —— 与 in-process 一致。 */
      info: (title, body, dedupeKey) =>
        callHost('ctx.notify', { title, body: body ?? '', level: 'info', dedupeKey: dedupeKey ?? null }),
      success: (title, body, dedupeKey) =>
        callHost('ctx.notify', { title, body: body ?? '', level: 'success', dedupeKey: dedupeKey ?? null }),
      warn: (title, body, dedupeKey) =>
        callHost('ctx.notify', { title, body: body ?? '', level: 'warn', dedupeKey: dedupeKey ?? null }),
      error: (title, body, dedupeKey) =>
        callHost('ctx.notify', { title, body: body ?? '', level: 'error', dedupeKey: dedupeKey ?? null }),

      isAvailable: () => identity.permissions.indexOf('notification') !== -1,

      /**
       * **兼容别名，服务 `stand-up@1.x`。** 新代码用 `show`。
       *
       * 它必须留一段时间，而不是"顺手删掉"：`stand-up@1.0.1` 已经发布，用户机器上
       * 装着的就是调 `notify({...})` 的那一份。宿主先把新名字加上、插件再迁移、
       * 等 `engines.modulith` 的下界排除掉旧版本之后才删这一个 —— 这是本项目迁移
       * 沙箱运行时用过的同一套顺序（宿主先支持、插件后迁移、下限最后抬）。
       * 删早了的表现是"应用更新之后，某个用户的后台插件静默失灵"。
       */
      notify: (input) => {
        const input0 = input || {};
        return callHost('ctx.notify', {
          title: input0.title,
          body: input0.body ?? '',
          level: input0.level ?? 'info',
          dedupeKey: input0.dedupeKey ?? null,
        });
      },
    },

    launcher: {
      launch: (program, args) => callHost('ctx.system.launch', { program, args: args ?? [] }),

      /**
       * 用系统默认方式打开：快捷方式（`.lnk` / `.url`）、网址、文档、目录。
       *
       * 与 `launch` 并存而不是取代它：`launch` 走 `CreateProcess`，只认可执行
       * 映像 —— 把 `.lnk` 或网址交给它会失败（`.lnk` 会得到 `os error 193`，
       * "%1 不是有效的 Win32 应用程序"）。这一条走 shell 的关联。
       *
       * 后台插件**没有界面**，因此它把结果交出去的路本来就很窄（另一条是
       * `ctx.ui.popover`）。这个方法在这里尤其要紧。
       */
      open: (target) => callHost('ctx.system.open', { target: String(target) }),
    },

    /**
     * 宿主渲染的**结果卡片**。**后台位置上唯一的界面成员**（理由见上面 ctx 的
     * 小标题：它不需要界面上下文，而后台插件恰恰最需要一条把结果拿出来的出口）。
     *
     * 形状与 in-process / 沙箱一致：`popover({ title?, body, tone?, actions?,
     * timeoutMs?, at? })` → `{ action }`，`action` 为 `null` 表示用户没回答
     * （到点自动收起 / Escape / 点别处）。
     *
     * 参数**原样交给宿主**（`ctx.ui.popover`），校验与钳制都在那一侧：三个运行
     * 位置共用 `rpc.rs` 的同一个方法表，因此"最多 3 个按钮""id 只允许 [a-z0-9-]"
     * "给了 `timeoutMs` 才钳制到 1..60 秒"只可能有一份实现。
     *
     * **不传 `timeoutMs` 就是"一直待到用户关掉它"**（缺省），因此这一条必须走
     * `untilUserAnswers` 那条豁免 —— 理由见 `callHost`。
     */
    ui: {
      popover: (input) =>
        callHost('ctx.ui.popover', input || {}, { untilUserAnswers: true }).then((value) => ({
          // 字段缺失（更老的宿主）与宿主的 `null` 收敛成同一个取值：契约里
          // "没回答"就是一个值，不该让插件去分辨 `undefined` 与 `null`。
          action: value && value.action ? value.action : null,
        })),
    },

    shell: {
      revealInFolder: (path) => callHost('ctx.system.reveal', { path }),
    },

    events: {
      /** 与 in-process / 沙箱一致：`publish` / `subscribe`。 */
      publish: (name, payload) => callHost('ctx.events.emit', { name, payload: payload ?? null }),
      subscribe: (name, handler) => subscribe(`event:${name}`, handler, 'ctx.events.subscribe'),

      /**
       * **兼容别名，服务 `stand-up@1.x`。** 新代码用 `publish` / `subscribe`。
       * 理由与 `notifications.notify` 逐字相同 —— 已发布的插件调的是这两个名字。
       */
      emit: (name, payload) => callHost('ctx.events.emit', { name, payload: payload ?? null }),
      on: (name, handler) => subscribe(`event:${name}`, handler, 'ctx.events.on'),
    },

    disposables: {
      add: (dispose) => {
        if (typeof dispose !== 'function') {
          throw new Error('ctx.disposables.add 需要一个函数');
        }
        disposables.push(dispose);
        return dispose;
      },
      size: () => disposables.length,
    },

    /**
     * 后台事件的接收端。
     *
     * 后台插件**不能**自己决定"什么时候被唤醒"—— 那是清单里
     * `contributes.background` 的声明。这里登记的是"被唤醒之后做什么"。
     */
    background: {
      on: (type, handler) => subscribe(type, handler, 'ctx.background.on'),
    },
  };

  // ============================================================
  // 上下文
  // ============================================================
  //
  // 只放**明确需要**的东西进去。没有 `require`、没有 `import`、没有 `process`
  // —— 这些不是"忘了加"，是刻意不给。
  //
  // `ctx` 与 `Modulith` 同时给出：
  //   · `ctx` 与 in-process 插件的形状一致（那是 `Modulith.run(fn => …)` 的参数）；
  //   · `Modulith` 与沙箱界面插件的形状一致（那里读的是 `Modulith.*`）。
  // 两个名字指向**同一批函数**，因此不存在"哪一份才是真的"。

  const modulith = Object.freeze({
    plugin: Object.freeze({
      id: identity.id,
      name: identity.name,
      version: identity.version,
      runtime: 'background',
      permissions: Object.freeze(identity.permissions.slice()),
    }),
    has: (permission) => identity.permissions.indexOf(permission) !== -1,
    ...ctx,
  });

  const context = {
    // 平台入口（两份形状，同一批函数）
    ctx: Object.freeze(ctx),
    Modulith: modulith,

    // 日志。**它绝不能写 stdout**：stdout 是协议专用通道，插件的一句
    // `console.log` 混进去会让宿主把一行日志当成一条消息，然后报一句
    // "无法解析的响应" —— 而真正的原因在日志里根本看不出来。
    console: pluginConsole(pluginId),

    // 时间
    setTimeout: track(setTimeout),
    setInterval: track(setInterval),
    clearTimeout,
    clearInterval,
    setImmediate,
    queueMicrotask,
    Date,

    // 二进制与编码。后台插件处理文本时几乎一定会用到。
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
  };

  return { context, handlers, disposables, timers };
}

/** 停止一个插件上下文里的全部活动资源 */
function teardown(sandbox) {
  sandbox.timers.forEach((handle) => {
    try {
      clearTimeout(handle);
      clearInterval(handle);
    } catch {
      /* 已经清掉的句柄再清一次不是错误 */
    }
  });
  sandbox.timers.clear();

  const pending = sandbox.disposables;
  sandbox.disposables = [];
  pending.forEach((dispose) => {
    try {
      dispose();
    } catch (error) {
      process.stderr.write(`${LOG_PREFIX} 清理函数抛错：${error?.stack ?? error}\n`);
    }
  });
  return pending.length;
}

// ============================================================
// 方法表
// ============================================================

/** 方法表。未知方法返回错误，而不是静默成功。 */
const methods = {
  hello() {
    return { protocolVersion: PROTOCOL_VERSION, runtime: `node/${process.version}` };
  },

  ping() {
    return { pong: true, at: Date.now() };
  },

  status() {
    return {
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeMs: Date.now() - startedAt,
      handled,
      backgroundPlugins: plugins.size,
    };
  },

  /**
   * 加载一个后台插件。
   *
   * `entry` 是**绝对路径**，由宿主从插件目录算出来。让插件自己报路径等于把
   * "读哪个文件"交给被隔离的一方 —— 而这条路径的唯一约束来自 `--permission`，
   * 那是最后一道，不该是第一道。
   */
  'plugin.load'(params) {
    const id = params?.id;
    const entry = params?.entry;

    if (typeof id !== 'string' || id === '') {
      throw new Error('plugin.load 需要一个插件 id');
    }
    if (typeof entry !== 'string' || entry === '') {
      throw new Error('plugin.load 需要一个入口文件路径');
    }
    if (plugins.has(id)) {
      return { loaded: true, alreadyLoaded: true, id };
    }

    // 解析成真实路径：`--permission` 的放行是按真实路径比对的，而符号链接
    // 会让一个"看起来在插件目录里"的路径指向别处。
    const resolved = realpathSync(entry);
    const source = readFileSync(resolved, 'utf8');

    const identity = {
      id,
      name: params?.name ?? id,
      version: params?.version ?? '0.0.0',
      permissions: Array.isArray(params?.permissions) ? params.permissions : [],
      manifest: params?.manifest ?? null,
      activation: params?.activation ?? 'startup',
    };

    const sandbox = createPluginSandbox(identity, null);
    const context = createContext(sandbox.context);

    // 顶层同步执行。`timeout` 抓的是"入口里有死循环"这一类 —— 它拦不住
    // 异步里的死循环（那只有在事件循环里才能被发现），但那一类会让其余
    // 投递超时，宿主据此能把它停掉。
    const script = new Script(source, { filename: resolved });
    script.runInContext(context, { timeout: LOAD_TIMEOUT_MS });

    plugins.set(id, { sandbox, context, entry: resolved, loadedAt: Date.now() });
    process.stderr.write(`${LOG_PREFIX} 已加载后台插件 ${id}（${resolved}）\n`);

    return { loaded: true, id };
  },

  /**
   * 向一个已加载的插件投递一件事。
   *
   * `type` 的取值是 `start` / `interval` / `command` / `event` / `hotkey`，与清单里
   * `contributes.background` 的声明对应。返回处理器的个数 —— 为 0 说明
   * 插件没有登记这一类，那通常意味着清单声明了它却不处理，值得在宿主日志里说一句。
   *
   * `hotkey` 是唯一一个**不是**由清单声明驱动的类型：它的"什么时候"由用户按键决定，
   * 而 `payload` 是 `{ combo }`（一个插件最多能注册 4 条组合，处理函数要能分辨）。
   */
  async 'plugin.dispatch'(params) {
    const id = params?.id;
    const type = params?.type;
    if (typeof id !== 'string' || plugins.get(id) === undefined) {
      throw new Error(`plugin.dispatch：${String(id)} 没有加载`);
    }
    if (typeof type !== 'string' || type === '') {
      throw new Error('plugin.dispatch 需要一个事件类型');
    }

    const { sandbox } = plugins.get(id);
    const list = [...(sandbox.handlers.get(type) || [])];

    if (type === 'event' && typeof params?.name === 'string') {
      list.push(...(sandbox.handlers.get(`event:${params.name}`) || []));
    }

    for (const handler of list) {
      try {
        await handler(params?.payload ?? null);
      } catch (error) {
        // 一个处理器抛错不该让其余的处理器不执行 —— 那会把一次业务错误
        // 放大成"这个插件的事件全都丢了"。
        process.stderr.write(
          `${LOG_PREFIX} [${id}] ${type} 处理器抛错：${error?.stack ?? error}\n`
        );
      }
    }

    return { handled: list.length, type };
  },

  'plugin.unload'(params) {
    const id = params?.id;
    if (typeof id !== 'string') {
      throw new Error('plugin.unload 需要一个插件 id');
    }
    const loaded = plugins.get(id);
    if (loaded === undefined) {
      // 卸载一个没加载的插件不是错误：宿主可能在它崩过一次之后补发一次清理。
      return { unloaded: false, id };
    }

    const disposed = teardown(loaded.sandbox);
    plugins.delete(id);
    process.stderr.write(`${LOG_PREFIX} 已卸载后台插件 ${id}（清理函数 ${disposed} 个）\n`);
    return { unloaded: true, id, disposed };
  },

  shutdown() {
    // 响应本身由 `handleLine` 统一发出，这里只描述发生了什么。
    // 退出时机见那里的 `setImmediate` —— 立刻 `process.exit` 会把响应留在
    // 管道缓冲区里，宿主于是只能等超时。
    return { stopping: true, uptimeMs: Date.now() - startedAt };
  },
};

/** 退出前把每个插件的资源都收掉 */
function teardownEverything() {
  for (const [id, loaded] of plugins) {
    try {
      teardown(loaded.sandbox);
    } catch (error) {
      process.stderr.write(`${LOG_PREFIX} 收尾 ${id} 时抛错：${error?.stack ?? error}\n`);
    }
  }
  plugins.clear();
}

/** 处理一行输入 */
function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    // 一行解析不了**不退出**：对面可能只是写了一条垃圾，而它之后的消息仍然有效。
    // 退出会把一次格式错误升级成"后台功能永久失效"。
    //
    // 没有 id 时无法回应 —— 只记日志。
    process.stderr.write(`${LOG_PREFIX} 无法解析的一行：${error.message}\n`);
    return;
  }

  const id = typeof message?.id === 'number' ? message.id : null;
  if (id === null) {
    process.stderr.write(`${LOG_PREFIX} 消息缺少数字 id，忽略\n`);
    return;
  }

  // 版本不匹配**逐条拒绝**，而不是只在启动时检查一次：
  // 宿主可能已经在运行中被升级，而继续用旧语义解释新字段会得出错误的结论。
  if (message.v !== PROTOCOL_VERSION) {
    respond(id, {
      error:
        `协议版本不匹配：脚本是 ${PROTOCOL_VERSION}，消息是 ${message.v}。` +
        `后台宿主脚本与应用必须来自同一次发布。`,
    });
    return;
  }

  // 不带 `method` 的是**宿主对我之前某次调用的回答**，不是让我做事。
  if (message.method === undefined) {
    deliverResponse(message);
    return;
  }

  const handler = methods[message.method];
  if (typeof handler !== 'function') {
    // 未知方法必须报错。静默成功会让调用方以为"做完了"，而那是最难发现的一类错误。
    respond(id, { error: `未知方法：${String(message.method)}` });
    return;
  }

  handled += 1;

  // 方法可以是 async（`plugin.dispatch` 要 await 插件的处理器）。
  // 用 Promise.resolve 摊平两种形状，而不是要求所有方法都写成 async ——
  // 一个同步方法被写成 async 会让它的返回值多包一层 Promise，而那是
  // 一个只在特定方法上出现的差别。
  Promise.resolve()
    .then(() => handler(message.params))
    .then(
      (result) => {
        respond(id, { result });
        if (message.method === 'shutdown') {
          // 让它有机会把上面那条响应写出去再退出。
          // `setImmediate` 而不是立刻 `process.exit`：管道写入是异步的，
          // 立刻退出会把刚写的那一行留在缓冲区里 —— 宿主于是看不到响应，
          // 只能等到超时，然后报"后台宿主没有响应"，而它其实好好地停下来了。
          setImmediate(() => {
            process.stderr.write(`${LOG_PREFIX} 收到停止请求，正在退出\n`);
            teardownEverything();
            process.exit(0);
          });
        }
      },
      (error) => {
        // 方法抛错 = 业务失败，通道正常。放进 `error` 而不是让进程崩掉：
        // 一个方法的失败不该让整个后台环境消失。
        respond(id, { error: error instanceof Error ? error.message : String(error) });
      }
    );
}

// ============================================================
// 启动
// ============================================================

// 问候必须先于任何其它输出：宿主的第一行读取在等它。
write({
  v: PROTOCOL_VERSION,
  runtime: `node/${process.version}`,
  pid: process.pid,
});

process.stderr.write(
  `${LOG_PREFIX} 宿主已启动 pid=${process.pid} node=${process.version} 协议=${PROTOCOL_VERSION}\n`
);

let buffer = '';

process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
  buffer += chunk;

  // 逐行处理。最后一段可能是不完整的行，留在缓冲区里等下一次数据 ——
  // 直接按 chunk 边界切会在长消息上出错，而那种错误只在消息恰好跨过
  // 一次读取边界时出现，是最难复现的一类。
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    handleLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
  }

  // 兜底：单行过长时不让缓冲区无限增长。上限与 Rust 侧的 MAX_LINE_BYTES 一致 ——
  // 两侧不一致会让"对面为什么突然不说话了"变成一个没有线索的问题。
  if (buffer.length > 1024 * 1024) {
    process.stderr.write(`${LOG_PREFIX} 输入缓冲区超过上限，丢弃未完成的一行\n`);
    buffer = '';
  }
});

process.stdin.on('end', () => {
  // stdin 关闭 = 宿主走了。自己也退，不要留在后台变成孤儿进程。
  process.stderr.write(`${LOG_PREFIX} 标准输入已关闭，宿主退出\n`);
  teardownEverything();
  process.exit(0);
});

// 未捕获异常不能让进程静默死掉：那会让宿主等一个永远不会来的响应，
// 最后报一句"没有响应"，而真正的原因（这里）在日志里。
process.on('uncaughtException', (error) => {
  process.stderr.write(`${LOG_PREFIX} 未捕获异常：${error?.stack ?? error}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`${LOG_PREFIX} 未处理的 Promise 拒绝：${reason}\n`);
});
