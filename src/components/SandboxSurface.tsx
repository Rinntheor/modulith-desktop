// src/components/SandboxSurface.tsx
//
// 沙箱插件界面的**占位与定位**。
//
// ============================================================
// 它在做一件不太常见的事
// ============================================================
//
// 插件界面不是这个 DOM 树里的一部分 —— 它是宿主在**这个窗口里另开的一个 webview**，
// 浮在所有 DOM 之上。这个组件因此只做三件事：
//
//   1. 占住内容区（一块位置正确的空地）；
//   2. 把这个空地的矩形量出来交给 Rust；
//   3. **在它不该被看见时把那个 webview 关掉** —— 因为原生 webview 不会因为
//      宿主把 DOM 隐藏了就跟着消失。
//
// 第 3 条是最容易漏的一条：标签切走只是让 React 不再渲染这一块，而那块 webview
// 仍然悬在界面上。所以"可见性"必须被显式处理，不能依赖 CSS。
//
// ============================================================
// 已知的限制（不要在文档里把这几条说成已解决）
// ============================================================
//
//   * **它盖住宿主自己的浮层。** 命令面板、通知浮层落在内容区上时会被挡住。
//     要做得对，需要在浮层出现时把 webview `hide()` 起来 —— 那是下一步。
//   * **它不随内容滚动。** 原生 webview 有自己的滚动条，不跟着外层容器走。
//     因此占位块用的是**内容视口**的矩形，而不是可滚动内容的高度。

import React, { useCallback, useEffect, useRef } from 'react';

import { useModuleActive } from '../hooks/useModuleActive';
import {
  closeSandboxSurface,
  openSandboxSurface,
  setSandboxSurfaceBounds,
  type SurfaceBounds,
} from '../services/sandboxSurface';

interface SandboxSurfaceProps {
  pluginId: string;
}

function boundsOf(element: HTMLElement): SurfaceBounds {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

const SandboxSurface: React.FC<SandboxSurfaceProps> = ({ pluginId }) => {
  const holder = useRef<HTMLDivElement>(null);

  // 「标签是否被选中」+「窗口是否可见」。插件界面必须据此出现或消失 ——
  // 原生 webview 不看 CSS，只认我们显式发的指令。
  const active = useModuleActive();

  /**
   * 把矩形交给宿主。
   *
   * `open` 与 `bounds` 分开：`open` 会走一遍 `PluginManager` 核实插件（读清单），
   * 而 `bounds` 只是摆一下位置。窗口缩放会高频触发后者，不该每次都去读盘。
   */
  const apply = useCallback(
    (mode: 'open' | 'bounds') => {
      const element = holder.current;
      if (!element) return;

      const bounds = boundsOf(element);
      const call = mode === 'open' ? openSandboxSurface : setSandboxSurfaceBounds;

      // 失败只记一条日志：界面没建出来不该把整个模块渲染炸掉，
      // 那样用户看到的是一个空白页而不是一条能读的原因。
      call(pluginId, bounds).catch((error) => {
        console.warn(`[sandboxSurface] ${pluginId} 的界面${mode === 'open' ? '打开' : '摆放'}失败`, error);
      });
    },
    [pluginId]
  );

  useEffect(() => {
    if (!active) {
      // 不可见：关掉。留着它会让原生 webview 盖在别的标签上。
      void closeSandboxSurface(pluginId).catch(() => {});
      return;
    }

    apply('open');

    const element = holder.current;
    if (!element) return;

    // 尺寸变化（侧边栏折叠、分屏拖动、窗口缩放）都要跟着走。
    // 用 rAF 合并同一帧内的多次回调 —— ResizeObserver 在一次拖动里会触发很多次，
    // 每次都发一条 IPC 是没必要的。
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        apply('bounds');
      });
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      void closeSandboxSurface(pluginId).catch(() => {});
    };
  }, [active, apply, pluginId]);

  return (
    <div
      ref={holder}
      // 占满父容器：父容器是模块的内容区。这里**不渲染任何东西** ——
      // 真正的界面在另一个 webview 里，这块只是一个位置正确的空洞。
      className="h-full w-full"
      // 一块空洞对读屏软件没有意义，但它确实占着一块地方
      aria-hidden="true"
    />
  );
};

export default SandboxSurface;
