// src/services/sound.ts
//
// 通知提示音的播放端。
//
// 音色本身在 `utils/notificationSounds.ts`（纯函数，可被脚本验证），这里只负责
// 音频设备的生命周期、音量与"什么时候该响"。
//
// ---------------------------------------------------------------------------
// 三件事值得先说清楚
//
// 1. **AudioContext 的解锁。** 浏览器/WebView 的自动播放策略要求音频上下文
//    在有用户交互之后才能出声：在没有任何交互时创建的 `AudioContext` 处于
//    `suspended`，`start()` 排的包络根本不会推进。本应用正常的启动路径里有
//    解锁动作（输入访问密钥），因此实际不会踩到；但"理论上可能"不是可以不管的
//    理由 —— 这里在首次 `pointerdown` / `keydown` 时主动 `resume()`，
//    并且每次播放前再 `resume()` 一次（已在运行时代价接近零）。
//    上下文一直起不来时会 `console.warn` 一次，而不是安静地不出声。
//
// 2. **自定义音效用 `<audio>`，内置音效用 WebAudio。** 两者不能混：内置音色是
//    现场合成的，没有文件；自定义音效是用户给的字节，交给 `<audio>` 播最省事，
//    也自带解码与流式支持。音量分别由 `master.gain` 与 `audio.volume` 控制。
//
// 3. **自定义音效的字节由后端给。** 前端拿到的是一个 `data:` URL，前端从不接触
//    路径，也不存在"播放任意路径文件"这条能力。见
//    `src-tauri/src/modules/settings/sound.rs`。
// ---------------------------------------------------------------------------

import { invoke } from '@tauri-apps/api/core';
import { getCachedSettings } from './appSettings';
import {
  CUSTOM_SOUND_ID,
  renderSound,
  resolveSoundId,
  type AudioContextLike,
} from '../utils/notificationSounds';

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

/** 播放中的自定义音效元素。保留引用以便改音量时同步，也便于复用 */
let customAudio: HTMLAudioElement | null = null;

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

/** 把音量同步到音频图与正在播放的自定义音效 */
export function applySoundVolume(volume: number): void {
  if (master && ctx) {
    // 用很短的时间常数过渡：直接赋值会在声音正在播时产生一个可听见的台阶
    master.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
  }
  if (customAudio) customAudio.volume = volume;
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
  customAudio = null;
}

// ============================================================
// 播放
// ============================================================

function playBuiltin(soundId: string, volume: number): void {
  if (!ensureGraph() || !ctx || !master) return;

  // 上下文可能因为长时间静默被系统挂起，播放前再确认一次
  if (ctx.state !== 'running') {
    void ctx.resume().catch(warnUnlockOnce);
  }

  applySoundVolume(volume);
  renderSound(ctx as unknown as AudioContextLike, master, soundId);
}

function playCustom(url: string, volume: number): void {
  try {
    if (!customAudio) {
      customAudio = new Audio(url);
      customAudio.preload = 'auto';
    }
    customAudio.volume = volume;
    // 复用同一个元素：连按试听时不会叠出多个实例，也不会每次都重新解码
    customAudio.currentTime = 0;
    void customAudio.play().catch(warnUnlockOnce);
  } catch (error) {
    warnUnlockOnce(error);
  }
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

  const volume = settings.notificationSoundVolume;
  const customFile = settings.notificationSoundCustomFile;
  const soundId = resolveSoundId(settings.notificationSoundId, Boolean(customFile));

  if (soundId === CUSTOM_SOUND_ID && customFile) {
    void loadCustomSound(customFile).then((url) => {
      if (url) playCustom(url, volume);
      // 文件丢了：退到默认内置音色，而不是静默不出声
      else playBuiltin(resolveSoundId(null, false), volume);
    });
    return;
  }

  playBuiltin(soundId, volume);
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

  if (soundId === CUSTOM_SOUND_ID) {
    const file = getCachedSettings().notificationSoundCustomFile;
    if (!file) return;
    void loadCustomSound(file).then((url) => {
      if (url) playCustom(url, volume);
    });
    return;
  }

  playBuiltin(resolveSoundId(soundId, false), volume);
}
