// samples/reference/index.js
//
// 宿主接口参考 —— 这个插件**不提供任何功能**，它示范的是「每个核心宿主接口怎么用」。
//
// 与插件仓库里那三个完整示例的分工：
//   * 那三个是可用的插件（文本速记 / 番茄工作钟 / 快捷启动），顺便可以照着读；
//   * 这一个只做一件事：把**不需要危险权限**的接口逐个调一遍，并把「刚才调的是什么、
//     它需要哪项权限」直接显示在界面上。于是这个示例在运行时就解释了自己。
//
// **需要原生能力的接口刻意不在这里**：启动程序、提取文件图标、在文件管理器中定位、
// 接收拖入的文件、导入音频。装一个「示例插件」却要同意 process-spawn 或读文件，本身
// 就是对「权限列表是给用户看风险用的」这条原则的反面示范。想看那几项怎么写，读插件
// 仓库的 quick-launch 与 pomodoro（模块 id 分别是 com.modulith.sample.quick-launch 与
// com.modulith.sample.pomodoro）。
//
// 为什么是手写 IIFE、不用构建工具：参考实现的价值在于**可以被完整读完**。引入打包器
// 之后，「仓库里的文件」与「运行的代码」之间就多了一层配置。代价是不能写 JSX，因此
// 全部用 `React.createElement`（简写为 h）。
//
// ---------------------------------------------------------------------------
// 写这个文件时踩到的一条规矩，值得单独说：
//
// 本仓库的 `pnpm check:samples` 会按**文本**扫描这个文件里所有形如 `ctx.` 加服务名的
// 片段 —— **包括注释** —— 再与清单的 permissions 比对：
//
//   * 代码用了某能力、清单没声明 → 运行时会被拒绝，而且是用户点到那一步才发现；
//   * 清单声明了、代码里没用到 → 用户在安装确认页会看到一条并不存在的能力。
//
// 两种都算失败。所以上面那段话里我只写了接口名（launcher / icons / shell / fileDrop /
// audio），没有加 `ctx.` 前缀 —— 加了就会被算作「本插件用到了它」。
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[reference] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // createContext() 依赖「当前正在加载哪个插件」这一全局状态，因此只能在 IIFE 顶层
  // 取一次并长期持有 —— 放进组件的渲染函数里调用会抛错。
  var ctx = Modulith.createContext();

  /** 存储键。只允许字母数字与 . _ -，最长 128 字符 */
  var KEY_COUNT = 'count';

  /** 事件主题名。小写字母、数字、点、连字符、下划线，最长 64 字符 */
  var TOPIC = 'reference.tick';

  /** 演示用的窗口级快捷键（配合 Ctrl+Shift）。真实插件要挑一个宿主没占用的组合 */
  var HOTKEY = 'e';

  /** 一次最多显示多少条调用记录 */
  var MAX_RECEIPTS = 12;

  /** 四条通知共用的合并键，用来演示「同一条信息反复发生时不刷屏」 */
  var NOTIFY_DEDUPE_KEY = 'reference-demo';

  // ============================================================
  // 组件
  // ============================================================

  function Reference() {
    // 本模块当前是否真的对用户可见。标签页保活意味着模块被切走后**不会卸载**，
    // 因此窗口级监听、定时器这类东西必须看这个值。
    var active = Modulith.useModuleActive();

    // 首帧是 null 而不是 0：计数要从存储里异步读出来。用 0 作为初值会让每次打开
    // 都先闪一个错误的 0，再跳成真实值。
    var countState = React.useState(null);
    var count = countState[0];
    var setCount = countState[1];

    // 「调用记录」是本插件唯一的界面状态。它不是日志：日志走 ctx.logger 去控制台，
    // 而正式版没有开发者工具，用户看不到。这一份是给**读者**看的。
    var receiptsState = React.useState([]);
    var receipts = receiptsState[0];
    var setReceipts = receiptsState[1];

    // 收到的事件条数。只装本插件时它**永远是 0** —— 原因见下面「事件」那一节。
    var heardState = React.useState(0);
    var heard = heardState[0];
    var setHeard = heardState[1];

    /** 记一条调用记录，并往控制台写一条日志 */
    function note(text) {
      var at = new Date().toLocaleTimeString();
      // 用函数式更新而不是读 receipts：闭包捕获的可能是旧数组，连续两次点击会丢一条。
      setReceipts(function (prev) {
        return [{ at: at, text: text }].concat(prev).slice(0, MAX_RECEIPTS);
      });
      ctx.logger.info('[reference] ' + text);
    }

    // ---- 存储：读 ----
    React.useEffect(function () {
      // 组件可能在读回来之前被卸载（用户切走标签页），因此用一个标志位避免
      // 对已卸载的组件 setState。
      var alive = true;

      ctx.storage
        .get(KEY_COUNT, 0)
        .then(function (saved) {
          if (!alive) return;
          // 读取时逐字段兜底：用户的数据只有一份，读失败等于数据全丢。
          setCount(typeof saved === 'number' && isFinite(saved) ? saved : 0);
        })
        .catch(function (err) {
          ctx.logger.warn('读取计数失败', err);
          if (alive) setCount(0);
        });

      return function () {
        alive = false;
      };
    }, []);

    // ---- 事件：订阅 ----
    React.useEffect(function () {
      // 订阅会自动归属到本插件（宿主用插件 ID 做来源标记），因此插件被禁用或卸载时
      // 宿主会一次性摘掉它的全部订阅。返回的取消函数仍然有用：组件卸载时主动收回。
      var off = ctx.events.subscribe(TOPIC, function (event) {
        setHeard(function (prev) {
          return prev + 1;
        });
        // 这个回调闭包捕获的是首帧的 note，而 note 只做函数式 setState，
        // 因此不会写出过期数据。
        note('收到来自「' + event.source + '」的 ' + event.topic);
      });

      return off;
    }, []);

    // ---- 窗口级监听：必须判断模块是否可见 ----
    React.useEffect(function () {
      // 少了这一行，在**别的模块**里按同一个组合键也会触发本插件的行为。
      // 这是插件最容易犯、又最难自查的一类错误：开发时你总在这个模块里测试。
      if (!active) return undefined;

      function onKeyDown(event) {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === HOTKEY) {
          event.preventDefault();
          note('窗口级快捷键 Ctrl+Shift+' + HOTKEY.toUpperCase() + '（只在模块可见时生效）');
        }
      }

      window.addEventListener('keydown', onKeyDown);
      return function () {
        window.removeEventListener('keydown', onKeyDown);
      };
    }, [active]);

    // ---- 动作 ----

    function increment() {
      var next = (count || 0) + 1;
      // 先更新界面再落盘：写盘可能失败（磁盘满、权限），但那不该让按钮看起来没反应。
      setCount(next);
      ctx.storage
        .set(KEY_COUNT, next)
        .then(function () {
          note('ctx.storage.set("' + KEY_COUNT + '", ' + next + ') —— 需要 storage');
        })
        .catch(function (err) {
          ctx.logger.warn('保存计数失败', err);
          note('storage.set 失败：' + describe(err));
        });
    }

    function resetCount() {
      setCount(0);
      ctx.storage
        .delete(KEY_COUNT)
        .then(function () {
          note('ctx.storage.delete("' + KEY_COUNT + '") —— 数据随插件卸载一并删除');
        })
        .catch(function (err) {
          note('storage.delete 失败：' + describe(err));
        });
    }

    function notify(level) {
      // 未声明 notification 权限时接口仍然存在，但调用会被忽略（只警告一次）。
      // 因此不要靠"调用了却什么也没发生"来判断，直接用 isAvailable() 问。
      var available = ctx.notifications.isAvailable();

      ctx.notifications[level](
        '示例通知（' + level + '）',
        '这条来自参考插件。四条按钮共用同一个 dedupeKey，因此未读时会被合并成一条。',
        NOTIFY_DEDUPE_KEY
      );

      note(
        'ctx.notifications.' +
          level +
          '(…) —— ' +
          (available ? '需要 notification（已声明）' : '未声明 notification，调用被忽略')
      );
    }

    function publish() {
      ctx.events.publish(TOPIC, { at: Date.now() });
      note(
        'ctx.events.publish("' + TOPIC + '") —— 需要 plugin-communicate；' +
          '本插件不会收到它（原因见下）'
      );
    }

    // ---- 渲染 ----

    if (count === null) {
      return h('div', { className: 'rf-root' }, h('p', { className: 'rf-muted' }, '正在读取…'));
    }

    return h(
      'div',
      { className: 'rf-root' },
      h('h1', { className: 'rf-title' }, '宿主接口参考'),
      h(
        'p',
        { className: 'rf-lead' },
        '这个插件不做任何有用的事 —— 它把不需要危险权限的核心接口逐个调一遍，' +
          '并把每次调用用到的接口与它需要的权限记在下面。'
      ),

      // ---- 模块注册与上下文 ----
      card(
        '模块注册与上下文',
        h(
          'p',
          { className: 'rf-muted' },
          '这两件事都只在插件加载期能做一次：createContext() 取到本插件的上下文，' +
            'registerModule() 声明一个模块。它们必须在 IIFE 顶层**同步**调用 —— ' +
            '宿主在加载结束后立即检查注册结果，放进 Promise 或 setTimeout 里会被判定为' +
            '「没有注册任何模块」。'
        )
      ),

      // ---- 存储 ----
      card(
        'ctx.storage —— 需要 storage',
        h(
          'p',
          { className: 'rf-value' },
          '已记住 ',
          h('strong', null, String(count)),
          ' 次'
        ),
        h(
          'p',
          { className: 'rf-muted' },
          '按插件 ID 隔离的持久化存储，值会经过 JSON 序列化（对象、数组都能存）。' +
            '与 localStorage 的关键差别：卸载插件时数据一并删除，不会永久残留。'
        ),
        h(
          'div',
          { className: 'rf-actions' },
          button('记一次', increment, 'rf-btn rf-btn--primary'),
          button('清空存储', resetCount)
        )
      ),

      // ---- 通知 ----
      card(
        'ctx.notifications —— 需要 notification',
        h(
          'p',
          { className: 'rf-muted' },
          '只有应用内通知（右下角浮层 + 通知中心），没有系统级通知。' +
            '四个按钮共用同一个 dedupeKey：未读时会被**合并成一条**，浮层也只在第一条弹出 —— ' +
            '这正是宿主给「同一条信息反复发生」准备的机制，没有它，一个重试循环就能把通知刷满。'
        ),
        h(
          'div',
          { className: 'rf-actions' },
          button('info', function () { notify('info'); }),
          button('success', function () { notify('success'); }),
          button('warn', function () { notify('warn'); }),
          button('error', function () { notify('error'); })
        )
      ),

      // ---- 事件 ----
      card(
        'ctx.events —— 需要 plugin-communicate',
        h('p', { className: 'rf-value' }, '已收到 ', h('strong', null, String(heard)), ' 条事件'),
        h(
          'p',
          { className: 'rf-muted' },
          '发布 / 订阅是给**插件之间**用的：模块之间要通信应当走宿主的事件总线，' +
            '而不是互相去读对方的存储。'
        ),
        h(
          'p',
          { className: 'rf-warn' },
          '只装本插件时，上面的「已收到」永远是 0 —— 这不是坏了。' +
            '宿主默认不让插件收到自己发布的事件（receiveOwn 默认 false）：' +
            '否则「发布之后由自己订阅来更新界面」会绕一圈回到自己，' +
            '处理函数里再发布同一主题就成了死循环。需要自己处理自己时应当直接改状态，' +
            '而不是绕经事件总线。'
        ),
        h('div', { className: 'rf-actions' }, button('发布一个事件', publish))
      ),

      // ---- 快捷键与日志 ----
      card(
        '窗口级监听与 ctx.logger',
        h(
          'p',
          { className: 'rf-muted' },
          '本模块监听 Ctrl+Shift+' +
            HOTKEY.toUpperCase() +
            '。窗口级监听（keydown、拖放）**必须**用 useModuleActive() 判断模块是否可见 —— ' +
            '标签页保活意味着切走不会卸载，少了这个判断就会在别的模块里抢键。' +
            '当前状态：' +
            (active ? '可见，监听已开启' : '不可见，监听已移除') +
            '。'
        ),
        h(
          'p',
          { className: 'rf-muted' },
          'ctx.logger 的输出去控制台（开发者工具），用户看不到。要让人看见，用通知；' +
            '要留下痕迹，写进存储。上面每次操作都记了一条日志与一条调用记录。'
        )
      ),

      // ---- 调用记录 ----
      card(
        '调用记录',
        receipts.length === 0
          ? h('p', { className: 'rf-muted' }, '点上面的按钮，这里会显示刚才调用了什么。')
          : h(
              'ul',
              { className: 'rf-log' },
              receipts.map(function (item, index) {
                return h(
                  'li',
                  { key: String(index) + item.at, className: 'rf-log__row' },
                  h('span', { className: 'rf-log__time' }, item.at),
                  h('span', { className: 'rf-log__text' }, item.text)
                );
              })
            )
      )
    );
  }

  // ============================================================
  // 小工具
  // ============================================================

  /** 一张卡片：标题 + 内容 */
  function card(title, body) {
    return h(
      'section',
      { className: 'rf-card' },
      h('h2', { className: 'rf-card__title' }, title),
      body
    );
  }

  /** 按钮。onClick 直接传函数，不要写成 onClick={fn()} —— 那会在渲染时立刻执行 */
  function button(label, onClick, className) {
    return h(
      'button',
      { type: 'button', className: className || 'rf-btn', onClick: onClick },
      label
    );
  }

  /** 把任意错误整理成一句话，避免界面上出现 [object Object] */
  function describe(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message ? String(err.message) : String(err);
  }

  // ============================================================
  // 加载期：注册模块与命令
  // ============================================================

  // **必须在加载期同步调用。** 宿主在一次加载结束后立即检查注册结果，
  // 放进 Promise 或 setTimeout 里会被判定为「没有注册任何模块」。
  Modulith.registerModule({
    id: 'reference',
    name: '宿主接口参考',
    description: '逐个示范核心宿主接口的用法',
    icon: 'BookOpen',
    priority: 95,
    component: Reference,
  });

  // 把一个动作注册进全局搜索框。与 registerModule 一样只能在加载期调用 ——
  // 命令要归属到具体的插件，而「当前正在加载哪个插件」只有加载期才有确定值。
  // 宿主会加上 plugin:<插件 ID>: 前缀，因此插件卸载时能一次性摘掉它注册的全部命令。
  Modulith.registerCommand({
    id: 'reference-notify',
    title: '参考插件：发一条示例通知',
    subtitle: '演示 registerCommand —— 命令会出现在全局搜索里',
    keywords: ['reference', '示例', '参考'],
    icon: 'BookOpen',
    run: function () {
      // 命令从搜索框触发时，本模块可能根本没有打开，因此这里不能依赖组件状态 ——
      // 能用的是加载期取到的 ctx。
      ctx.notifications.info(
        '来自全局搜索',
        '你在搜索框里触发了参考插件注册的命令。',
        'reference-command'
      );
      ctx.logger.info('[reference] 全局搜索命令被触发');
    },
  });

  ctx.logger.info('宿主接口参考插件加载完成');
})();
