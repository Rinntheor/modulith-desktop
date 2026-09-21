// src/components/Settings/NotificationSettings.tsx
//
// 「通知」分页：开关、音色选择、自定义音效、音量。
//
// ============================================================
// 这一页解决的具体问题
// ============================================================
//
// 通知系统此前只有视觉通道。而通知要解决的是「用户没在看某个模块时也能知道
// 发生了什么」—— 只靠右下角一个几秒后消失的浮层，用户正在别的窗口里工作时
// 依然收不到。提示音补上的正是这一点。
//
// ============================================================
// 三个设计决定
// ============================================================
//
// 1. **音色可选，而且每种都能当场试听。** 提示音是最主观的东西：同一个音色
//    有人觉得清脆、有人觉得吵。只给一个开关等于把选择权收走了。试听按钮不受
//    「启用提示音」开关影响 —— 用户正在挑音色，关着开关也得能听。
//
// 2. **自定义音效是被复制进来的，不是被引用的。** 见后端 `sound.rs`：
//    只存文件名、只认 `custom.<白名单扩展名>`。界面上如实说明这一点，
//    用户才不会以为"我删了原文件它就没了"。
//
// 3. **音量条在拖动过程中不写设置。** `saveAppSettings` 没有防抖（这是它的
//    既定行为，见 services/appSettings.ts），而 range 的 onChange 在拖动时
//    每次移动都会触发 —— 直接接上去会变成一秒几十次 IPC。因此拖动时只改本地
//    状态并实时套用到音频图，松手才落盘。

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Music, Play, Trash2, Upload } from 'lucide-react';

import type { AppSettings } from '../../services/appSettings';
import {
  BUILTIN_SOUNDS,
  CUSTOM_SOUND_ID,
  DEFAULT_NOTIFICATION_SOUND_ID,
  MAX_SOUND_VOLUME,
  MIN_SOUND_VOLUME,
  type BuiltinSound,
} from '../../utils/notificationSounds';
import { applySoundVolume, invalidateCustomSound, previewSound } from '../../services/sound';
import { showToast } from '../../services/toast';
import Toggle from './Toggle';

interface Props {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
}

/** 后端 `pick_notification_sound` 的返回（`sound.rs::CustomSound`） */
interface PickedSound {
  name: string;
  fileName: string;
  dataUrl: string;
  bytes: number;
}

const SoundRow: React.FC<{
  sound: BuiltinSound;
  selected: boolean;
  volume: number;
  onSelect: () => void;
}> = ({ sound, selected, volume, onSelect }) => (
  <div
    className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
      selected ? 'border-indigo-300 bg-indigo-50/50' : 'border-gray-200 bg-white hover:bg-gray-50'
    }`}
  >
    <button
      type="button"
      onClick={onSelect}
      className="min-w-0 flex-1 text-left"
      aria-pressed={selected}
    >
      <p className={`text-sm ${selected ? 'font-medium text-indigo-700' : 'text-gray-800'}`}>
        {sound.label}
      </p>
      <p className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{sound.description}</p>
    </button>

    {/* 试听：与选中分开，方便逐个比较而不必先选中 */}
    <button
      type="button"
      onClick={() => previewSound(sound.id, volume)}
      title={`试听「${sound.label}」`}
      aria-label={`试听 ${sound.label}`}
      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
    >
      <Play className="w-3 h-3" />
      试听
    </button>
  </div>
);

const NotificationSettings: React.FC<Props> = ({ settings, onUpdate }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * 拖动中的音量。
   *
   * 本地状态存在的唯一理由是**避免拖动时刷 IPC**（见文件头第 3 条）。
   * 一旦松手就写回设置，之后以设置为准 —— 设置变化时下面的 effect 会重新同步。
   */
  const [volume, setVolume] = useState(settings.notificationSoundVolume);
  useEffect(() => {
    setVolume(settings.notificationSoundVolume);
  }, [settings.notificationSoundVolume]);

  const commitVolume = useCallback(
    (next: number) => {
      void onUpdate({ notificationSoundVolume: next });
      previewSound(settings.notificationSoundId, next);
    },
    [onUpdate, settings.notificationSoundId]
  );

  const handlePick = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const picked = await invoke<PickedSound | null>('pick_notification_sound');
      // null = 用户取消，那是正常操作，不是错误
      if (!picked) return;

      // 换了文件，缓存里那份就是旧的
      invalidateCustomSound();
      await onUpdate({
        notificationSoundId: CUSTOM_SOUND_ID,
        notificationSoundCustomFile: picked.fileName,
      });
      previewSound(CUSTOM_SOUND_ID, volume);
      showToast({
        title: '提示音已导入',
        body: `${picked.name} 已复制到应用数据目录，原文件移动或删除都不影响使用`,
        level: 'success',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onUpdate, volume]);

  const handleClearCustom = useCallback(async () => {
    invalidateCustomSound();
    await onUpdate({
      notificationSoundCustomFile: null,
      // 同时把音色切回默认，否则设置会停在一个不可用的 `custom` 上。
      // 用常量而不是 `BUILTIN_SOUNDS[0].id`：默认音色是打包音效，它的位置
      // 由常量表达；靠数组下标表达会在有人调整顺序时静默改变语义。
      notificationSoundId: DEFAULT_NOTIFICATION_SOUND_ID,
    });
  }, [onUpdate]);

  const usingCustom = settings.notificationSoundId === CUSTOM_SOUND_ID;
  const hasCustom = Boolean(settings.notificationSoundCustomFile);

  return (
    <div className="px-6 py-5">
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <div className="flex items-start justify-between gap-6 py-3.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-800">通知提示音</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              有新的通知时播放一段提示音。通知在这个应用里是低频事件（插件加载失败、
              有可用更新），因此默认开启；关掉后通知仍然会出现在通知中心与浮层里。
              <br />
              同一条通知被合并计数时不会重复响 —— 否则重试循环会把它变成骚扰。
            </p>
          </div>
          <div className="shrink-0 pt-0.5">
            <Toggle
              checked={settings.notificationSoundEnabled}
              onChange={(next) => void onUpdate({ notificationSoundEnabled: next })}
            />
          </div>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
              提示音
            </h3>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              每种音色都可以先试听再选。试听不受上面的开关影响。
            </p>
          </div>
          <button
            type="button"
            onClick={() => previewSound(settings.notificationSoundId, volume)}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            试听当前
          </button>
        </div>

        <div className="space-y-2">
          {BUILTIN_SOUNDS.map((sound) => (
            <SoundRow
              key={sound.id}
              sound={sound}
              selected={settings.notificationSoundId === sound.id}
              volume={volume}
              onSelect={() => void onUpdate({ notificationSoundId: sound.id })}
            />
          ))}

          {/* 自定义音效 */}
          <div
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
              usingCustom
                ? 'border-indigo-300 bg-indigo-50/50'
                : 'border-gray-200 bg-white hover:bg-gray-50'
            }`}
          >
            <button
              type="button"
              disabled={!hasCustom}
              onClick={() => void onUpdate({ notificationSoundId: CUSTOM_SOUND_ID })}
              className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
              aria-pressed={usingCustom}
            >
              <p
                className={`text-sm flex items-center gap-1.5 ${
                  usingCustom ? 'font-medium text-indigo-700' : 'text-gray-800'
                }`}
              >
                <Music className="w-3.5 h-3.5" />
                自定义音效
              </p>
              <p className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">
                {hasCustom
                  ? `当前文件：${settings.notificationSoundCustomFile}（已复制到应用数据目录）`
                  : '还没有选择文件。支持 mp3 / wav / ogg / m4a / aac / flac / opus / webm，上限 2 MB'}
              </p>
            </button>

            <button
              type="button"
              onClick={() => previewSound(CUSTOM_SOUND_ID, volume)}
              disabled={!hasCustom}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              <Play className="w-3 h-3" />
              试听
            </button>

            <button
              type="button"
              onClick={() => void handlePick()}
              disabled={busy}
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <Upload className="w-3 h-3" />
              {hasCustom ? '更换' : '选择文件'}
            </button>

            {hasCustom && (
              <button
                type="button"
                onClick={() => void handleClearCustom()}
                title="移除自定义音效"
                aria-label="移除自定义音效"
                className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {error && <p className="mt-2 text-[11px] text-red-600 break-all">{error}</p>}
      </section>

      <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
        <div className="py-3.5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium text-gray-800">音量</p>
            <span className="text-xs text-gray-500 tabular-nums">
              {Math.round(volume * 100)}%
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
            这个音量只作用于本应用的提示音，与系统音量相乘。松手时会播放一次以确认。
          </p>
          <input
            type="range"
            min={MIN_SOUND_VOLUME}
            max={MAX_SOUND_VOLUME}
            step={0.05}
            value={volume}
            onChange={(event) => {
              // 拖动中：只改本地状态并实时套用，不写设置（见文件头第 3 条）
              const next = Number(event.target.value);
              setVolume(next);
              applySoundVolume(next);
            }}
            onPointerUp={() => commitVolume(volume)}
            onKeyUp={() => commitVolume(volume)}
            className="mt-2.5 w-full accent-indigo-600"
            aria-label="提示音音量"
          />
        </div>
      </section>
    </div>
  );
};

export default NotificationSettings;
