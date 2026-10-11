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
    }
  | {
      kind: 'popover';
      id: number;
      tone: string;
      title: string | null;
      body: string;
      actions: Array<{ id: string; label: string }>;
      /** `null` = **没有截止时间**（缺省）：一直待到用户把它关掉 */
      timeoutMs: number | null;
      at: 'cursor' | 'center';
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
        // 结果卡片的回答走**自己的字段**（`action`），不借 `selected`：
        // 那一个是菜单项的 id，借过来之后一次迟到的菜单回答会被读成
        // "用户点了卡片上的某个动作"。
        action: null,
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

/**
 * 结果卡片的语气。
 *
 * 与对话框那张表**刻意不同**：卡片有 `success`（"已经复制好了"是它最常说的
 * 好消息），而没有 `question` —— 卡片不提问，要提问请用 `ui.dialog`。
 * 缺省那一档（`?? TONE_STYLES.info`）仍然指回同一个 `info`，因此宿主侧的白名单
 * 与这里的两张表不可能给出不同的颜色。
 */
const POPOVER_TONE_STYLES: Record<string, { badge: string; label: string }> = {
  info: { badge: 'bg-indigo-500', label: '结果' },
  success: { badge: 'bg-emerald-500', label: '完成' },
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

  /**
   * Esc = 没回答。菜单、对话框与结果卡片都是。
   *
   * 结果卡片**现在会取得焦点**（见 `overlay.rs` 的 `show_popover`），因此这条
   * 监听在卡片一出现时就是活的 —— 不再是"用户点过它之后才有效"。
   *
   * 但它仍然**不是**一条系统级快捷键：按键只发给有焦点的那个窗口，而"任何时候
   * 按 Esc 都能收起"要求把那个键从系统里其它每一个应用手里抢过来（注册一个全局
   * 热键，或者挂一条键盘钩子）。为一张卡片付那个代价不成立，因此诚实的说法是：
   *   * 卡片有焦点时（正常情况下它一出现就有）Esc 立刻可用；
   *   * 抢焦点失败时（前台锁、窗口管理器不放），先点一下卡片再按 Esc；
   *   * **主要手段是 × 与点别处**，Esc 是给键盘用户的捷径。
   */
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

  if (request.kind === 'popover') {
    // ============================================================
    // 结果卡片
    // ============================================================
    //
    // 与对话框同一套外观（同一个面板底色、同一圈圆角与阴影、同一行语气点），
    // 差别只在**没有对话框的按钮行**：卡片上的按钮是插件给的**动作**，它们的
    // 数量与文案都来自插件。
    //
    // **一个 markdown 都不解析。** 正文走 JSX 的文本子节点，因此它永远是文本：
    // 插件给 `<b>x</b>` 时用户看到的就是这七个字符。文件头第二条说清了为什么
    // 要让宿主渲染 —— 而"由宿主渲染"这句话只有在宿主**真的**当它是文本时才
    // 成立，否则插件只是换了一种方式在画宿主界面。
    //
    // ============================================================
    // 两条"用户能把它关掉 / 搬走"的通道（v1.6.x 补上）
    // ============================================================
    //
    // 维护者的原话是"它不能移动，也不能很快关掉"。两条各有各的原因：
    //
    //   * **不能关** —— 卡片原先只靠"到点自己消失"收场，而不带 `timeoutMs` 的
    //     那张根本没有到点这回事（现在那是缺省）；点别处那条路径又要求窗口
    //     先拿到过焦点（见 `overlay.rs` 的 `show_popover`）。于是屏幕上出现了一张
    //     只能等、不能关的卡片。现在**点别处**（窗口失焦）、**×**（下面那个按钮）
    //     与 **Esc** 三条都通。
    //   * **不能搬** —— 窗口是无边框的，而拖动不会自己发生：它要么来自
    //     `data-tauri-drag-region`（tauri 注入的 drag.js 在按下时 invoke
    //     `plugin:window|start_dragging`），要么来自一次显式调用。两者都是
    //     **走 ACL 的 IPC**，而这份清单里没写的权限默认拒绝 —— 失败形态是
    //     "按在把手上什么都不发生"，日志里一个字都没有。
    //
    // 拖拽区放在**标题条**（也就是那个把手）上，而不是整张卡片：卡片正文是可以
    // 选中的文本（译文要用鼠标选中复制），把它变成拖拽区会让"选中一段译文"变成
    // "把窗口拖走"。
    //
    // `data-tauri-drag-region="deep"`：让标题条**整条**都能拖（包括点在那个语气
    // 标签上时）。`deep` 不会把 × 也变成拖拽区 —— drag.js 遇到可点击元素
    // （button/link/…）会直接放行，这正是我们要的。
    const tone = POPOVER_TONE_STYLES[request.tone] ?? POPOVER_TONE_STYLES.info;

    return (
      <div
        ref={panelRef}
        className="flex w-[380px] max-w-full flex-col gap-3 rounded-xl border border-gray-200/50 bg-white/95 p-4 shadow-2xl backdrop-blur-xl"
      >
        {/* 把手。`cursor-grab` 是"这里能拖"唯一的可见提示（窗口没有标题栏）。 */}
        <div
          data-tauri-drag-region="deep"
          className="flex cursor-grab select-none items-center gap-2 active:cursor-grabbing"
          title="按住拖动这张卡片"
        >
          <span className="text-gray-300" aria-hidden="true">
            ⠿
          </span>
          <span className={`h-2 w-2 rounded-full ${tone.badge}`} />
          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            {tone.label}
          </span>
          {/*
            × 是**主要**的关闭手段之一（另一个是点别处）。它必须：
              * 明显可点 —— 常驻可见，不做"悬停才出现"那一套；
              * 够大 —— `h-6 w-6` 加内边距，比一个纯图标大一圈；
              * 可被读屏软件读到 —— 有 `aria-label`，字符本身用 × 而不是图片。
            它落在拖拽区里面，而 button 会让 drag.js 放过它（见上）。
          */}
          <button
            type="button"
            aria-label="关闭"
            title="关闭（Esc）"
            onClick={() => void answer(request, { dismissed: true })}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base leading-none text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          >
            ×
          </button>
        </div>

        {request.title ? (
          <div className="text-sm font-semibold text-gray-900">{request.title}</div>
        ) : null}

        {/* `whitespace-pre-wrap`：译文里的换行是内容的一部分（一段一首诗、
            一份清单），HTML 默认会把它们折成一个空格。 */}
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-gray-600">
          {request.body}
        </div>

        {request.actions.length > 0 ? (
          // 按钮**不 autoFocus**：焦点已经由宿主交给了整张卡片（见 `overlay.rs`
          // 里 `show_popover` 那一段），再 autoFocus 到某一个按钮上只会让
          // "回车"变成"点了我没打算点的那个动作" —— 卡片上的动作数量与文案
          // 都来自插件，宿主不知道哪一个才是安全的默认值。对话框那个 `autoFocus`
          // 是有意的差别：它只有一个"确定/取消"的组合，而这里可能有三个平级动作。
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            {request.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => void answer(request, { action: action.id })}
                className={
                  // 只有一个动作时它是**主操作**（翻译卡片上的「复制译文」就是这个
                  // 情形），因此按主按钮画；多个动作时它们是并列的，全部按次按钮画
                  // —— 宿主不知道哪一个更重要，替插件挑一个"主"的会误导用户。
                  request.actions.length === 1
                    ? 'rounded-lg bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-indigo-700'
                    : 'rounded-lg px-3 py-1.5 text-[13px] text-gray-600 transition-colors hover:bg-gray-100'
                }
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
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
