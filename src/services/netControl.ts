// src/services/netControl.ts
//
// 出站策略与流量日志的前端入口。
//
// 两条纪律写在这里，因为它们是这一层最容易走样的地方：
//
//   1. **档位描述由后端提供，前端不手写。** `net_policy_modes` 返回每一档的
//      label / hint / 是否可用 / 不可用的原因。前端手写一份的后果是：某一档后来
//      实现了，界面还标着"未实现"；或者反过来 —— 界面说可用，实际什么都没发生。
//      这与权限注册表是同一个理由：**同一份名单的第二份副本必然漂移**。
//   2. **前端不做策略判定。** 判定点在 Rust（`modules/net/policy.rs`），因为请求
//      由 Rust 发起。前端这里只负责读值、写值、显示。

import { invoke } from '@tauri-apps/api/core';

/** 策略档位描述（来自后端） */
export interface NetPolicyMode {
  id: string;
  label: string;
  hint: string;
  /** false 时界面必须**禁用并给出原因**，不能显示成一个可选项 */
  available: boolean;
  unavailableReason: string;
}

/** 一条流量日志 */
export interface NetLogEntry {
  at: string;
  direction: 'outbound' | 'inbound';
  /** `host` / `plugin:<id>` / `module:<id>` */
  source: string;
  /**
   * 这次请求是干什么用的（"插件市场索引"/"网络诊断"/"插件包下载"…）。
   *
   * 只有 `source` 时，用户看到"模块 plugins 连了 cdn.jsdelivr.net"仍然分不清
   * 那是在取索引、取说明还是在下载插件包 —— 而"要不要放它过去"恰恰取决于这个。
   */
  purpose: string;
  method: string;
  host: string;
  url: string;
  outcome: 'allowed' | 'allowed-pending-prompt' | 'denied' | 'failed';
  status: number | null;
  bytes: number | null;
  detail: string | null;
}

export function loadPolicyModes(): Promise<NetPolicyMode[]> {
  return invoke<NetPolicyMode[]>('net_policy_modes');
}

/** 最近的日志，**最新的在前** */
export function loadNetLog(limit = 200): Promise<NetLogEntry[]> {
  return invoke<NetLogEntry[]>('net_log_list', { limit });
}

export function clearNetLog(): Promise<void> {
  return invoke<void>('net_log_clear');
}

export function netLogLength(): Promise<number> {
  return invoke<number>('net_log_len');
}

/**
 * 上报一次**前端门面拦下的**出站尝试（见 `netGuard.ts`）。
 *
 * 后端拿到它之后**用自己的规则重新判一次**并记日志 —— 前端传的是"发生过这件事"，
 * 不是"结果是什么"。让调用方决定日志内容，等于让日志变成它自己的说法。
 *
 * 是 fire-and-forget：判定已经在前端同步做完了，这条只是为了留痕。
 */
export function netNoteFrontendOutbound(
  url: string,
  method: string,
  source: string
): Promise<boolean> {
  return invoke<boolean>('net_note_frontend_outbound', { url, method, source });
}

// ============================================================
// 判定常量（前端镜像）
// ============================================================

/**
 * 出站策略的三个取值与两条拒绝原因的原文。
 *
 * **这是 `src-tauri/src/modules/net/policy.rs` 的镜像，也是全项目唯一允许存在的
 * 第二份。** 它存在的理由是同步上下文：WebView 里的 `XMLHttpRequest.send()` 与
 * `new WebSocket()` 都是同步的，没法等一次 IPC 往返再决定发不发。
 *
 * 漂移由 `pnpm check:network` 钉住 —— 那边读 Rust 源文件，断言这里的字面量与它一致。
 * 这与本文件开头第 1 条纪律（档位描述不手写第二份）不矛盾：那条说的是**给用户看的
 * 档位说明**（会随实现变化，必须由后端给），这里说的是**判定用的取值**（是协议的一部分，
 * 两侧必须逐字相同，而"读后端"在同步上下文里做不到）。
 */
export const NET_MODE_ALLOW = 'allow';
export const NET_MODE_ASK = 'ask';
export const NET_MODE_DENY = 'deny';

export const NET_DENY_OFFLINE = '离线模式已开启';
export const NET_DENY_POLICY = '出站策略为「禁止出站」';
export const NET_DENY_DIRECT = '插件不能直接联网，请改用 ctx.http（它带权限检查、出站策略与流量日志）';

// ============================================================
// 显示辅助
// ============================================================

export const OUTCOME_LABELS: Record<NetLogEntry['outcome'], string> = {
  allowed: '已放行',
  'allowed-pending-prompt': '已放行（本应询问）',
  denied: '已拒绝',
  failed: '失败',
};

/**
 * 来源的可读化：`plugin:com.x.y` → `插件 com.x.y`。
 *
 * 不做成"查插件显示名"——那需要把插件列表拉进来，而日志是**诊断**用的，
 * 它必须在这时候仍然能读（插件列表本身可能正因为某个插件出错而加载不全）。
 */
export function describeSource(source: string): string {
  if (source === 'host') return '应用自身';
  if (source.startsWith('plugin:')) return `插件 ${source.slice('plugin:'.length)}`;
  if (source.startsWith('module:')) return `模块 ${source.slice('module:'.length)}`;
  return source;
}

/**
 * 把 URL 截成主机 + 路径，**丢掉查询串**。
 *
 * 查询串里经常带令牌（`?token=…`、`?sig=…`），而日志会被截图、被贴进 issue。
 * 折叠是默认行为，需要时用户仍可以展开看全文。
 */
export function splitUrl(url: string): { host: string; path: string; hasQuery: boolean } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname, hasQuery: parsed.search.length > 0 };
  } catch {
    return { host: '', path: url, hasQuery: false };
  }
}
