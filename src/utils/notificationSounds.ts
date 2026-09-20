// src/utils/notificationSounds.ts
//
// 通知提示音的**音色定义**与合成逻辑。
//
// ---------------------------------------------------------------------------
// 为什么这一层是纯的（不碰 window / AudioContext 构造函数）
//
// 它只接收调用方传进来的音频上下文（`AudioContextLike`）并往上挂节点。因此
// `scripts/check-sounds.ts` 可以用一个桩上下文在 Node 里**真的跑一遍**每种音效，
// 并检查它排出来的包络 —— 这是唯一能自动验证「音量不过小、起振不爆音、
// 频率不为零」的手段，因为音色好不好听没有人能替用户听。
//
// 这也是为什么下面自己声明了一套最小的结构类型而不是用 DOM 的
// `AudioContext` / `OscillatorNode`：本文件要被 `tsconfig.node.json`（lib 只有
// ES2022）引用，那里没有 DOM 类型。做法与 `theme.ts` 的纯逻辑被抽到
// `motionPreference.ts` 是同一个理由。
//
// ---------------------------------------------------------------------------
// 音色设计取向
//
// 要求是「有特色、好听、清晰、不偏轻」。对应的四条具体做法：
//
// 1. **不用纯正弦短促蜂鸣。** 那种声音刺耳且廉价。这里用**加性合成的敲击音**
//    （钟 / 马林巴），靠泛音堆出音色与「金属感 / 木质感的区别」，而不是靠调大音量。
// 2. **峰值按分音自动归一化。** 见 `strike()`：无论一种音色用几个分音，
//    它的峰值都等于表里写的 `gain`。少了这一步，分音多的音色会自动变响、
//    分音少的变轻，「换个音色音量就变了」。
// 3. **起振 3~14ms、释放用指数衰减。** 起振太长会糊、太短会「啪」的一声；
//    指数衰减接近真实发声体的能量耗散，听感自然。
// 4. **音程选协和音程**（纯五度、大三度），而不是随便挑两个频率。两个音之间
//    差一个不协和音程时，无论音量多合适都会让人不舒服。
//
// 频率滑音（水滴）与低通（警示音）各自只用在真正需要的那一种音色上。

// ============================================================
// 最小音频接口（DOM-free）
// ============================================================

/**
 * `AudioParam` 的最小结构类型。
 *
 * `exponentialRampToValueAtTime` 的语义要求起止值**都为正**，传 0 会在运行时
 * 抛错 —— 这是合成代码最常见的崩溃点，因为「把增益衰减到 0」是直觉写法。
 * 正确做法是衰减到 0.0001 再 `stop()`。下面的代码与检查脚本都依赖这一点。
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
}

export interface OscillatorLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  detune: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

export interface BiquadLike extends AudioNodeLike {
  type: string;
  frequency: AudioParamLike;
  Q: AudioParamLike;
}

/** 合成时需要的最小上下文接口 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  createBiquadFilter(): BiquadLike;
}

// ============================================================
// 音色数据
// ============================================================

/** 一个分音：相对基频的倍数、相对强度、衰减时长的相对比例 */
export interface Partial {
  ratio: number;
  gain: number;
  /** 相对基础衰减时长的比例。高次分音衰减更快，这是敲击音的物理特性 */
  decayScale: number;
}

/**
 * 钟（tubular bell）的分音比例。
 *
 * 2.76 与 5.4 是管钟的实测非谐分音比 —— 正是这两个"不整齐"的倍数让它听起来
 * 是钟而不是风琴。纯整数倍（1/2/3/4）会得到一段呆板的合成器音。
 */
const BELL_PARTIALS: readonly Partial[] = [
  { ratio: 1, gain: 1, decayScale: 1 },
  { ratio: 2, gain: 0.4, decayScale: 0.72 },
  { ratio: 2.76, gain: 0.2, decayScale: 0.44 },
  { ratio: 5.4, gain: 0.09, decayScale: 0.24 },
];

/**
 * 马林巴 / 木琴的分音比例。
 *
 * 3.9 与 9.2 是木条振动的非谐分音。它们的衰减极快，所以听感是"敲一下"而不是
 * "响一声" —— 这也是它比正弦更适合做提示音的原因：短而清晰，不糊。
 */
const MARIMBA_PARTIALS: readonly Partial[] = [
  { ratio: 1, gain: 1, decayScale: 1 },
  { ratio: 3.9, gain: 0.24, decayScale: 0.3 },
  { ratio: 9.2, gain: 0.07, decayScale: 0.12 },
];

export interface SoundNote {
  /** 相对本音效开始的秒数 */
  at: number;
  /** 基频（Hz） */
  freq: number;
  /** 本音的峰值增益（0..1）。分音会按比例自动归一化到这个值 */
  gain: number;
  /** 主分音的衰减时长（秒） */
  decay: number;
  /** 起振时长（秒） */
  attack: number;
  /** 分音表 */
  partials: readonly Partial[];
  /** 波形，默认 sine（加性合成用正弦堆叠） */
  type: string;
  /** 频率滑音目标（Hz）。用于水滴这类"音高上扬"的音色 */
  sweepTo?: number;
  /** 低通截止频率（Hz）。用于削弱锯齿波的刺耳谐波 */
  lowpass?: number;
}

export interface BuiltinSound {
  id: string;
  label: string;
  description: string;
  notes: readonly SoundNote[];
}

/** 指数衰减的终点。不能是 0：`exponentialRampToValueAtTime` 要求目标为正 */
export const ENVELOPE_FLOOR = 0.0001;

function note(partial: Omit<SoundNote, 'partials'> & { partials?: readonly Partial[] }): SoundNote {
  return { partials: MARIMBA_PARTIALS, ...partial };
}

/**
 * 内置音色表。
 *
 * 频率说明（十二平均律，A4 = 440 Hz）：
 *   E5 = 659.26   B5 = 987.77
 *   E6 = 1318.51  G#6 = 1661.22  B6 = 1975.53
 *   A5 = 880.00   C#6 = 1108.73
 *   G5 = 783.99   D#5 = 622.25
 */
export const BUILTIN_SOUNDS: readonly BuiltinSound[] = [
  {
    id: 'chime',
    label: '清脆铃声',
    description: '两声上行的钟音（E6 → 纯五度上的 B6），明亮、辨识度最高',
    /*
     * 第二个音刻意比第一个轻（0.6 对 0.85）。两个音的余韵是重叠的：在第二个音
     * 起振的一刻，第一个音还剩约 0.34，两者相加必须留在 1.0 以下 —— 否则
     * 压缩器会介入，把第二个音的起振压扁，听感是"第二下没力气"。
     * `scripts/check-sounds.ts` 会按包络采样把这条不变量钉住。
     */
    notes: [
      note({ at: 0, freq: 1318.51, gain: 0.85, decay: 1.1, attack: 0.003, partials: BELL_PARTIALS, type: 'sine' }),
      note({ at: 0.11, freq: 1975.53, gain: 0.6, decay: 1.3, attack: 0.003, partials: BELL_PARTIALS, type: 'sine' }),
    ],
  },
  {
    id: 'drop',
    label: '水滴',
    description: '音高快速上扬再收住，短促、柔和，适合频繁发生的提示',
    notes: [
      note({
        at: 0,
        freq: 520,
        gain: 0.85,
        decay: 0.2,
        attack: 0.006,
        partials: [{ ratio: 1, gain: 1, decayScale: 1 }],
        type: 'sine',
        sweepTo: 1560,
      }),
    ],
  },
  {
    id: 'pulse',
    label: '三连音',
    description: '三声上行的木琴音（A5 → C#6 → E6，大三和弦），节奏感明确',
    /*
     * 三个音间隔 75ms，而每个音的衰减是 0.3~0.45s，因此三者**显著重叠**。
     * 增益压在 0.78/0.78/0.85 是按重叠求和算过的：第三个音起振时前两个合计
     * 约 0.09，总和约 0.94。
     */
    notes: [
      note({ at: 0, freq: 880.0, gain: 0.78, decay: 0.3, attack: 0.003, type: 'sine' }),
      note({ at: 0.075, freq: 1108.73, gain: 0.78, decay: 0.3, attack: 0.003, type: 'sine' }),
      note({ at: 0.15, freq: 1318.51, gain: 0.85, decay: 0.45, attack: 0.003, type: 'sine' }),
    ],
  },
  {
    id: 'alert',
    label: '警示',
    description: '两声下行的短促音，带低通削弱刺耳谐波。用于警告与错误级别的通知',
    notes: [
      note({
        at: 0,
        freq: 783.99,
        gain: 0.82,
        decay: 0.14,
        attack: 0.004,
        partials: [
          { ratio: 1, gain: 1, decayScale: 1 },
          { ratio: 2, gain: 0.3, decayScale: 0.5 },
        ],
        type: 'sawtooth',
        lowpass: 2400,
      }),
      note({
        at: 0.17,
        freq: 622.25,
        gain: 0.82,
        decay: 0.2,
        attack: 0.004,
        partials: [
          { ratio: 1, gain: 1, decayScale: 1 },
          { ratio: 2, gain: 0.3, decayScale: 0.5 },
        ],
        type: 'sawtooth',
        lowpass: 2200,
      }),
    ],
  },
  {
    id: 'soft',
    label: '柔和木音',
    description: '一声带五度泛音的木琴音（E5），衰减长、起振软，最不打扰',
    /*
     * 五度泛音写在**分音表**里（倍率 1.5），而不是另开一个同时发声的音。
     *
     * 这两种写法听感接近，但峰值行为完全不同：分音会在 `strike()` 里被归一化，
     * 因此整个音的峰值恰好等于 `gain`；而另开一个音会让两个音的峰值相加，
     * 在长起振、长衰减的配置下很容易越过 1.0 —— 那就得反过来压主音的音量，
     * 结果是"越柔和越轻"。用分音表达配器，把音量留给一个可控的数。
     */
    notes: [
      note({
        at: 0,
        freq: 659.26,
        gain: 0.85,
        decay: 1.2,
        attack: 0.012,
        type: 'sine',
        partials: [
          { ratio: 1, gain: 1, decayScale: 1 },
          { ratio: 1.5, gain: 0.32, decayScale: 0.85 },
          { ratio: 3.9, gain: 0.14, decayScale: 0.3 },
        ],
      }),
    ],
  },
];

/**
 * 默认音色 id。
 *
 * **必须等于 `BUILTIN_SOUNDS[0].id`**，也必须与后端
 * `settings.rs` 的 `DEFAULT_NOTIFICATION_SOUND_ID` 一致。三处不一致会出现
 * 「后端认为默认是 A、前端回退到 B」这种只在缺字段时才暴露的分叉。
 * `scripts/check-sounds.ts` 会把这三者钉在一起。
 */
export const DEFAULT_NOTIFICATION_SOUND_ID = 'chime';

/** 自定义音效的 id */
export const CUSTOM_SOUND_ID = 'custom';

/** 全部合法的音效 id（内置 + 自定义） */
export function soundIds(): string[] {
  return [...BUILTIN_SOUNDS.map((s) => s.id), CUSTOM_SOUND_ID];
}

/** 未知 id 回退到第一个内置音色（与既有的 accent 处理同一取向：不拒绝，只降级） */
export function resolveSoundId(id: unknown, customAvailable: boolean): string {
  if (id === CUSTOM_SOUND_ID) return customAvailable ? CUSTOM_SOUND_ID : BUILTIN_SOUNDS[0].id;
  if (typeof id === 'string' && BUILTIN_SOUNDS.some((s) => s.id === id)) return id;
  return BUILTIN_SOUNDS[0].id;
}

export function getBuiltinSound(id: string): BuiltinSound | undefined {
  return BUILTIN_SOUNDS.find((s) => s.id === id);
}

/** 音量区间与默认值（与后端 settings.rs 的校验区间必须一致） */
export const MIN_SOUND_VOLUME = 0;
export const MAX_SOUND_VOLUME = 1;
export const DEFAULT_SOUND_VOLUME = 0.8;

/** 把音量夹到合法区间。后端会拒绝越界值，但一份手工改坏的 settings.json 绕过了那次校验 */
export function clampSoundVolume(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SOUND_VOLUME;
  return Math.min(MAX_SOUND_VOLUME, Math.max(MIN_SOUND_VOLUME, raw));
}

/** 音效 id 的格式校验（与后端 settings.rs 的 is_valid_sound_id 必须一致） */
export function isValidSoundId(id: string): boolean {
  return id.length > 0 && id.length <= 32 && /^[a-z0-9-]+$/.test(id);
}

// ============================================================
// 合成
// ============================================================

/**
 * 敲击一个音：为每个分音建一个振荡器加一条指数衰减包络。
 *
 * **峰值归一化在这里**：`norm = 1 / Σ分音增益`，因此一个音的峰值恰好等于
 * `spec.gain`，与它用了几个分音无关。少了这一步，"换音色就换了音量"。
 *
 * 包络形状：`0 →(线性, attack)→ peak →(指数, decay×decayScale)→ 0.0001`
 * 起点必须是 0，否则振荡器从非零振幅起步会有一声"啪"。
 */
export function strike(ctx: AudioContextLike, out: AudioNodeLike, spec: SoundNote): void {
  const norm = 1 / spec.partials.reduce((sum, p) => sum + p.gain, 0);
  const start = ctx.currentTime + spec.at;

  /*
   * 低通**每个音只建一个**，接在所有分音汇总之后。
   *
   * 不放在分音循环里是两件事一起省：滤波器个数少一半（alert 那种两个音、每个
   * 两个分音的音色会从 4 个降到 2 个），而且线性滤波器与线性求和可交换
   * （先滤后加 == 先加后滤），所以听感完全一样。
   */
  const bus: AudioNodeLike = spec.lowpass === undefined ? out : ctx.createBiquadFilter();
  if (spec.lowpass !== undefined) {
    const filter = bus as BiquadLike;
    filter.type = 'lowpass';
    filter.frequency.value = spec.lowpass;
    filter.Q.value = 0.9;
    filter.connect(out);
  }

  for (const partial of spec.partials) {
    const peak = spec.gain * partial.gain * norm;
    const sustain = Math.max(0.02, spec.decay * partial.decayScale);
    const end = start + spec.attack + sustain;

    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.value = spec.freq * partial.ratio;

    // 滑音：指数滑到目标频率，比线性更接近"音高感觉"的变化
    if (spec.sweepTo !== undefined) {
      osc.frequency.setValueAtTime(Math.max(1, spec.freq * partial.ratio), start);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(1, spec.sweepTo * partial.ratio),
        start + Math.max(0.03, spec.decay * 0.5)
      );
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + spec.attack);
    gain.gain.exponentialRampToValueAtTime(ENVELOPE_FLOOR, end);

    gain.connect(bus);
    osc.connect(gain);
    osc.start(start);
    // 多留 30ms 让释放尾巴走完再停，避免在振幅仍非零时截断（也是"啪"声的来源）
    osc.stop(end + 0.03);
  }
}

/** 合成一种内置音色。未知 id 直接返回，静默忽略（调用方已经做过回退） */
export function renderSound(ctx: AudioContextLike, out: AudioNodeLike, soundId: string): void {
  const sound = getBuiltinSound(soundId);
  if (!sound) return;
  for (const spec of sound.notes) strike(ctx, out, spec);
}
