// src/tray-menu/TrayMenu.tsx
//
// 托盘右键菜单的本体。
//
// ============================================================
// 为什么不用原生菜单
// ============================================================
//
// Tauri 的 `Menu` API 只能往**系统原生菜单**里加项：字号、圆角、悬停配色、
// 分隔线样式全部由系统画，我们改不了。要做到与应用一致的观感（圆角、投影、
// 悬停高亮、进入动画、深浅色跟随），只能自己画 —— 而"自己画"意味着一个
// 真正的窗口，因为菜单必须能显示在主窗口之外。
//
// ============================================================
// 三条刻意的呈现决定
// ============================================================
//
// 1. **菜单项不在前端判断可用性。** 「关闭窗口时最小化到托盘」那个开关的
//    当前值要从后端读回来（托盘菜单与设置页改的是同一项设置，两处各存一份
//    必然漂移）。托盘不可用时后端会把整条回落成"直接退出"，前端据此**不显示**
//    那个开关，而不是显示一个勾着但无效的项。
//
// 2. **失败要说出来。** 每个动作都返回结果；失败时这一条会显示成红色并在
//    1.6 秒后自动恢复。一个点下去什么都没发生的菜单项，比一个明确报错的更糟 ——
//    用户会反复点它。
//
// 3. **不假装知道主窗口的状态。** 菜单里没有"隐藏/显示"的动态文案：
//    那需要读主窗口的可见性，而读它会经过事件循环（见 `tray.rs` 的说明），
//    在一个只有几十毫秒生命周期的菜单窗口里做那件事不值得。菜单提供的是
//    两个明确的动作（显示主窗口 / 退出），而不是一个状态相关的切换。

import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Bell,
  Download,
  Eraser,
  LogOut,
  PanelTop,
  Power,
  Settings,
} from 'lucide-react';

/** 菜单里的一个动作。字符串与后端 `tray_menu_action` 认的名字一一对应。 */
type TrayAction =
  | 'show'
  | 'settings'
  | 'update'
  | 'free'
  | 'toggle_close_to_tray'
  | 'exit';

interface MenuItemDef {
  action: TrayAction;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 危险动作（退出）用强调色，避免误点 */
  danger?: boolean;
}

/**
 * 后端返回的菜单状态。
 *
 * `closeToTray` 是**持久设置的真实值**（设置页改过之后这里也要跟着变，
 * 因此每次弹出都重新读，而不是缓存）。`trayAvailable` 为 false 时那个开关
 * 不显示 —— 后端在托盘不可用时已经把关闭行为回落成"直接退出"，
 * 显示一个勾着的开关会与真实行为相反。
 */
interface TrayMenuState {
  closeToTray: boolean;
  trayAvailable: boolean;
}

const ITEMS: MenuItemDef[] = [
  { action: 'show', label: '显示主窗口', icon: PanelTop },
  { action: 'settings', label: '设置', icon: Settings },
  { action: 'update', label: '检查更新', icon: Download },
  { action: 'free', label: '释放资源', hint: '交还物理内存并回收后台进程', icon: Eraser },
];

const TrayMenu: React.FC = () => {
  const [state, setState] = useState<TrayMenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ action: TrayAction; message: string } | null>(null);

  /*
   * 入场动画的样式在这里就地注入，而不是加进全局样式表。
   *
   * 理由：这段动画**只有这个窗口**用得到。放进全局样式表意味着主窗口的每一帧
   * 都要多带一条与它无关的规则；而抽成组件文件也让"改这个动画会影响谁"
   * 有一个不需要搜索的答案。
   *
   * 尊重 `prefers-reduced-motion`：设置里的「关闭界面动画」写的是 localStorage
   * 的缓存 + 后端设置，而这个窗口在设置加载之前就要画出来，因此它只能读系统偏好。
   * 少一次动画远好过在用户明确要求减少动效时还播一遍。
   */
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes trayMenuEnter {
        from { opacity: 0; transform: translateY(-4px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .menu-enter { animation: trayMenuEnter 110ms ease-out; }
      @media (prefers-reduced-motion: reduce) {
        .menu-enter { animation: none; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  /**
   * 每次显示这个窗口都重读一次状态。
   *
   * 监听 `focus` 而不是只在挂载时读一次：这个窗口会被**反复显示**（每次右键），
   * 而用户完全可能在两次右键之间从设置页改掉那个开关。只读一次会让菜单
   * 显示一个陈旧的值 —— 而它看起来就像"设置没生效"。
   */
  const refresh = useCallback(async () => {
    try {
      const next = await invoke<TrayMenuState>('tray_menu_state');
      setState(next);
    } catch (error) {
      // 读不到状态时**不显示**那个开关（而不是默认显示成"开"）：
      // 一个值不确定的开关比没有这个开关更容易误导。
      console.warn('[tray-menu] 读取菜单状态失败', error);
      setState({ closeToTray: false, trayAvailable: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  /**
   * 触发一个动作。
   *
   * 后端返回一句失败原因（成功时为空）。失败时**不隐藏菜单** ——
   * 隐藏了用户就看不到出了什么事，只会觉得"点了没用"。
   */
  const run = useCallback(async (action: TrayAction) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const error = await invoke<string | null>('tray_menu_action', { action });
      if (error) {
        setFailure({ action, message: error });
        window.setTimeout(() => setFailure(null), 1600);
      }
      // 成功时**不主动隐藏**：后端在处理这个动作时会隐藏这个窗口
      // （例如"显示主窗口"会顺带把它收起来）。在这里再隐藏一次是重复的，
      // 而且会让"点了设置但设置没打开"这类错误更难发现。
    } catch (error) {
      setFailure({ action, message: typeof error === 'string' ? error : String(error) });
      window.setTimeout(() => setFailure(null), 1600);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const closeToTray = state?.closeToTray ?? false;
  const trayAvailable = state?.trayAvailable ?? false;

  return (
    /* 外框留出投影空间；窗口本身是透明的，圆角由这一层画 */
    <div className="h-full w-full p-1.5">
      {/*
        ============================================================
        颜色只用**普通**工具类，不写 `dark:` 变体
        ============================================================

        这不是风格偏好，是这套项目的机制决定的：深浅色由
        `styles/global/dark-theme.css` 按类名 token 映射（`[class~='bg-white/95']`），
        而 Tailwind 生成的 `dark:bg-gray-900/95` 选择器是
        `.dark\:bg-gray-900\/95:is(.dark *)` —— 它的特指度**高于**
        `:root.dark [class~='...']`，于是会反过来盖掉映射表里的取值。

        也就是说：**在这里写 `dark:` 变体，深色下拿到的会是 Tailwind 自己的
        颜色，而不是这套配色表里那个**。两套深色来源同时存在必然产生色差，
        而本项目的既有组件（通知中心、右键菜单、设置页）一律只用普通类 + 映射表。
        `check:theme` 会扫出任何"用了却没映射"的 token，因此漏写映射会被拦住。
        ============================================================
      */}
      <div
        className="h-full w-full rounded-xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur-md
                   menu-enter overflow-hidden flex flex-col"
        role="menu"
        aria-label="Modulith Desktop 菜单"
      >
        {/* 标题条：说明这是哪个应用的菜单。没有它，一个浮在屏幕角落的
            无边框面板会让人不确定它是谁弹出来的。 */}
        <div className="px-3 pt-2.5 pb-2 border-b border-gray-100">
          <p className="text-[11px] font-semibold tracking-wide text-gray-400">
            MODULITH DESKTOP
          </p>
        </div>

        <div className="flex-1 py-1">
          {ITEMS.map((item) => (
            <MenuRow
              key={item.action}
              action={item.action}
              label={item.label}
              hint={item.hint}
              icon={item.icon}
              danger={item.danger}
              busy={busy}
              failed={failure?.action === item.action ? failure.message : null}
              onRun={run}
            />
          ))}

          {/* 分隔线之后是「行为设置」与「退出」 */}
          <div className="my-1 border-t border-gray-100" />

          {trayAvailable && (
            <MenuRow
              action="toggle_close_to_tray"
              label="关闭窗口时最小化到托盘"
              hint={closeToTray ? '当前：隐藏到托盘，后台继续运行' : '当前：直接退出应用'}
              icon={Bell}
              busy={busy}
              failed={failure?.action === 'toggle_close_to_tray' ? failure.message : null}
              onRun={run}
              trailing={
                /* 勾选状态用一个圆点而不是原生 checkbox：
                   原生控件在这个尺寸下会显得很突兀，而且它自带焦点环 ——
                   菜单窗口里的焦点环会让人以为可以用键盘上下选择。 */
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    closeToTray ? 'bg-[var(--accent-600,#4f46e5)]' : 'bg-gray-300'
                  }`}
                  aria-hidden
                />
              }
            />
          )}

          <MenuRow
            action="exit"
            label="退出"
            hint="后台提醒与任务会一起结束"
            icon={trayAvailable ? LogOut : Power}
            busy={busy}
            failed={failure?.action === 'exit' ? failure.message : null}
            onRun={run}
            danger
          />
        </div>
      </div>
    </div>
  );
};

const MenuRow: React.FC<{
  action: TrayAction;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  busy: boolean;
  failed: string | null;
  onRun: (action: TrayAction) => void;
  danger?: boolean;
  trailing?: React.ReactNode;
}> = ({ action, label, hint, icon: Icon, busy, failed, onRun, danger, trailing }) => (
  <button
    type="button"
    role="menuitem"
    onClick={() => onRun(action)}
    disabled={busy}
    className={`w-[calc(100%-0.5rem)] mx-1 flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left
                transition-colors disabled:opacity-60
                ${
                  failed
                    ? 'bg-red-50 text-red-700'
                    : danger
                      ? 'text-gray-700 hover:bg-red-50 hover:text-red-700'
                      : 'text-gray-700 hover:bg-gray-100'
                }`}
  >
    <Icon
      className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
        failed ? 'text-red-500' : 'text-gray-400'
      }`}
    />
    <span className="min-w-0 flex-1">
      <span className="block text-[13px] leading-5 truncate">{label}</span>
      {/* 失败时用失败原因顶替说明文字：那是此刻唯一重要的信息 */}
      {(failed ?? hint) && (
        <span
          className={`block text-[11px] leading-4 truncate ${
            failed ? 'text-red-600' : 'text-gray-400'
          }`}
        >
          {failed ?? hint}
        </span>
      )}
    </span>
    {trailing && <span className="mt-1.5 shrink-0">{trailing}</span>}
  </button>
);

export default TrayMenu;
