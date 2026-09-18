// samples/pomodoro/index.js
//
// 番茄工作钟 —— Modulith 示例插件。
//
// 它示范的是另外几件事：
//   1. **计时核心放在 React 之外**（本文件顶部的 `core` 与那个 200ms 定时器）。
//      这样即使从未打开过这个模块，计时与提醒照样发生 —— 番茄钟的全部意义就是
//      「你去干别的，到点提醒你」。如果计时挂在组件里，模块没挂载就什么都不会发生。
//   2. **通知**（`ctx.notifications`，需 `notification` 权限）。
//   3. **自定义提示音**（`ctx.audio`，需 `filesystem-read` 权限）。默认提示音是
//      用 WebAudio 现场合成的，因此插件包里**不需要带任何音频资源**；用户也可以
//      导入自己的音频文件替换。
//
// 为什么是手写 IIFE：示例的价值在于可读、可复制。代价是不能用 JSX，
// 因此全部用 `React.createElement`（简写为 `h`）。
//
// 本示例以 MIT 许可提供，欢迎直接复制作为你自己插件的起点。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[pomodoro] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  var ctx = Modulith.createContext();

  // ============================================================
  // 常量与默认值
  // ============================================================

  var KEY_SETTINGS = 'settings';
  var KEY_TIMER = 'timer';
  var KEY_STATS = 'stats';

  var TICK_MS = 200;

  /** 三个阶段的元信息。`rise` 只用于选默认提示音的上行/下行 */
  var PHASES = {
    focus: { label: '专注', short: '专注', rise: false, tone: 'focus' },
    short: { label: '短休息', short: '短休', rise: true, tone: 'break' },
    long: { label: '长休息', short: '长休', rise: true, tone: 'break' },
  };

  var SOUND_MODES = [
    { id: 'default', label: '默认提示音' },
    { id: 'custom', label: '自定义音频' },
    { id: 'mute', label: '静音' },
  ];

  function defaultSettings() {
    return {
      version: 1,
      // 时长（分钟）
      focusMin: 25,
      shortMin: 5,
      longMin: 15,
      /** 每完成几个专注进入长休息 */
      longEvery: 4,
      /** 阶段结束后是否自动开始下一段 */
      autoStartBreak: true,
      autoStartFocus: false,
      /** 结束时是否发应用内通知 */
      notify: true,
      /** 音量 0..1 */
      volume: 0.6,
      /** 每个「阶段结束」事件的提示音设置 */
      sounds: {
        focusEnd: { mode: 'default', name: '', dataUrl: '' },
        breakEnd: { mode: 'default', name: '', dataUrl: '' },
      },
      /** 当前在做的任务，纯展示 */
      task: '',
    };
  }

  function defaultTimer() {
    return {
      version: 1,
      phase: 'focus',
      status: 'idle', // idle | running | paused
      /** running 时的结束时刻（毫秒时间戳） */
      endsAt: 0,
      /** idle / paused 时剩余毫秒 */
      remaining: 25 * 60 * 1000,
      /** 本轮已完成的专注数（用于判断何时长休息） */
      cycle: 0,
    };
  }

  function defaultStats() {
    return { version: 1, date: todayKey(), todayFocus: 0, totalFocus: 0 };
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function clamp01(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  /** 分钟数收敛到 1..180 的整数 */
  function clampMinutes(value, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return n < 1 ? 1 : n > 180 ? 180 : n;
  }

  function clampEvery(value, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return n < 2 ? 2 : n > 12 ? 12 : n;
  }

  // ============================================================
  // 设置 / 状态整理
  // ============================================================

  function normalizeSound(raw) {
    var sound = { mode: 'default', name: '', dataUrl: '' };
    if (raw && typeof raw === 'object') {
      if (SOUND_MODES.some(function (m) { return m.id === raw.mode; })) sound.mode = raw.mode;
      if (typeof raw.name === 'string') sound.name = raw.name;
      if (typeof raw.dataUrl === 'string') sound.dataUrl = raw.dataUrl;
    }
    // 选了「自定义」却没有数据，等同于没配 —— 否则到点会静默失败
    if (sound.mode === 'custom' && !sound.dataUrl) sound.mode = 'default';
    return sound;
  }

  function normalizeSettings(raw) {
    var out = defaultSettings();
    if (!raw || typeof raw !== 'object') return out;

    out.focusMin = clampMinutes(raw.focusMin, out.focusMin);
    out.shortMin = clampMinutes(raw.shortMin, out.shortMin);
    out.longMin = clampMinutes(raw.longMin, out.longMin);
    out.longEvery = clampEvery(raw.longEvery, out.longEvery);
    out.autoStartBreak = raw.autoStartBreak !== false;
    out.autoStartFocus = raw.autoStartFocus === true;
    out.notify = raw.notify !== false;
    out.volume = clamp01(raw.volume === undefined ? out.volume : raw.volume);
    out.task = typeof raw.task === 'string' ? raw.task : '';
    out.sounds = {
      focusEnd: normalizeSound(raw.sounds && raw.sounds.focusEnd),
      breakEnd: normalizeSound(raw.sounds && raw.sounds.breakEnd),
    };
    return out;
  }

  function normalizeTimer(raw) {
    var out = defaultTimer();
    if (!raw || typeof raw !== 'object') return out;

    if (raw.phase === 'focus' || raw.phase === 'short' || raw.phase === 'long') out.phase = raw.phase;
    if (raw.status === 'running' || raw.status === 'paused' || raw.status === 'idle') out.status = raw.status;
    if (typeof raw.endsAt === 'number') out.endsAt = raw.endsAt;
    if (typeof raw.remaining === 'number' && raw.remaining >= 0) out.remaining = raw.remaining;
    if (typeof raw.cycle === 'number' && raw.cycle >= 0) out.cycle = Math.floor(raw.cycle);

    // 关窗期间到点的：无法补发提醒（应用没在跑），按「已结束、待开始」处理，
    // 而不是让它显示成负数的倒计时。
    if (out.status === 'running' && out.endsAt <= Date.now()) {
      out.status = 'idle';
      out.remaining = 0;
    }
    return out;
  }

  function normalizeStats(raw) {
    var out = defaultStats();
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.date === 'string') out.date = raw.date;
    if (typeof raw.todayFocus === 'number') out.todayFocus = Math.max(0, Math.floor(raw.todayFocus));
    if (typeof raw.totalFocus === 'number') out.totalFocus = Math.max(0, Math.floor(raw.totalFocus));
    // 跨天则今日计数归零
    if (out.date !== todayKey()) {
      out.date = todayKey();
      out.todayFocus = 0;
    }
    return out;
  }

  // ============================================================
  // 计时核心（React 之外）
  // ============================================================

  var core = {
    settings: defaultSettings(),
    timer: defaultTimer(),
    stats: defaultStats(),
    ready: false,
  };

  var listeners = new Set();

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        console.error('[pomodoro] 订阅者抛出异常，已隔离:', e);
      }
    });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return function () {
      listeners.delete(fn);
    };
  }

  /** 某个阶段的完整时长（毫秒） */
  function phaseDuration(phase) {
    var s = core.settings;
    var minutes = phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortMin : s.longMin;
    return minutes * 60 * 1000;
  }

  /**
   * 剩余毫秒。
   *
   * **始终由 `endsAt` 与当前时间算出**，而不是每个 tick 减一次 ——
   * 后者会在窗口被后台节流、系统休眠或标签保活暂停时越走越慢，
   * 而用户对番茄钟的期待是「墙上时钟走了 25 分钟」。
   */
  function remainingMs() {
    var t = core.timer;
    if (t.status === 'running') {
      if (!t.endsAt) return 0;
      return Math.max(0, t.endsAt - Date.now());
    }
    return Math.max(0, t.remaining);
  }

  function persistSettings() {
    ctx.storage.set(KEY_SETTINGS, core.settings).catch(function (e) {
      console.warn('[pomodoro] 保存设置失败:', e);
    });
  }

  /** 设置变更的防抖落盘（数字框、滑块、任务名这类高频改动走这条路） */
  var persistSettingsTimer = null;

  function schedulePersistSettings() {
    if (persistSettingsTimer) window.clearTimeout(persistSettingsTimer);
    persistSettingsTimer = window.setTimeout(function () {
      persistSettingsTimer = null;
      persistSettings();
    }, 500);
  }

  function persistTimer() {
    ctx.storage.set(KEY_TIMER, core.timer).catch(function (e) {
      console.warn('[pomodoro] 保存计时状态失败:', e);
    });
  }

  function persistStats() {
    ctx.storage.set(KEY_STATS, core.stats).catch(function (e) {
      console.warn('[pomodoro] 保存统计失败:', e);
    });
  }

  // ---- 提示音 ----

  /**
   * 共用的 AudioContext。
   *
   * 浏览器的自动播放策略要求音频必须由用户手势「解锁」。计时器到点时用户可能
   * 正在别的模块里，没有新手势可用 —— 因此在用户点「开始」时先解锁一次，
   * 之后的到点播放就不会被拒绝。
   */
  var audioCtx = null;

  function ensureAudio() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try {
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    } catch (e) {
      return null;
    }
    return audioCtx;
  }

  /** 默认提示音：两个正弦音，上行表示进入专注、下行表示该休息 */
  function playChime(rise) {
    var ac = ensureAudio();
    if (!ac) return;

    var notes = rise ? [783.99, 1046.5] : [659.25, 523.25];
    var volume = Math.max(0.0002, clamp01(core.settings.volume));
    var now = ac.currentTime;

    notes.forEach(function (freq, index) {
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var t0 = now + index * 0.16;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.42);

      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    });
  }

  function playCustom(dataUrl) {
    try {
      var audio = new window.Audio(dataUrl);
      audio.volume = clamp01(core.settings.volume);
      var played = audio.play();
      if (played && played.catch) {
        played.catch(function (e) {
          console.warn('[pomodoro] 自定义提示音播放被拒绝:', e);
        });
      }
    } catch (e) {
      console.warn('[pomodoro] 自定义提示音播放失败:', e);
    }
  }

  /**
   * 播放某个「阶段结束」事件的提示音。
   *
   * 专注结束用下行音（放松），休息结束用上行音（回到工作）——
   * 不看界面也能从音调听出接下来是什么。
   */
  function playSound(kind) {
    var sound = core.settings.sounds[kind];
    if (!sound || sound.mode === 'mute') return;
    if (sound.mode === 'custom' && sound.dataUrl) {
      playCustom(sound.dataUrl);
      return;
    }
    playChime(kind === 'breakEnd');
  }

  // ---- 通知 ----

  function notify(title, body) {
    if (!core.settings.notify) return;
    if (!ctx.notifications.isAvailable()) return;
    // 不传 dedupeKey：每次阶段结束都是一条独立记录，不该被合并计数
    ctx.notifications.show(title, body).catch(function (e) {
      console.warn('[pomodoro] 发送通知失败:', e);
    });
  }

  // ---- 状态迁移 ----

  function start() {
    ensureAudio(); // 借这次用户手势解锁音频
    var t = core.timer;
    var remaining = remainingMs();
    if (remaining <= 0) remaining = phaseDuration(t.phase);
    core.timer = Object.assign({}, t, {
      status: 'running',
      endsAt: Date.now() + remaining,
      remaining: remaining,
    });
    persistTimer();
    emit();
  }

  function pause() {
    var t = core.timer;
    if (t.status !== 'running') return;
    var remaining = remainingMs();
    core.timer = Object.assign({}, t, { status: 'paused', remaining: remaining, endsAt: 0 });
    persistTimer();
    emit();
  }

  function reset() {
    var t = core.timer;
    core.timer = Object.assign({}, t, {
      status: 'idle',
      endsAt: 0,
      remaining: phaseDuration(t.phase),
    });
    persistTimer();
    emit();
  }

  function setPhase(phase) {
    core.timer = Object.assign({}, core.timer, {
      phase: phase,
      status: 'idle',
      endsAt: 0,
      remaining: phaseDuration(phase),
    });
    persistTimer();
    emit();
  }

  /**
   * 推进到下一阶段。
   *
   * `completed` 为真表示这一段是**自然走完**的，才计入统计与轮次 ——
   * 手动跳过不该被当成「完成了一个番茄」。
   */
  function advance(completed) {
    var t = core.timer;
    var wasFocus = t.phase === 'focus';
    var cycle = t.cycle;

    if (wasFocus && completed) {
      var previousDate = core.stats.date;
      core.stats = {
        version: 1,
        date: todayKey(),
        todayFocus: (previousDate === todayKey() ? core.stats.todayFocus : 0) + 1,
        totalFocus: core.stats.totalFocus + 1,
      };
      persistStats();
      cycle = cycle + 1;
    }

    var next;
    if (wasFocus) {
      next = cycle >= core.settings.longEvery ? 'long' : 'short';
    } else {
      // 长休息结束，轮次归零
      if (t.phase === 'long') cycle = 0;
      next = 'focus';
    }

    var autoStart = wasFocus ? core.settings.autoStartBreak : core.settings.autoStartFocus;
    var duration = phaseDuration(next);

    core.timer = {
      version: 1,
      phase: next,
      status: autoStart ? 'running' : 'idle',
      endsAt: autoStart ? Date.now() + duration : 0,
      remaining: duration,
      cycle: cycle,
    };
    persistTimer();

    // 提示音与通知在状态更新之后发，保证用户看到的与听到的一致
    var finished = PHASES[t.phase];
    var upcoming = PHASES[next];
    var soundKind = wasFocus ? 'focusEnd' : 'breakEnd';
    playSound(soundKind);
    notify(
      finished.label + '结束',
      '接下来是' + upcoming.label + ' · ' + (next === 'focus' ? core.settings.focusMin : next === 'short' ? core.settings.shortMin : core.settings.longMin) + ' 分钟'
    );

    emit();
  }

  function complete() {
    advance(true);
  }

  function skip() {
    advance(false);
  }

  // ---- 载入 + 心跳 ----

  Promise.all([
    ctx.storage.get(KEY_SETTINGS, null),
    ctx.storage.get(KEY_TIMER, null),
    ctx.storage.get(KEY_STATS, null),
  ])
    .then(function (values) {
      core.settings = normalizeSettings(values[0]);
      core.timer = normalizeTimer(values[1]);
      core.stats = normalizeStats(values[2]);

      // 时长设置可能在上次退出后被改过，非运行状态下把剩余时间对齐到当前设置，
      // 否则会出现「界面显示 25:00、实际按旧的 30 分钟结束」这种对不上的情况
      if (core.timer.status !== 'running') {
        var full = phaseDuration(core.timer.phase);
        core.timer = Object.assign({}, core.timer, {
          remaining:
            core.timer.status === 'idle' ? full : Math.min(core.timer.remaining, full),
        });
      }

      core.ready = true;
      emit();
    })
    .catch(function (e) {
      console.warn('[pomodoro] 读取已保存状态失败，使用默认值:', e);
      core.ready = true;
      emit();
    });

  /**
   * 心跳：**在模块之外运行**，因此即使用户从未打开过这个模块，计时与提醒照样发生。
   *
   * 只在「显示的秒数」变化时才通知订阅者 —— 否则每秒会触发五次重渲染。
   */
  var lastShownSecond = -1;

  window.setInterval(function () {
    if (core.timer.status !== 'running') return;

    var remaining = remainingMs();
    if (remaining <= 0) {
      complete();
      return;
    }
    var seconds = Math.ceil(remaining / 1000);
    if (seconds !== lastShownSecond) {
      lastShownSecond = seconds;
      emit();
    }
  }, TICK_MS);

  // ============================================================
  // 设置更新（供界面调用）
  // ============================================================

  function updateSettings(patch, options) {
    core.settings = Object.assign({}, core.settings, patch);
    // 数字输入框与滑块的每一次变动都立刻写盘太浪费，改成防抖落盘；
    // 但**必须真的落盘** —— 只是「先不写」而不是「不写」。
    if (options && options.persist === false) schedulePersistSettings();
    else persistSettings();

    // 改时长时，若当前不在运行中，剩余时间要同步（否则界面显示 25 分钟、
    // 实际却按旧的 30 分钟结束，两边对不上）
    if (core.timer.status !== 'running' && patchTouchesDuration(patch)) {
      core.timer = Object.assign({}, core.timer, {
        remaining: phaseDuration(core.timer.phase),
      });
      persistTimer();
    }
    emit();
  }

  function patchTouchesDuration(patch) {
    return (
      Object.prototype.hasOwnProperty.call(patch, 'focusMin') ||
      Object.prototype.hasOwnProperty.call(patch, 'shortMin') ||
      Object.prototype.hasOwnProperty.call(patch, 'longMin')
    );
  }

  function updateSound(kind, patch) {
    var sounds = Object.assign({}, core.settings.sounds);
    sounds[kind] = normalizeSound(Object.assign({}, sounds[kind], patch));
    updateSettings({ sounds: sounds });
  }

  // ============================================================
  // 界面
  // ============================================================

  function formatClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function ProgressRing(props) {
    var radius = 92;
    var circumference = 2 * Math.PI * radius;
    var progress = props.total > 0 ? 1 - props.remaining / props.total : 0;
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;

    return h(
      'div',
      { className: 'pm-ring' },
      h(
        'svg',
        { viewBox: '0 0 200 200', className: 'pm-ring-svg', 'aria-hidden': 'true' },
        h('circle', {
          cx: 100,
          cy: 100,
          r: radius,
          className: 'pm-ring-track',
          fill: 'none',
          strokeWidth: 10,
        }),
        h('circle', {
          cx: 100,
          cy: 100,
          r: radius,
          className: 'pm-ring-fill pm-ring-' + props.phase,
          fill: 'none',
          strokeWidth: 10,
          strokeLinecap: 'round',
          strokeDasharray: circumference,
          strokeDashoffset: circumference * (1 - progress),
          transform: 'rotate(-90 100 100)',
        })
      ),
      h(
        'div',
        { className: 'pm-ring-center' },
        h('span', { className: 'pm-clock' }, formatClock(props.remaining)),
        h('span', { className: 'pm-phase' }, PHASES[props.phase].label),
        props.status === 'paused' ? h('span', { className: 'pm-badge' }, '已暂停') : null
      )
    );
  }

  function NumberField(props) {
    return h(
      'label',
      { className: 'pm-field' },
      h('span', { className: 'pm-field-label' }, props.label),
      h('input', {
        className: 'pm-input pm-input-num',
        type: 'number',
        min: props.min,
        max: props.max,
        value: props.value,
        onChange: function (e) {
          props.onChange(e.target.value);
        },
      }),
      props.hint ? h('span', { className: 'pm-field-hint' }, props.hint) : null
    );
  }

  function Toggle(props) {
    return h(
      'label',
      { className: 'pm-toggle' },
      h('input', {
        type: 'checkbox',
        checked: props.checked,
        onChange: function (e) {
          props.onChange(e.target.checked);
        },
      }),
      h(
        'span',
        { className: 'pm-toggle-text' },
        h('span', { className: 'pm-toggle-label' }, props.label),
        props.hint ? h('span', { className: 'pm-field-hint' }, props.hint) : null
      )
    );
  }

  /** 一组「阶段结束提示音」的设置 */
  function SoundEditor(props) {
    var sound = props.sound;
    var busyPair = React.useState(false);
    var busy = busyPair[0];
    var setBusy = busyPair[1];

    function importFile() {
      setBusy(true);
      ctx.audio
        .pick()
        .then(function (picked) {
          setBusy(false);
          if (!picked) return; // 用户取消
          props.onChange({ mode: 'custom', name: picked.name, dataUrl: picked.dataUrl });
        })
        .catch(function (e) {
          setBusy(false);
          props.onError('导入音频失败：' + e);
        });
    }

    return h(
      'div',
      { className: 'pm-sound' },
      h('div', { className: 'pm-sound-head' }, props.label),
      h(
        'div',
        { className: 'pm-sound-row' },
        h(
          'select',
          {
            className: 'pm-input pm-select',
            value: sound.mode,
            onChange: function (e) {
              var mode = e.target.value;
              // 已经有自定义音频时切回「自定义」不必重新导入
              if (mode === 'custom' && !sound.dataUrl) {
                importFile();
                return;
              }
              props.onChange({ mode: mode });
            },
          },
          SOUND_MODES.map(function (m) {
            return h('option', { key: m.id, value: m.id }, m.label);
          })
        ),
        h(
          'button',
          {
            className: 'pm-btn pm-btn-ghost',
            type: 'button',
            onClick: function () {
              ensureAudio();
              props.onPreview();
            },
          },
          '试听'
        ),
        h(
          'button',
          {
            className: 'pm-btn pm-btn-ghost',
            type: 'button',
            disabled: busy,
            onClick: importFile,
          },
          busy ? '选择中…' : sound.dataUrl ? '更换音频' : '导入音频'
        )
      ),
      sound.mode === 'custom' && sound.name
        ? h(
            'div',
            { className: 'pm-sound-file' },
            h('span', { className: 'pm-sound-name', title: sound.name }, sound.name),
            h(
              'button',
              {
                className: 'pm-icon-btn',
                type: 'button',
                title: '移除自定义音频',
                onClick: function () {
                  props.onChange({ mode: 'default', name: '', dataUrl: '' });
                },
              },
              '×'
            )
          )
        : null
    );
  }

  function Pomodoro() {
    var versionPair = React.useState(0);
    var setVersion = versionPair[0];
    var setVersionState = versionPair[1];

    var errorPair = React.useState('');
    var error = errorPair[0];
    var setError = errorPair[1];

    // 订阅 React 之外的计时核心
    React.useEffect(function () {
      return subscribe(function () {
        setVersionState(function (n) {
          return n + 1;
        });
      });
    }, []);

    var settings = core.settings;
    var timer = core.timer;
    var stats = core.stats;

    var total = phaseDuration(timer.phase);
    var remaining = remainingMs();

    // ---- 控制 ----
    function onStartPause() {
      if (timer.status === 'running') pause();
      else start();
    }

    function onSkip() {
      skip();
    }

    function onReset() {
      reset();
    }

    function onNotifyTest() {
      ensureAudio();
      if (!ctx.notifications.isAvailable()) {
        setError('未获得通知权限，无法发送通知（清单里需要声明 notification）');
        return;
      }
      setError('');
      ctx.notifications.show('番茄工作钟 · 测试通知', '如果你看到这条，说明提醒工作正常。');
    }

    // ---- 渲染 ----
    // 轮次圆点：填满的个数 = 本轮已完成的专注数
    var cycleDots = [];
    var every = settings.longEvery;
    var inCycle = timer.cycle % every;
    // cycle 正好是 every 的倍数且大于 0，说明刚集满一轮（正处于长休息）
    var filled = timer.cycle > 0 && inCycle === 0 ? every : inCycle;
    for (var i = 0; i < every; i++) {
      cycleDots.push(
        h('span', { key: 'dot-' + i, className: 'pm-dot' + (i < filled ? ' pm-dot-done' : '') })
      );
    }

    var controls = h(
      'div',
      { className: 'pm-controls' },
      h(
        'button',
        { className: 'pm-btn pm-btn-primary', type: 'button', onClick: onStartPause },
        timer.status === 'running' ? '暂停' : timer.status === 'paused' ? '继续' : '开始'
      ),
      h('button', { className: 'pm-btn pm-btn-ghost', type: 'button', onClick: onSkip }, '跳过'),
      h('button', { className: 'pm-btn pm-btn-ghost', type: 'button', onClick: onReset }, '重置')
    );

    var phaseTabs = h(
      'div',
      { className: 'pm-tabs', role: 'group', 'aria-label': '阶段' },
      ['focus', 'short', 'long'].map(function (phase) {
        return h(
          'button',
          {
            key: phase,
            type: 'button',
            className: 'pm-tab' + (timer.phase === phase ? ' pm-tab-active' : ''),
            onClick: function () {
              setPhase(phase);
            },
          },
          PHASES[phase].label
        );
      })
    );

    var timerCard = h(
      'div',
      { className: 'pm-card pm-timer-card' },
      phaseTabs,
      h(ProgressRing, {
        phase: timer.phase,
        status: timer.status,
        remaining: remaining,
        total: total,
      }),
      controls,
      h('input', {
        className: 'pm-input pm-task',
        type: 'text',
        placeholder: '这一段在做什么？（可留空）',
        value: settings.task,
        onChange: function (e) {
          updateSettings({ task: e.target.value }, { persist: false });
        },
      }),
      h(
        'div',
        { className: 'pm-stats' },
        h(
          'div',
          { className: 'pm-stat' },
          h('span', { className: 'pm-stat-value' }, String(stats.todayFocus)),
          h('span', { className: 'pm-stat-label' }, '今日完成')
        ),
        h(
          'div',
          { className: 'pm-stat' },
          h('span', { className: 'pm-stat-value' }, String(stats.totalFocus)),
          h('span', { className: 'pm-stat-label' }, '累计完成')
        ),
        h(
          'div',
          { className: 'pm-stat' },
          h('div', { className: 'pm-dots', title: '距离长休息' }, cycleDots),
          h('span', { className: 'pm-stat-label' }, '每 ' + every + ' 个后长休息')
        )
      )
    );

    var settingsCard = h(
      'div',
      { className: 'pm-card pm-settings' },
      h('h2', { className: 'pm-card-title' }, '设置'),

      h(
        'div',
        { className: 'pm-grid3' },
        h(NumberField, {
          label: '专注（分）',
          value: settings.focusMin,
          min: 1,
          max: 180,
          onChange: function (v) {
            updateSettings({ focusMin: clampMinutes(v, settings.focusMin) }, { persist: false });
          },
        }),
        h(NumberField, {
          label: '短休息（分）',
          value: settings.shortMin,
          min: 1,
          max: 180,
          onChange: function (v) {
            updateSettings({ shortMin: clampMinutes(v, settings.shortMin) }, { persist: false });
          },
        }),
        h(NumberField, {
          label: '长休息（分）',
          value: settings.longMin,
          min: 1,
          max: 180,
          onChange: function (v) {
            updateSettings({ longMin: clampMinutes(v, settings.longMin) }, { persist: false });
          },
        })
      ),

      h(
        'div',
        { className: 'pm-grid2' },
        h(NumberField, {
          label: '长休息间隔',
          value: settings.longEvery,
          min: 2,
          max: 12,
          hint: '每完成几个专注后进入长休息',
          onChange: function (v) {
            updateSettings({ longEvery: clampEvery(v, settings.longEvery) }, { persist: false });
          },
        })
      ),

      h('div', { className: 'pm-divider' }),

      h(Toggle, {
        label: '阶段结束自动开始下一段',
        hint: '专注结束自动进入休息',
        checked: settings.autoStartBreak,
        onChange: function (v) {
          updateSettings({ autoStartBreak: v });
        },
      }),
      h(Toggle, {
        label: '休息结束自动开始专注',
        checked: settings.autoStartFocus,
        onChange: function (v) {
          updateSettings({ autoStartFocus: v });
        },
      }),
      h(Toggle, {
        label: '结束时发送应用内通知',
        hint: ctx.notifications.isAvailable()
          ? '不需要打开本模块也会收到'
          : '未获得通知权限，通知不会发出',
        checked: settings.notify,
        onChange: function (v) {
          updateSettings({ notify: v });
        },
      }),

      h('div', { className: 'pm-divider' }),

      h(
        'div',
        { className: 'pm-volume' },
        h('span', { className: 'pm-field-label' }, '音量'),
        h('input', {
          className: 'pm-slider',
          type: 'range',
          min: 0,
          max: 100,
          value: Math.round(settings.volume * 100),
          onChange: function (e) {
            updateSettings({ volume: clamp01(Number(e.target.value) / 100) }, { persist: false });
          },
        }),
        h('span', { className: 'pm-volume-value' }, Math.round(settings.volume * 100) + '%')
      ),

      h(SoundEditor, {
        label: '专注结束时',
        sound: settings.sounds.focusEnd,
        onError: setError,
        onChange: function (patch) {
          updateSound('focusEnd', patch);
        },
        onPreview: function () {
          var sound = core.settings.sounds.focusEnd;
          if (sound.mode === 'mute') return;
          if (sound.mode === 'custom' && sound.dataUrl) playCustom(sound.dataUrl);
          else playChime(false);
        },
      }),
      h(SoundEditor, {
        label: '休息结束时',
        sound: settings.sounds.breakEnd,
        onError: setError,
        onChange: function (patch) {
          updateSound('breakEnd', patch);
        },
        onPreview: function () {
          var sound = core.settings.sounds.breakEnd;
          if (sound.mode === 'mute') return;
          if (sound.mode === 'custom' && sound.dataUrl) playCustom(sound.dataUrl);
          else playChime(true);
        },
      }),

      h(
        'div',
        { className: 'pm-settings-foot' },
        h(
          'button',
          { className: 'pm-btn pm-btn-ghost', type: 'button', onClick: onNotifyTest },
          '测试通知 + 提示音'
        ),
        h(
          'button',
          {
            className: 'pm-btn pm-btn-ghost',
            type: 'button',
            onClick: function () {
              if (!window.confirm('恢复全部设置为默认值？当前的自定义提示音会被清除。')) return;
              core.settings = defaultSettings();
              persistSettings();
              emit();
            },
          },
          '恢复默认'
        )
      )
    );

    var banner = error
      ? h(
          'div',
          { className: 'pm-error', role: 'alert' },
          h('span', { className: 'pm-error-text' }, error),
          h(
            'button',
            {
              className: 'pm-error-close',
              type: 'button',
              title: '关闭',
              onClick: function () {
                setError('');
              },
            },
            '×'
          )
        )
      : null;

    if (!core.ready) {
      return h('div', { className: 'pm-root' }, h('div', { className: 'pm-empty' }, '读取中…'));
    }

    return h(
      'div',
      { className: 'pm-root' },
      h(
        'div',
        { className: 'pm-head' },
        h('h1', { className: 'pm-title' }, '番茄工作钟'),
        h(
          'span',
          { className: 'pm-head-note' },
          '计时在后台运行，不需要停在这一页'
        )
      ),
      banner,
      h('div', { className: 'pm-body' }, timerCard, settingsCard)
    );
  }

  Modulith.registerModule({
    id: 'pomodoro',
    name: '番茄工作钟',
    description: '专注 / 休息循环计时，支持自定义提示音与提醒',
    icon: 'Timer',
    priority: 75,
    component: Pomodoro,
  });
})();
