// src/overlay/OverlayRoot.tsx
//
// 浮层窗口的内容：要么是一个对话框，要么是一个菜单。
//
// ============================================================
// 为什么尺寸由**这里**量、由宿主去设
// ============================================================
//
// 一段说明文字折行之后有多高，取决于字号、字体、可用宽度与语言 ——
// 宿主算不出来，也不该去算。因此流程是：
//
//   1. 内容渲染出来，这里量一次真实尺寸；
//   2. 通过 `overlay_resize` 请宿主把**窗口**调到那个尺寸；
//   3. 宿主的 `resize` 会钳制到合理范围（一个量错的尺寸不该让窗口消失或铺满屏幕）。
//
// 这与沙箱插件的 `measureSurface` 是同一条路子：**量的那一侧量，摆的那一侧摆。**

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** 与 Rust 侧 `overlay::OverlayRequest` 一一对应 */
export type OverlayRequest =
  | {
      kind: 'dialog';
      id: number;
      tone: string;
      title: string;
      message: string;
      confirmLabel: string;
      cancelLabel: string | null;
    }
  | {
      kind: 'menu';
      id: number;
      title: string | null;
      items: Array<{
        id: string;
        label: string;
        accelerator: string | null;
        separator: boolean;
        disabled: boolean;
      }>;
    };

/** 宿主显示浮层时广播的事件名。必须与 `overlay.rs` 的 `OVERLAY_SHOW` 一致。 */
export const OVERLAY_SHOW = 'modulith://overlay-show';

/**
 * 回答并隐藏。
 *
 * **先回答再隐藏**：反过来的话，隐藏会触发 `Focused(false)`，而宿主在那条路径上
 * 会把这次等待当成"用户没回答"（`dismissed`）—— 于是用户点了「确定」，
 * 插件收到的却是"被放弃"。这个顺序不能反。
 */
async function answer(request: OverlayRequest, payload: Record<string, unknown>): Promise<void> {
  try {
    await invoke('overlay_respond', {
      response: {
        id: request.id,
        confirmed: false,
        selected: null,
        dismissed: false,
        ...payload,
      },
    });
  } catch (error) {
    console.error('[overlay] 回答失败:', error);
  }

  try {
    await invoke('overlay_hide');
  } catch (error) {
    console.error('[overlay] 隐藏失败:', error);
  }
}

const TONE_STYLES: Record<string, { badge: string; label: string }> = {
  info: { badge: 'bg-indigo-500', label: '提示' },
  question: { badge: 'bg-indigo-500', label: '请确认' },
  warning: { badge: 'bg-amber-500', label: '注意' },
  error: { badge: 'bg-rose-500', label: '出错了' },
};

const OverlayRoot: React.FC = () => {
  const [request, setRequest] = useState<OverlayRequest | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;

    void listen<OverlayRequest>(OVERLAY_SHOW, (event) => {
      if (disposed) return;
      setRequest(event.payload ?? null);
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        stop = unlisten;
      })
      .catch((error: unknown) => {
        console.error('[overlay] 订阅浮层内容失败:', error);
      });

    return () => {
      disposed = true;
      if (stop) stop();
    };
  }, []);

  // 量内容 → 请宿主调窗口尺寸。
  //
  // 用 `useLayoutEffect` 而不是 `useEffect`：后者在浏览器绘制之后才跑，
  // 于是用户会先看到内容被窗口边界裁掉一下、再跳到正确尺寸。
  useLayoutEffect(() => {
    if (!request || !panelRef.current) return;

    const rect = panelRef.current.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    void invoke('overlay_resize', { width: rect.width, height: rect.height }).catch(
      (error: unknown) => {
        console.warn('[overlay] 调整尺寸失败（内容可能被裁掉）:', error);
      }
    );
  }, [request]);

  /** Esc = 没回答。菜单与对话框都是。 */
  const dismiss = useCallback(() => {
    if (!request) return;
    void answer(request, { dismissed: true });
  }, [request]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss]);

  if (!request) {
    // 窗口在内容到达之前不该被看到（它是先收内容再显示的）。这里渲染一个
    // 透明占位而不是 `null`：`null` 会让窗口保持上一次的尺寸，而透明占位
    // 至少让 "什么都没有" 与 "还在等" 在界面上是同一种表现。
    return <div className="h-full w-full" />;
  }

  if (request.kind === 'menu') {
    return (
      // 类名**逐条抄自 `GlobalContextMenu.tsx`**，不是另起一套。
      //
      // 这正是"由宿主渲染"的意义：插件贡献的菜单项必须与宿主自己的右键菜单
      // 长成同一个样子。自己写一套颜色，哪怕当下看着差不多，也会在宿主改设计
      // 系统之后变成"插件的菜单和宿主的菜单不是一套"。
      //
      // 唯一的结构差异是第一行：这里没有 `fixed z-50`，因为这个文档**整个就是**
      // 那个浮层（它跑在独立窗口里），没有需要盖住的东西。
      <div
        ref={panelRef}
        className="inline-block min-w-52 overflow-hidden rounded-xl border border-gray-200/50 bg-white/95 py-1.5 shadow-2xl backdrop-blur-xl"
      >
        {request.title ? (
          <div className="px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
            {request.title}
          </div>
        ) : null}

        {request.items.map((item, index) =>
          item.separator ? (
            <div key={`sep-${index}`} className="my-1 border-t border-gray-100" />
          ) : (
            <button
              key={item.id || `item-${index}`}
              type="button"
              disabled={item.disabled}
              onClick={() => void answer(request, { confirmed: true, selected: item.id })}
              className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors ${
                item.disabled ? 'cursor-default text-gray-300' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className="flex-1 truncate">{item.label}</span>
              {item.accelerator ? (
                <span className="shrink-0 text-[11px] text-gray-400">{item.accelerator}</span>
              ) : null}
            </button>
          )
        )}
      </div>
    );
  }

  const tone = TONE_STYLES[request.tone] ?? TONE_STYLES.info;

  return (
    <div
      ref={panelRef}
      className="flex w-[420px] max-w-full flex-col gap-3 rounded-xl border border-gray-200/50 bg-white/95 p-4 shadow-2xl backdrop-blur-xl"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tone.badge}`} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
          {tone.label}
        </span>
      </div>

      <div className="text-sm font-semibold text-gray-900">{request.title}</div>
      {/* `whitespace-pre-wrap`：插件给的说明里可以有换行，而 HTML 默认会把它们
          折成一个空格 —— 那会让"三行步骤"变成一大段，读起来完全不同。 */}
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-gray-600">
        {request.message}
      </div>

      <div className="mt-1 flex justify-end gap-2">
        {request.cancelLabel ? (
          <button
            type="button"
            onClick={() => void answer(request, { confirmed: false })}
            className="rounded-lg px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100"
          >
            {request.cancelLabel}
          </button>
        ) : null}
        <button
          type="button"
          autoFocus
          onClick={() => void answer(request, { confirmed: true })}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700"
        >
          {request.confirmLabel}
        </button>
      </div>
    </div>
  );
};

export default OverlayRoot;
