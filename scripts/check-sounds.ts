// scripts/check-sounds.ts
//
// 通知提示音的验证脚本
//
//   node scripts/check-sounds.ts
//
// 这个脚本存在的理由是：**音色好不好听没有人能替用户判断，但"能不能响、
// 会不会爆音、是不是偏轻"是可以自动判断的。** 而音效恰恰是最容易"看起来对、
// 实际不响"的一类代码 —— 一个写错的节点名、一个传 0 的指数衰减、
// 一个过小的峰值，在类型检查里全部合法，只有真的播出来才知道。
//
// 因此这里用一个桩音频上下文**真的执行一遍**每种音色的合成代码，检查它排出来的
// 事件流。桩上下文只实现代码实际用到的那几个方法（见 utils/notificationSounds.ts
// 里那套最小结构类型），所以它还能顺带发现"用了某个上下文不支持的方法"。
//
// 四类断言：
//   1. 音色表本身（id 合法、默认值三处一致、回退规则）
//   2. 数值参数的范围（频率、峰值、起振、衰减）—— 这一节把「音量不能太小」
//      变成一条硬断言：每个音的峰值必须落在 [0.5, 1.0]
//   3. 合成事件流的形状（都 start 了、都 stop 了、包络从 0 起、指数衰减目标为正）
//   4. 峰值归一化的**数学**：分音再多，一个音的峰值也恰好等于它声明的 gain

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_SOUNDS,
  CUSTOM_SOUND_ID,
  DEFAULT_NOTIFICATION_SOUND_ID,
  DEFAULT_SOUND_VOLUME,
  ENVELOPE_FLOOR,
  MAX_SOUND_VOLUME,
  MIN_SOUND_VOLUME,
  clampSoundVolume,
  isValidSoundId,
  renderSound,
  resolveSoundId,
  soundIds,
  strike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioParamLike,
  type BiquadLike,
  type GainLike,
  type OscillatorLike,
  type SoundNote,
} from '../src/utils/notificationSounds.ts';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let total = 0;

function check(condition: boolean, label: string): void {
  total += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}`);
  }
}

function read(relative: string): string {
  return readFileSync(join(PROJECT_ROOT, relative), 'utf-8');
}

// ============================================================
// 音色的两个来源
//
// 内置音色自 1.3.2 起有两类，**它们的断言完全不同**：
//   · 现场合成（`notes` 有值）：可以检查频率、包络、分音与峰值归一化；
//   · 打包音效（`bundled`）：声音来自一个音频文件，这里能验证的只有
//     "文件在、被引用、走的是 `<audio>` 那一支"，听感与音量无法自动判断。
//
// 混在一起检查会得到两种坏结果之一：对打包音效跑合成断言（必然失败），
// 或者把它从循环里悄悄跳过（于是 `sound.notes` 的可选性失去意义）。
// ============================================================

type SynthSound = (typeof BUILTIN_SOUNDS)[number] & { notes: readonly SoundNote[] };

/** 需要现场合成的音色 */
const synth = BUILTIN_SOUNDS.filter((s): s is SynthSound => s.notes !== undefined);
/** 声音来自随应用发布的音频文件的音色 */
const bundled = BUILTIN_SOUNDS.filter((s) => s.bundled === true);

/** 打包音效的资产路径（相对仓库根） */
const BUNDLED_ASSET = 'src/assets/notification.mp3';

// ============================================================
// 桩音频上下文
// ============================================================

interface ParamEvent {
  method: 'set' | 'linear' | 'exponential';
  value: number;
  time: number;
}

class FakeParam implements AudioParamLike {
  value = 0;
  readonly events: ParamEvent[] = [];

  setValueAtTime(value: number, time: number): unknown {
    this.events.push({ method: 'set', value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): unknown {
    this.events.push({ method: 'linear', value, time });
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): unknown {
    // 真实实现会对 0 抛错。桩里显式复现这条约束，让"衰减到 0"这种写法
    // 在脚本里就炸掉，而不是等到用户听不到声音才发现。
    if (value === 0) {
      throw new Error('exponentialRampToValueAtTime 不接受目标值 0');
    }
    this.events.push({ method: 'exponential', value, time });
    this.value = value;
    return this;
  }
}

class FakeNode implements AudioNodeLike {
  readonly kind: string;
  readonly outputs: FakeNode[] = [];

  constructor(kind: string) {
    this.kind = kind;
  }

  connect(destination: AudioNodeLike): unknown {
    this.outputs.push(destination as FakeNode);
    return destination;
  }
}

class FakeOscillator extends FakeNode implements OscillatorLike {
  type = 'sine';
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;

  constructor() {
    super('oscillator');
  }

  start(when = 0): void {
    if (this.startedAt !== null) throw new Error('振荡器被启动了两次');
    this.startedAt = when;
  }

  stop(when = 0): void {
    if (this.stoppedAt !== null) throw new Error('振荡器被停止了两次');
    this.stoppedAt = when;
  }
}

class FakeGain extends FakeNode implements GainLike {
  readonly gain = new FakeParam();

  constructor() {
    super('gain');
  }
}

class FakeFilter extends FakeNode implements BiquadLike {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();

  constructor() {
    super('filter');
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  sampleRate = 48000;
  destination: AudioNodeLike = new FakeNode('destination');
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  readonly filters: FakeFilter[] = [];

  createOscillator(): OscillatorLike {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node;
  }

  createGain(): GainLike {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }

  createBiquadFilter(): BiquadLike {
    const node = new FakeFilter();
    this.filters.push(node);
    return node;
  }

  reset(): void {
    this.oscillators.length = 0;
    this.gains.length = 0;
    this.filters.length = 0;
  }
}

function allEvents(param: FakeParam): ParamEvent[] {
  return param.events;
}

// ============================================================
// 1. 音色表
// ============================================================

console.log('音色表：');

const ids = BUILTIN_SOUNDS.map((s) => s.id);
check(BUILTIN_SOUNDS.length >= 3, `内置音色 ${BUILTIN_SOUNDS.length} 种（至少 3 种才有得选）`);
check(new Set(ids).size === ids.length, '音色 id 不重复');
check(ids.every(isValidSoundId), '每个音色 id 都符合格式（小写字母 / 数字 / 连字符）');

check(
  BUILTIN_SOUNDS.some((s) => s.id === DEFAULT_NOTIFICATION_SOUND_ID),
  `默认音色 ${DEFAULT_NOTIFICATION_SOUND_ID} 确实存在`
);
check(
  DEFAULT_NOTIFICATION_SOUND_ID === BUILTIN_SOUNDS[0].id,
  '默认音色就是列表第一个（后端与前端回退到的是同一个）'
);
check(
  !ids.includes(CUSTOM_SOUND_ID) && soundIds().includes(CUSTOM_SOUND_ID),
  `${CUSTOM_SOUND_ID} 是保留 id，不与内置音色冲突`
);
check(
  synth.length >= 3 && synth.every((s) => s.notes.length > 0),
  `每种合成音色至少有一个音（合成音色 ${synth.length} 种、打包音效 ${bundled.length} 种）`
);
check(
  BUILTIN_SOUNDS.every((s) => (s.bundled === true) !== (s.notes !== undefined)),
  '每个内置音色恰好属于一种来源：打包的音效文件，或现场合成'
);
check(bundled.length === 1, `打包音效恰好一个（实得 ${bundled.length}）`);
check(
  bundled.length === 1 && bundled[0].id === DEFAULT_NOTIFICATION_SOUND_ID,
  '默认音色就是那个打包音效'
);
check(
  bundled.every((s) => s.notes === undefined),
  '打包音效不声明音符（写了也不会被合成，只会让人以为它在合成）'
);

console.log('\n回退规则：');

check(resolveSoundId('nope', false) === DEFAULT_NOTIFICATION_SOUND_ID, '未知 id → 默认音色');
check(resolveSoundId(undefined, false) === DEFAULT_NOTIFICATION_SOUND_ID, '缺字段 → 默认音色');
check(resolveSoundId('drop', false) === 'drop', '已知 id → 原样返回');
check(
  resolveSoundId(CUSTOM_SOUND_ID, false) === DEFAULT_NOTIFICATION_SOUND_ID,
  '选了自定义但没有文件 → 回退到默认（而不是静默不出声）'
);
check(resolveSoundId(CUSTOM_SOUND_ID, true) === CUSTOM_SOUND_ID, '有文件时自定义生效');

// ============================================================
// 2. 数值参数范围
// ============================================================

console.log('\n参数范围：');

const MIN_FREQ = 80;
const MAX_FREQ = 8000;
/**
 * 一个音色的**主音**峰值下限。
 *
 * 低于它听起来就是「太轻」—— 这正是本次需求点名要避免的。
 * 判据按音色而不是按单个音：一个音色里的伴随音（例如柔和木音的五度泛音）
 * 本就该比主音低，那是配器，不是音量失控。
 */
const MIN_PEAK = 0.5;
/** 单个音（含伴随音）的峰值下限，比 MIN_PEAK 宽松 */
const MIN_NOTE_PEAK = 0.25;
const MAX_PEAK = 1.0;
/** 一个音色全部音在同一时刻的瞬时振幅上限。超过它压缩器就会介入 */
const MAX_TOTAL_PEAK = 1.0;

let freqOk = true;
let peakOk = true;
let envelopeOk = true;
let partialOk = true;
let durationOk = true;
let loudnessOk = true;
const problems: string[] = [];

function durationOf(note: SoundNote): number {
  const longest = note.partials.reduce((max, p) => Math.max(max, note.decay * p.decayScale), 0);
  return note.at + note.attack + longest;
}

for (const sound of synth) {
  for (const [index, note] of sound.notes.entries()) {
    const where = `${sound.id}[${index}]`;

    if (note.freq < MIN_FREQ || note.freq > MAX_FREQ) {
      freqOk = false;
      problems.push(`${where} 基频 ${note.freq} 越界`);
    }
    if (note.sweepTo !== undefined && (note.sweepTo < MIN_FREQ || note.sweepTo > MAX_FREQ)) {
      freqOk = false;
      problems.push(`${where} 滑音目标 ${note.sweepTo} 越界`);
    }

    if (note.gain < MIN_NOTE_PEAK || note.gain > MAX_PEAK) {
      peakOk = false;
      problems.push(`${where} 峰值 ${note.gain} 不在 [${MIN_NOTE_PEAK}, ${MAX_PEAK}]`);
    }

    // 起振：太短会"啪"一声，太长会糊掉瞬态
    if (note.attack < 0.002 || note.attack > 0.03) {
      envelopeOk = false;
      problems.push(`${where} 起振 ${note.attack}s 不在 [0.002, 0.03]`);
    }
    if (note.decay < 0.06 || note.decay > 2.0) {
      envelopeOk = false;
      problems.push(`${where} 衰减 ${note.decay}s 不在 [0.06, 2.0]`);
    }

    if (note.partials.length === 0) {
      partialOk = false;
      problems.push(`${where} 没有分音`);
    }
    for (const partial of note.partials) {
      if (partial.ratio < 0.5 || partial.ratio > 12) {
        partialOk = false;
        problems.push(`${where} 分音倍率 ${partial.ratio} 越界`);
      }
      if (!(partial.gain > 0) || partial.gain > 1) {
        partialOk = false;
        problems.push(`${where} 分音强度 ${partial.gain} 越界`);
      }
      if (!(partial.decayScale > 0) || partial.decayScale > 1) {
        partialOk = false;
        problems.push(`${where} 分音衰减比例 ${partial.decayScale} 越界`);
      }
    }

    if (durationOf(note) > 2.5) {
      durationOk = false;
      problems.push(`${where} 时长 ${durationOf(note).toFixed(2)}s 超过 2.5s`);
    }
  }
}

check(freqOk, '基频与滑音目标都在人耳可行的范围内');
check(peakOk, `每个音的峰值都在 [${MIN_NOTE_PEAK}, ${MAX_PEAK}]`);
check(envelopeOk, '起振与衰减时长都在合理区间');
check(partialOk, '分音倍率、强度与衰减比例都合法');
check(durationOk, '没有超长的音（提示音不该拖住用户）');

/**
 * 一个音在时刻 t 的包络值**上界**。
 *
 * 与 `strike()` 里的包络同形，但按**最慢的那个分音**（decayScale = 1）衰减；
 * 实际每个分音各自衰减得更快，因此这是一个恒成立的保守上界。
 * 分音求和后的峰值恰好等于 `note.gain`（由 `strike()` 归一化保证），
 * 所以上界的起点也是对的。
 *
 * 为什么需要它：`pulse` 这类音是**显著重叠**的（三个音间隔 75ms，衰减 0.3s）。
 * 把各音的 gain 直接相加会得到 2.4 这种吓人的数字，但那一刻前两个音实际上早已
 * 衰减到听不见。真正要守的不变量是「任何时刻瞬时振幅之和不超过 1.0」——
 * 越过了压缩器就会介入，把起振压扁（听感是"这一下没力气"）。
 */
function envelopeBound(note: SoundNote, t: number): number {
  const u = t - note.at;
  if (u <= 0) return 0;
  if (u < note.attack) return note.gain * (u / note.attack);
  const v = u - note.attack;
  if (v > note.decay) return 0;
  return note.gain * Math.pow(ENVELOPE_FLOOR / note.gain, v / note.decay);
}

/** 一个音色在整段时长里的瞬时振幅峰值（按 1ms 采样） */
function peakOf(sound: SynthSound): number {
  const end = Math.max(...sound.notes.map(durationOf)) + 0.05;
  let max = 0;
  for (let t = 0; t <= end; t += 0.001) {
    let sum = 0;
    for (const note of sound.notes) sum += envelopeBound(note, t);
    if (sum > max) max = sum;
  }
  return max;
}

for (const sound of synth) {
  const peak = peakOf(sound);
  const loudest = Math.max(...sound.notes.map((n) => n.gain));

  if (loudest < MIN_PEAK) {
    loudnessOk = false;
    problems.push(`${sound.id} 主音峰值 ${loudest} 低于 ${MIN_PEAK}（听起来会太轻）`);
  }
  if (peak > MAX_TOTAL_PEAK) {
    loudnessOk = false;
    problems.push(
      `${sound.id} 瞬时振幅峰值 ${peak.toFixed(3)} 超过 ${MAX_TOTAL_PEAK}（压缩器会介入并压扁起振）`
    );
  }
}
check(
  loudnessOk,
  `每个音色的主音峰值 ≥ ${MIN_PEAK} 且瞬时峰值 ≤ ${MAX_TOTAL_PEAK}（前者是「别太轻」，后者是「别把压缩器逼出来」）`
);
if (problems.length > 0) {
  console.error(`      问题：\n      ${problems.join('\n      ')}`);
}

// ============================================================
// 3. 合成事件流
// ============================================================

console.log('\n合成事件流：');

for (const sound of synth) {
  const ctx = new FakeContext();
  let threw = '';
  try {
    renderSound(ctx, ctx.destination, sound.id);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }

  if (threw) {
    check(false, `${sound.id} 合成不抛错（实际：${threw}）`);
    continue;
  }

  const oscillators = ctx.oscillators;
  check(oscillators.length > 0, `${sound.id} 至少排了一个振荡器`);

  const expected = sound.notes.reduce((sum, n) => sum + n.partials.length, 0);
  check(
    oscillators.length === expected,
    `${sound.id} 振荡器数等于分音总数（${oscillators.length}/${expected}）`
  );

  const started = oscillators.every((o) => o.startedAt !== null);
  const stopped = oscillators.every((o) => o.stoppedAt !== null);
  check(started && stopped, `${sound.id} 每个振荡器都被 start 与 stop（漏 stop 会一直占着音频线程）`);

  const ordered = oscillators.every(
    (o) => (o.startedAt ?? 0) < (o.stoppedAt ?? 0)
  );
  check(ordered, `${sound.id} 停止时间晚于启动时间`);

  const finite = oscillators.every(
    (o) =>
      Number.isFinite(o.frequency.value) &&
      Number.isFinite(o.startedAt) &&
      Number.isFinite(o.stoppedAt) &&
      allEvents(o.frequency).every((e) => Number.isFinite(e.value))
  );
  check(finite, `${sound.id} 没有 NaN / Infinity 参与调度`);

  // 包络：必须从 0 起振，必须有一条上行 ramp 与一条指数衰减
  const envelopesOk = ctx.gains.every((g) => {
    const events = allEvents(g.gain);
    const first = events[0];
    const hasRise = events.some((e) => e.method === 'linear' && e.value > 0);
    const hasFall = events.some(
      (e) => e.method === 'exponential' && Math.abs(e.value - ENVELOPE_FLOOR) < 1e-12
    );
    return first !== undefined && first.method === 'set' && first.value === 0 && hasRise && hasFall;
  });
  check(
    envelopesOk,
    `${sound.id} 包络从 0 起振并指数衰减（从非零起步会有一声"啪"）`
  );

  const noZeroRamp = ctx.gains.every((g) =>
    allEvents(g.gain).every((e) => e.method !== 'exponential' || e.value > 0)
  );
  check(noZeroRamp, `${sound.id} 指数衰减的目标都不为 0（真实实现会抛错）`);

  // 低通只在声明的音色上出现
  const expectsFilter = sound.notes.some((n) => n.lowpass !== undefined);
  check(
    ctx.filters.length === (expectsFilter ? sound.notes.filter((n) => n.lowpass !== undefined).length : 0),
    `${sound.id} 低通滤波器的个数与声明一致`
  );
}

// ============================================================
// 4. 峰值归一化的数学
// ============================================================

console.log('\n峰值归一化：');

{
  const ctx = new FakeContext();
  const spec: SoundNote = {
    at: 0,
    freq: 440,
    gain: 0.8,
    decay: 0.5,
    attack: 0.004,
    type: 'sine',
    partials: [
      { ratio: 1, gain: 1, decayScale: 1 },
      { ratio: 2.76, gain: 0.2, decayScale: 0.44 },
      { ratio: 5.4, gain: 0.09, decayScale: 0.24 },
    ],
  };

  strike(ctx, ctx.destination, spec);

  const peaks = ctx.gains.map((g) =>
    allEvents(g.gain)
      .filter((e) => e.method === 'linear')
      .reduce((max, e) => Math.max(max, e.value), 0)
  );
  const summed = peaks.reduce((sum, p) => sum + p, 0);

  // 三个分音：1 + 0.2 + 0.09 = 1.29，归一化后各分音峰值之和应当恰好等于 gain
  check(
    Math.abs(summed - spec.gain) < 1e-9,
    `分音峰值之和等于声明的 gain（${summed.toFixed(6)} vs ${spec.gain}）——否则"换音色就换了音量"`
  );
  check(
    peaks.length === spec.partials.length,
    '每个分音一条独立的增益包络'
  );
  check(
    Math.abs(Math.max(...peaks) - (spec.gain * 1) / 1.29) < 1e-9,
    '最强分音拿到最大的一份（基频）'
  );
}

// ============================================================
// 5. 音量
// ============================================================

console.log('\n音量：');

check(clampSoundVolume(0.5) === 0.5, '区间内的值原样保留');
check(clampSoundVolume(-1) === MIN_SOUND_VOLUME, '低于下限被夹到下限');
check(clampSoundVolume(2) === MAX_SOUND_VOLUME, '高于上限被夹到上限');
check(clampSoundVolume(Number.NaN) === DEFAULT_SOUND_VOLUME, 'NaN 回落到默认值');
check(clampSoundVolume('0.5') === DEFAULT_SOUND_VOLUME, '非数字回落到默认值');
check(
  DEFAULT_SOUND_VOLUME > MIN_SOUND_VOLUME,
  '默认音量不是 0 —— 默认静音等于这个功能不存在'
);

// ============================================================
// 6. 前后端镜像
// ============================================================

console.log('\n前后端一致性：');

const rustSettings = read('src-tauri/src/modules/settings/settings.rs');

const rustDefaultId = /pub const DEFAULT_NOTIFICATION_SOUND_ID: &str = "([^"]+)";/.exec(
  rustSettings
)?.[1];
check(
  rustDefaultId === DEFAULT_NOTIFICATION_SOUND_ID,
  `默认音色 id 前后端一致（Rust「${rustDefaultId}」vs TS「${DEFAULT_NOTIFICATION_SOUND_ID}」）`
);

const rustVolume = (name: string): number | undefined => {
  const match = new RegExp(`pub const ${name}: f32 = ([\\d.]+);`).exec(rustSettings);
  return match ? Number(match[1]) : undefined;
};
check(rustVolume('MIN_NOTIFICATION_SOUND_VOLUME') === MIN_SOUND_VOLUME, '音量下限前后端一致');
check(rustVolume('MAX_NOTIFICATION_SOUND_VOLUME') === MAX_SOUND_VOLUME, '音量上限前后端一致');
check(
  rustVolume('DEFAULT_NOTIFICATION_SOUND_VOLUME') === DEFAULT_SOUND_VOLUME,
  '默认音量前后端一致'
);

const rustIdLen = /pub const MAX_SOUND_ID_LEN: usize = (\d+);/.exec(rustSettings)?.[1];
check(rustIdLen === '32', '音效 id 长度上限前后端一致（TS 侧是 32）');
check(
  /pub fn is_valid_sound_id\(/.test(rustSettings) &&
    /b\.is_ascii_lowercase\(\) \|\| b\.is_ascii_digit\(\) \|\| b == b'-'/.test(rustSettings),
  '后端音效 id 校验用的字符集与前端 /^[a-z0-9-]+$/ 相同'
);

// 命令必须真的注册进生成产物里，否则前端 invoke 会得到「命令不存在」
const libRs = read('src-tauri/src/lib.rs');
check(libRs.includes('pick_notification_sound'), 'lib.rs 注册了 pick_notification_sound');
check(libRs.includes('load_notification_sound'), 'lib.rs 注册了 load_notification_sound');

// ============================================================
// 7. 前端接线
// ============================================================

console.log('\n前端接线：');

const appSettings = read('src/services/appSettings.ts');
check(/notificationSoundEnabled: boolean;/.test(appSettings), 'appSettings 有 notificationSoundEnabled');
check(/notificationSoundId: string;/.test(appSettings), 'appSettings 有 notificationSoundId');
check(
  /notificationSoundCustomFile: string \| null;/.test(appSettings),
  'appSettings 有 notificationSoundCustomFile'
);
check(/notificationSoundVolume: number;/.test(appSettings), 'appSettings 有 notificationSoundVolume');
check(
  /notificationSoundEnabled: raw\?\.notificationSoundEnabled !== false/.test(appSettings),
  'normalize 只在显式 false 时关闭提示音（缺字段必须落到默认的「开」）'
);
check(
  /notificationSoundVolume: clampSoundVolume\(/.test(appSettings),
  'normalize 会夹取音量'
);

// 声音与浮层必须挂在同一个函数里 —— 分开判断迟早会出现"弹了但没响"
const notifications = read('src/services/notifications.ts');
check(
  /function presentNotification\([\s\S]*?showToast\(input\);[\s\S]{0,120}playNotificationSound\(\);/.test(
    notifications
  ),
  '浮层与提示音在同一个函数里成对出现'
);
check(
  (notifications.match(/presentNotification\(/g) ?? []).length === 3,
  '两处调用点 + 一处定义（新增调用点必须落在 silent / willMerge 的早退之后）'
);

check(
  read('src/main.tsx').includes('primeSound()'),
  'main.tsx 在启动早期安装音频解锁监听'
);
check(
  read('src/components/Settings/SettingsDialog.tsx').includes('<NotificationSettings'),
  '设置里挂着「通知」分页'
);
check(
  read('src/components/Settings/NotificationSettings.tsx').includes('previewSound'),
  '通知分页提供试听'
);

// ============================================================
// 8. 打包音效：文件、引用与播放分支
//
// 这一类断言针对的失败方式与合成音色**完全不同**：合成音色写错参数会静默不响，
// 而打包音效写错的表现是"资源没被打进产物"或"播放走进了合成那一支"——
// 两者都不会让构建或类型检查变红。
// ============================================================

console.log('\n打包音效：');

const assetPath = join(PROJECT_ROOT, BUNDLED_ASSET);
check(existsSync(assetPath), `资产文件存在：${BUNDLED_ASSET}`);

if (existsSync(assetPath)) {
  const bytes = statSync(assetPath).size;
  check(bytes > 1024, `资产不是空文件（${bytes} 字节）`);
  // 它会随每一个安装包分发，因此体积本身是一条约束
  check(bytes < 2 * 1024 * 1024, `资产体积可接受（${bytes} 字节，上限 2 MB）`);
}

const soundService = read('src/services/sound.ts');
check(
  soundService.includes("from '../assets/notification.mp3'"),
  'sound.ts 用 import 引用资产（而不是运行期拼路径 —— 拼错的路径只会在运行时静默无声）'
);
check(
  /function playById\(/.test(soundService),
  'sound.ts 有唯一的分发函数 playById（三支：打包文件 / 自定义文件 / 现场合成）'
);
check(
  /isBundledSound\(resolved\)[\s\S]{0,200}playClip\(bundledSoundUrl/.test(soundService),
  '打包音效走 <audio> 那一支（交给 renderSound 会静默什么都不播）'
);
// 走 fetch 会被 netGuard 当成一次出站尝试记进流量日志 —— 而它读的是随应用
// 发布的本地文件，既不是出站，也不该受出站策略约束。CSP 的 media-src 覆盖它。
check(
  !/fetch\([^)]*notification\.mp3/.test(soundService),
  '打包音效用 <audio> 读取，而不是 fetch（后者会被 netGuard 记成出站）'
);
check(
  !/notificationSoundId:\s*BUILTIN_SOUNDS\[0\]\.id/.test(
    read('src/components/Settings/NotificationSettings.tsx')
  ),
  '设置页用常量而不是数组下标表达默认音色（下标会在有人调整顺序时静默改变语义）'
);

if (failed > 0) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部 ${total} 项通过`);
