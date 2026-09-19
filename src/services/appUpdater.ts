// src/services/appUpdater.ts
// 应用更新：检查、下载、安装
//
// 与插件更新（`pluginMarket.ts`）的分工是清楚的：插件更新是我们自己的逻辑（拉索引、比
// 版本、下 `.lcp`、交给已有的安装流水线），而应用更新交给 **Tauri 官方的 updater 插件**
// ——「校验更新包签名」与「调起安装程序」这两件事自己实现既危险又没有必要。
//
// ============================================================
// 为什么调用的是 Rust 命令而不是 `@tauri-apps/plugin-updater`
// ============================================================
//
// 官方的前端 API 两处地址都不可配：清单地址在插件初始化时从 `tauri.conf.json`
// 固定，安装包地址更是由清单文件自己写的。于是「用户选了下载源」这件事对它
// 完全无效 —— 表现为「能检查到新版本，下载却卡住」，是最难归因的一种现象。
//
// 现在两步都走 `src-tauri/src/modules/updater/commands.rs`：那里能在**每次调用时**
// 按当前设置改写这两个地址。下载、签名校验与调起安装程序仍然全部由官方插件完成。
//
// 因此**不要**再从这里 import `@tauri-apps/plugin-updater`：那条路会绕过下载源。
// `src-tauri/capabilities/default.json` 里的 `updater:default` 也已经移除，
// 即使有人重新引入它，调用也会因权限不足而失败。
//
// 三件必须处理对的事，都写在下面各自的注释里：
//
// 1. 句柄（`Update`）保存在 Rust 侧，前端不需要也无法忘记释放它。
// 2. 没有可用更新时结果为 `null`，因此当前版本号由后端一并返回。
// 3. **Windows 上安装会在启动安装程序后结束本进程**，界面必须提前把这件事
//    告诉用户。

import { Channel, invoke } from '@tauri-apps/api/core';

import { isUpdateCheckDue } from '../utils/updateCheck';
import { getCachedSettings, saveAppSettings } from './appSettings';
import { logMessage } from './logger';
import { notifyHost } from './notifications';

/** 可用的更新 */
export interface AvailableUpdate {
  version: string;
  /** 发布时间；发布方没写时为空 */
  date?: string | null;
  /** 发布说明（来自 `latest.json` 的 `notes`） */
  notes?: string | null;
  /** 实际会去下载的地址（已经过下载源改写） */
  downloadUrl?: string;
  /** 本次检查使用的联网方式描述（「直连」/「经下载源 …」） */
  source?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  available: AvailableUpdate | null;
  /** 本次检查真正请求的清单地址（按顺序尝试） */
  endpoints: string[];
  /** 本次检查使用的联网方式描述 */
  source: string;
}

export interface DownloadProgress {
  downloaded: number;
  /** 服务端未给 Content-Length 时为 null，此时只能显示"已下载 xx" */
  total: number | null;
}

/**
 * 下载事件（形状与官方插件一致，见 Rust 侧 `DownloadEvent`）
 *
 * 保持一致的目的是让进度条的累加逻辑不必跟着换一套写法。
 */
type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/**
 * 检查是否有新版本。重复调用是安全的 —— 后端的实现会先释放上一次的结果。
 *
 * 需要联网。网络不可达时抛错，由调用方决定怎么呈现（而不是在这里吞掉：
 * 「检查失败」和「已是最新」是两件完全不同的事，混淆会让用户以为没问题）。
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const result = await invoke<UpdateCheckResult>('check_app_update');
  return {
    currentVersion: result.currentVersion,
    available: result.available,
    endpoints: result.endpoints ?? [],
    source: result.source ?? '',
  };
}

/**
 * 下载并安装已检查到的更新。
 *
 * **Windows 上这个方法会在安装程序启动后结束本进程**（安装器以 passive 模式运行，
 * 默认安装完成后重新拉起应用）。因此调用方必须提前告知用户，不要让人以为应用崩了。
 *
 * 进度回调是节流前的原始事件：`Started` 给出总大小，`Progress` 每次给一块的大小。
 * 这里累加成绝对进度再往上抛，因为界面只关心"下了多少"。
 */
export async function installPendingAppUpdate(
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  const channel = new Channel<UpdateDownloadEvent>();
  channel.onmessage = (message) => {
    switch (message.event) {
      case 'Started':
        total = message.data.contentLength ?? null;
        downloaded = 0;
        onProgress?.({ downloaded, total });
        break;
      case 'Progress':
        downloaded += message.data.chunkLength;
        onProgress?.({ downloaded, total });
        break;
      case 'Finished':
        onProgress?.({ downloaded: total ?? downloaded, total });
        break;
    }
  };

  await invoke('install_app_update', { onEvent: channel });
}

// ============================================================
// 启动时的自动检查
// ============================================================

/**
 * 更新通知的合并键。
 *
 * 同一条「有新版本」只在未读时占一条：应用每次启动都查一次，没有合并键的话
 * 通知中心会被同一个版本刷屏 —— 而它本来只是一件事。
 */
const UPDATE_DEDUPE_KEY = 'app-update-available';

/** 自动检查是否正在进行，避免与另一次自动检查并发 */
let autoCheckInFlight = false;

/** 插件在清单里找不到匹配的平台键时报的话（见 `describeUpdateError`） */
const NO_PLATFORM_KEY = /fallback platforms|was not found in the response/;

/**
 * 把更新检查抛出的错误整理成可以直接给用户看的一段话。
 *
 * 唯一的加工是**开发模式下**那条「平台键找不到」。Tauri 会在打包时把包类型写进
 * 可执行文件（`__TAURI_BUNDLE_TYPE`），而 `pnpm tauri dev` 跑的是未打包的产物，
 * 标记仍是 `UNK` —— updater 插件于是只去清单里找 `windows-x86_64` 这个**裸键**。
 * 发布用的清单按设计只写 `windows-x86_64-msi` / `windows-x86_64-nsis`（带包类型
 * 的键），两者对不上，于是开发模式下点「检查更新」**必然**失败一次。
 *
 * 那不是缺陷，但原始报错读起来完全像是清单坏了，因此在这里补一句说明。
 *
 * **只在开发模式下补。** 正式版出现同样的报错说明清单真的缺了键，那时任何
 * "这是正常的" 都是误导 —— 这种错必须保持刺眼。
 */
export function describeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!import.meta.env.DEV || !NO_PLATFORM_KEY.test(message)) return message;

  return (
    `${message}\n\n` +
    '开发模式：未打包的进程里没有打包类型标记，更新清单里因此匹配不到平台键。' +
    '这只在 pnpm tauri dev（或直接运行未打包的可执行文件）时出现，安装版不受影响。' +
    '想在开发模式下测出「有新版本」，本地清单的平台键请写成 windows-x86_64。'
  );
}

/**
 * 记录一次「得到了确定结论」的检查。
 *
 * 手动检查也要调用它：手动查过之后，没有理由在下次启动时立刻再自动查一次。
 */
export async function noteUpdateCheckCompleted(): Promise<void> {
  try {
    await saveAppSettings({ lastUpdateCheckAt: new Date().toISOString() });
  } catch (error) {
    // 记不上时间戳只影响下次的节流判断，不影响本次检查结果 ——
    // 因此绝不能把它上升成检查失败
    console.warn('[appUpdater] 记录检查时间失败:', error);
  }
}

/** 把「有新版本」放进通知中心，并弹一个不自动消失的浮层 */
async function notifyUpdateAvailable(result: UpdateCheckResult): Promise<void> {
  const update = result.available;
  if (!update) return;

  const released = update.date ? ` · 发布于 ${update.date.slice(0, 10)}` : '';

  await notifyHost(`发现新版本 ${update.version}`, {
    body: `${result.currentVersion} → ${update.version}${released}`,
    level: 'info',
    category: 'app-update',
    dedupeKey: UPDATE_DEDUPE_KEY,
  });
}

/**
 * 启动时自动检查一次更新；发现新版本时发一条通知。
 *
 * **三种「不查」都必须是安静的**：用户关掉了自动检查；距上次检查不到 24 小时
 * （见 `utils/updateCheck.ts`）；已经有一次自动检查在跑。
 *
 * **检查失败也不发通知。** 用户没有发起这个动作，把一次网络抖动变成一条
 * 「检查更新失败」只会训练用户忽略通知 —— 而通知一旦被忽略，那条真正重要的
 * 也就没了。手动检查在「关于」页里有自己的失败呈现，那里才是该报错的地方。
 *
 * 调用点是应用界面就绪之后（Home 的一次性初始化），**不是启动步骤**：
 * 这一步要联网，放进启动流程会让启动界面多等一次网络超时。
 */
export async function autoCheckForAppUpdate(): Promise<AvailableUpdate | null> {
  if (autoCheckInFlight) return null;

  const settings = getCachedSettings();
  if (!settings.autoCheckUpdates) return null;
  if (!isUpdateCheckDue(settings.lastUpdateCheckAt)) return null;

  autoCheckInFlight = true;
  try {
    const result = await checkForAppUpdate();
    // 只有拿到确定结论才记时间戳：失败时留空，下次启动会重试。
    // 反过来的话，一次离线启动就会让自动检查静默失效一整天。
    await noteUpdateCheckCompleted();

    if (!result.available) return null;

    await notifyUpdateAvailable(result);
    return result.available;
  } catch (error) {
    // 用户没有发起这个动作，因此只记日志、不发通知。但**必须记日志**：
    // 「自动检查悄悄失败」正是最需要留下证据的一类故障 —— 用户只会觉得
    // 「这个软件从来不提示更新」。
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[appUpdater] 启动时检查更新失败（不影响使用）:', error);
    logMessage('warn', `启动时自动检查更新失败：${message}`, 'appUpdater');
    return null;
  } finally {
    autoCheckInFlight = false;
  }
}
