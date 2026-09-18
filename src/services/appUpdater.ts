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
