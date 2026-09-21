// src/services/sound.ts
//
// 通知提示音的播放端。
//
// 音色本身在 `utils/notificationSounds.ts`（纯函数，可被脚本验证），这里只负责
// 音频设备的生命周期、音量与"什么时候该响"。
//
// ---------------------------------------------------------------------------
// 四件事值得先说清楚
//
// 1. **AudioContext 的解锁。** 浏览器/WebView 的自动播放策略要求音频上下文
//    在有用户交互之后才能出声：在没有任何交互时创建的 `AudioContext` 处于
//    `suspended`，`start()` 排的包络根本不会推进。本应用正常的启动路径里有
//    解锁动作（输入访问密钥），因此实际不会踩到；但"理论上可能"不是可以不管的
//    理由 —— 这里在首次 `pointerdown` / `keydown` 时主动 `resume()`，
//    并且每次播放前再 `resume()` 一次（已在运行时代价接近零）。
//    上下文一直起不来时会 `console.warn` 一次，而不是安静地不出声。
//
// 2. **有音频文件的走 `<audio>`，现场合成的走 WebAudio。** 两者不能混：
//    合成音色没有文件；打包音效与用户导入的音效都有字节，交给 `<audio>` 播最
//    省事，也自带解码与流式支持。音量分别由 `master.gain` 与 `audio.volume`
//    控制。
//
// 3. **打包音效刻意不走 `fetch` + `decodeAudioData`。** 那条路要发一次请求，
//    而 `netGuard` 会把 WebView 里的 `fetch` 拦下并记进流量日志（同源请求也
//    一样：它是按"绝对地址 + 回环判定"来决策的，相对地址直接拒绝）。`<audio>`
//    走的是 `media-src`，既不受出站策略约束，也不该受 —— 读一个随应用发布的
//    本地文件不是"出站"。CSP 里 `media-src 'self' data: blob:` 已经覆盖它。
//
// 4. **自定义音效与打包音效的字节都由宿主给。** 前端拿到的是一个 data URL 或
//    一个构建期生成的资源地址，前端从不接触路径，也不存在"播放任意路径文件"
//    这条能力。见 `src-tauri/src/modules/settings/sound.rs`。
// ---------------------------------------------------------------------------

import { invoke } from '@tauri-apps/api/core';
import { getCachedSettings } from './appSettings';
import {
  CUSTOM_SOUND_ID,
  DEFAULT_NOTIFICATION_SOUND_ID,
  isBundledSound,
  renderSound,
  resolveSoundId,
  type AudioContextLike,
} from '../utils/notificationSounds';

/**
 * 随应用发布的默认提示音。
 *
 * 由 Vite 处理成构建期资源地址（`'self'` 源），因此 CSP 的 `media-src 'self'`
 * 覆盖它，不需要任何额外放行。文件本身的来历与取舍见
 * `docs/06-项目/已知问题与技术债.md` 的提示音一节。
 */
import bundledSoundUrl from '../assets/notification.mp3';

/** 两次提示音之间的最小间隔（毫秒）。一批通知同时到达时避免叠成一片噪音 */
const MIN_GAP_MS = 100;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unlockBound = false;
let unlockWarned = false;
let lastPlayedAt = 0;

/** 自定义音效的数据缓存：按后端给的文件名索引 */
let customCache: { file: string; url: string } | null = null;
let customLoading: Promise<string | null> | null = null;

/**
 * 正在播放的音频文件元素。
 *
 * 打包音效与自定义音效**共用**这一个元素：两者都是"一段音频文件"，而同一个
 * 元素能保证连按试听时不会叠出多个实例。切换来源时重建元素（`src` 直接改写
 * 需要额外的 `load()` 与竞态处理，而这里换来源是低频操作）。
 */
let clipAudio: HTMLAudioElement | null = null;
let clipSrc: string | null = null;

function warnUnlockOnce(error: unknown): void {
  if (unlockWarned) return;
  unlockWarned = true;
  console.warn(
    '[sound] 音频上下文未能启动，提示音暂时不会响。通常在本窗口发生一次交互后即可恢复。',
    error
  );
}

/**
 * 建立音频图：`master（音量）→ 压缩器 → 输出`。
 *
 * 压缩器不是为了"更响"，而是为了**不出爆音**：一个音的多个分音、以及多个音
 * 叠加时，样本值可能超过 1 而被硬截断，那是一种很明显的"糊/破"。放在输出前
 * 统一收一下，代价是几乎没有的。
 */
function ensureGraph(): boolean {
  if (ctx && master) return true;
  if (typeof window === 'undefined') return false;

  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return false;

    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = getCachedSettings().notificationSoundVolume;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 8;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;

    master.connect(compressor);
    compressor.connect(ctx.destination);
    return true;
  } catch (error) {
    warnUnlockOnce(error);
    ctx = null;
    master = null;
    return false;
  }
}

/**
 * 在首次用户交互时解锁音频。
 *
 * 绑定是幂等的：`unlockBound` 保证只绑一次，而回调自身也允许重复调用
 * （`resume()` 对已运行的上下文是空操作）。
 */
export function primeSound(): void {
  if (unlockBound || typeof document === 'undefined') return;
  unlockBound = true;

  const unlock = () => {
    if (!ensureGraph() || !ctx) return;
    if (ctx.state === 'running') return;
    void ctx.resume().catch(warnUnlockOnce);
  };

  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock, { passive: true });
}

/** 把音量同步到音频图与正在播放的音频文件 */
export function applySoundVolume(volume: number): void {
  if (master && ctx) {
    // 用很短的时间常数过渡：直接赋值会在声音正在播时产生一个可听见的台阶
    master.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
  }
  if (clipAudio) clipAudio.volume = volume;
}

// ============================================================
// 自定义音效
// ============================================================

/**
 * 取回自定义音效的数据 URL（带缓存）。
 *
 * 后端只认 `<app_data>/sounds/custom.<白名单扩展名>` 这一个文件名，因此这里
 * 传入的 `file` 只是"设置里记着的那个名字"，不具备路径语义。
 * 文件不在了会返回 `null`（后端记一条警告），前端据此回退到内置音色 ——
 * 提示音失效不该让通知本身也出问题。
 */
async function loadCustomSound(file: string): Promise<string | null> {
  if (customCache && customCache.file === file) return customCache.url;
  if (customLoading) return customLoading;

  customLoading = (async () => {
    try {
      const url = await invoke<string | null>('load_notification_sound');
      if (!url) return null;
      customCache = { file, url };
      return url;
    } catch (error) {
      console.warn('[sound] 读取自定义提示音失败，回退到内置音效:', error);
      return null;
    } finally {
      customLoading = null;
    }
  })();

  return customLoading;
}

/** 设置里记着的自定义音效文件名变化时调用，丢弃陈旧缓存 */
export function invalidateCustomSound(): void {
  customCache = null;
  clipAudio = null;
  clipSrc = null;
}

// ============================================================
// 播放
// ============================================================

/** 现场合成一种内置音色 */
function playBuiltin(soundId: string, volume: number): void {
  if (!ensureGraph() || !ctx || !master) return;

  // 上下文可能因为长时间静默被系统挂起，播放前再确认一次
  if (ctx.state !== 'running') {
    void ctx.resume().catch(warnUnlockOnce);
  }

  applySoundVolume(volume);
  renderSound(ctx as unknown as AudioContextLike, master, soundId);
}

/** 播放一段音频文件（打包音效或自定义音效） */
function playClip(url: string, volume: number): void {
  try {
    if (!clipAudio || clipSrc !== url) {
      clipAudio = new Audio(url);
      clipAudio.preload = 'auto';
      clipSrc = url;
    }
    clipAudio.volume = volume;
    // 复用同一个元素：连按试听时不会叠出多个实例，也不会每次都重新解码
    clipAudio.currentTime = 0;
    void clipAudio.play().catch(warnUnlockOnce);
  } catch (error) {
    warnUnlockOnce(error);
  }
}

/**
 * 按音效 id 播放。**这是音效分发的唯一一处。**
 *
 * 三支必须分清楚 —— 混了就会得到"看起来对、实际不响"，而那正是提示音这类
 * 代码最典型的失败方式（音量 0、节点名写错、包络目标为 0 都是同一类）：
 *
 *   · 打包音效（`isBundledSound`）→ `<audio>` 播随应用发布的那个文件；
 *   · 自定义音效 → `<audio>` 播后端给的 data URL，**文件丢了要回退**；
 *   · 其余内置音色 → WebAudio 现场合成。
 *
 * 最后一行用 `resolveSoundId` 而不是自己写回退：未知/失效取值的降级规则只有
 * 一份，写在 `notificationSounds.ts` 里，`check-sounds.ts` 对它做断言。
 */
async function playById(soundId: string, volume: number): Promise<void> {
  if (soundId === CUSTOM_SOUND_ID) {
    const file = getCachedSettings().notificationSoundCustomFile;
    const url = file ? await loadCustomSound(file) : null;
    if (url) {
      playClip(url, volume);
      return;
    }
    // 自定义文件不在了（用户清理了应用数据目录，或那一项指向坏文件名）。
    // 静默不出声是这里最坏的选项：用户会以为"提示音坏了"而无处可查。
    soundId = DEFAULT_NOTIFICATION_SOUND_ID;
  }

  const resolved = resolveSoundId(soundId, false);

  if (isBundledSound(resolved)) {
    playClip(bundledSoundUrl, volume);
    return;
  }

  playBuiltin(resolved, volume);
}

/**
 * 播放一次提示音。
 *
 * 开关与音效选择都从当前设置缓存读取 —— 调用方（通知推送）不需要知道这些，
 * 也就不可能出现"某个调用点忘了判断开关"。
 */
export function playNotificationSound(): void {
  const settings = getCachedSettings();
  if (!settings.notificationSoundEnabled) return;

  const now = Date.now();
  if (now - lastPlayedAt < MIN_GAP_MS) return;
  lastPlayedAt = now;

  void playById(settings.notificationSoundId, settings.notificationSoundVolume);
}

/**
 * 试听某个音色（设置页用）。
 *
 * 与 `playNotificationSound` 的两点差别，都是刻意的：
 *   · **不看开关** —— 用户正在挑音色，开关关着也得能听；
 *   · **不受最小间隔限制** —— 连点试听要被听到，而不是被节流吞掉。
 */
export function previewSound(soundId: string, volume: number): void {
  lastPlayedAt = 0;
  void playById(soundId, volume);
}
