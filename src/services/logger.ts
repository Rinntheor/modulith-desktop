// src/services/logger.ts
//
// 前端 → 后端日志文件的那条通道。
//
// ============================================================
// 为什么前端要往一个文件里写
// ============================================================
//
// 在此之前，前端的所有错误只有一个出口：WebView 的 devtools 控制台。
// 而 devtools 在 release 版里默认关着，用户也几乎不可能被教会去按 F12 ——
// 于是「界面崩了」在用户那里就只有一句「用不了」，我们手上什么都没有。
//
// 走这条通道之后，前端的未捕获错误、未处理的 Promise 拒绝、渲染崩溃、以及
// 插件自己打的日志，都会与 Rust 侧的记录落在**同一个文件**里并按时间排序。
// 排查时不需要再让用户截图控制台。
//
// ============================================================
// 三条硬约束
// ============================================================
//
// 1. **永不抛错、永不 reject。** 一个日志调用失败不该影响任何业务逻辑。
// 2. **失败一次就闭嘴。** 若 `invoke` 本身坏了（后端没起来、IPC 不可用），
//    每次调用都失败。若无脑重试并 `console.error`，会被全局错误处理器接住
//    再回来调用这里 —— 形成无限回环。因此一旦发现通道不可用，就永久回落到
//    控制台。
// 3. **不 await。** 调用方是错误处理器与插件代码，它们不该因为写日志而变成异步。

import { invoke } from '@tauri-apps/api/core';

/** 日志级别（与后端 `log::Level` 的字符串形式对应） */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * 后端是否可用。
 *
 * `false` 之后不再尝试 IPC —— 见文件头的第 2 条约束。
 */
let bridgeAlive = true;

/** 已经报告过「通道不可用」，避免在控制台里刷屏 */
let reportedFailure = false;

function call(command: string, args: Record<string, unknown>): void {
  if (!bridgeAlive) return;

  try {
    // 刻意不 await：见文件头第 3 条约束。
    void invoke(command, args).catch((error: unknown) => {
      bridgeAlive = false;
      if (!reportedFailure) {
        reportedFailure = true;
        console.warn(
          '[logger] 后端日志通道不可用，之后的日志只写控制台：',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  } catch (error) {
    // invoke 在极端情况下会**同步**抛出（例如 Tauri 全局对象缺失）
    bridgeAlive = false;
    if (!reportedFailure) {
      reportedFailure = true;
      console.warn('[logger] 无法调用后端日志命令：', error);
    }
  }
}

/**
 * 写一条日志
 *
 * `context` 会变成后端日志的 target（例如 `frontend/pluginMarket`），
 * 用来区分记录来自哪一块。
 */
export function logMessage(level: LogLevel, message: string, context?: string): void {
  call('log_frontend', { level, message, context: context ?? null });
}

/**
 * 报告一次崩溃
 *
 * 写进**崩溃日志**而不是运行日志：它与 Rust 侧的 panic 属于同一类事件，
 * 用户报障时要看的是同一个地方。
 */
export function reportCrash(message: string, detail?: string): void {
  call('report_frontend_crash', { message, detail: detail ?? null });
}

/** 日志文件的内容片段 */
export interface LogTail {
  /** 日志文件的完整路径 */
  path: string;
  exists: boolean;
  size: number;
  text: string;
  /** 是否只返回了尾部 */
  truncated: boolean;
  fileLoggingEnabled: boolean;
  crashLoggingEnabled: boolean;
}

/** 日志目录（必要时由后端创建） */
export async function getLogDir(): Promise<string> {
  return invoke<string>('get_log_dir');
}

/** 读取运行日志的尾部 */
export async function readLogTail(maxBytes?: number): Promise<LogTail> {
  return invoke<LogTail>('read_log_tail', { maxBytes: maxBytes ?? null });
}

/** 清空全部日志文件，返回删除的文件个数 */
export async function clearLogs(): Promise<number> {
  return invoke<number>('clear_logs');
}
