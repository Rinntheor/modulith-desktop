// src/services/appUpdater.ts
// 应用更新：检查、下载、安装
//
// 与插件更新（`pluginMarket.ts`）的分工是清楚的：插件更新是我们自己的逻辑（拉索引、比
// 版本、下 `.lcp`、交给已有的安装流水线），而**应用更新交给 Tauri 官方的 updater 插件**
// —— 「校验更新包签名」与「调起安装程序」这两件事自己实现既危险又没有必要。
//
// 三件必须处理对的事，都写在下面各自的注释里：
//
// 1. `check()` 返回的 `Update` 是 Rust 侧的资源句柄，**必须显式关闭**，否则会泄漏。
// 2. 没有可用更新时 `check()` 返回 `null`，此时拿不到 `currentVersion`，
//    所以当前版本号单独从宿主取。
// 3. **Windows 上 `downloadAndInstall` 会在启动安装程序后结束本进程**，
//    界面必须提前把这件事告诉用户。

import { check, type Update } from '@tauri-apps/plugin-updater';

import { isUpdateCheckDue } from '../utils/updateCheck';
import { getCachedSettings, saveAppSettings } from './appSettings';
import { notifyHost } from './notifications';
import { getHostVersion } from './pluginRuntime';

/** 可用的更新 */
export interface AvailableUpdate {
  version: string;
  /** RFC3339 时间；发布方没写时为空 */
  date?: string;
  /** 发布说明（来自 `latest.json` 的 `notes`） */
  notes?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  available: AvailableUpdate | null;
}

export interface DownloadProgress {
  downloaded: number;
  /** 服务端未给 Content-Length 时为 null，此时只能显示"已下载 xx" */
  total: number | null;
}

/**
 * 已检查到、但还没安装的更新。
 *
 * 持有在模块级而不是返回给调用方，是因为它是一个需要配对的资源句柄：谁拿到它就得负责
 * 关闭。放在这里，界面组件卸载或重复检查时都不会泄漏。
 */
let pending: Update | null = null;

async function releasePending(): Promise<void> {
  if (!pending) return;
  const handle = pending;
  pending = null;
  try {
    await handle.close();
  } catch {
    // 释放失败不影响判断结果，也不该打断界面流程
  }
}

/**
 * 检查是否有新版本。重复调用是安全的 —— 会先释放上一次的结果。
 *
 * 需要联网。网络不可达时抛错，由调用方决定怎么呈现（而不是在这里吞掉：
 * 「检查失败」和「已是最新」是两件完全不同的事，混淆会让用户以为没问题）。
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  await releasePending();

  const update = await check();
  if (!update) {
    return { currentVersion: getHostVersion(), available: null };
  }

  pending = update;
  return {
    currentVersion: update.currentVersion,
    available: {
      version: update.version,
      date: update.date,
      notes: update.body,
    },
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
  if (!pending) {
    throw new Error('没有待安装的更新，请先检查更新。');
  }

  let downloaded = 0;
  let total: number | null = null;

  try {
    await pending.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? null;
          downloaded = 0;
          onProgress?.({ downloaded, total });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          onProgress?.({ downloaded, total });
          break;
        case 'Finished':
          onProgress?.({ downloaded: total ?? downloaded, total });
          break;
      }
    });
  } finally {
    // 安装失败时要释放；成功时进程通常已经退出，走不到这里也无妨。
    await releasePending();
  }
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
    console.warn('[appUpdater] 启动时检查更新失败（不影响使用）:', error);
    return null;
  } finally {
    autoCheckInFlight = false;
  }
}
