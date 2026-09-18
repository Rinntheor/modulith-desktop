// src/components/Notifications/NotificationCenter.tsx
//
// 通知中心：标题栏铃铛点开的浮层。
//
// 与右下角浮层的分工：浮层是「刚刚发生了什么」，转瞬即逝；这里是「发生过什么、
// 有哪些我还没处理」。因此它必须持久化（重启后还在），并提供未读状态 —— 这正是
// 「事情来找你」这条通道能成立的前提：用户不需要记得回去看某个模块。
//
// 点一条通知会做两件事：标记已读，并跳到它的来源模块。来源为 `host` 或模块
// 已经被卸载时只标记已读，不会跳到不存在的模块。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  BellOff,
  CheckCheck,
  CheckCircle2,
  Download,
  Info,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import {
  clearNotifications,
  dismissNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeNotifications,
  type AppNotification,
  type NotificationLevel,
} from '../../services/notifications';
import { useCatalog } from '../../hooks/useCatalog';
import { resolveNotificationTarget } from '../../services/moduleCatalog';
import { openTab } from '../../services/tabStore';

const LEVEL_ICON: Record<NotificationLevel, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const LEVEL_CLASS: Record<NotificationLevel, string> = {
  info: 'text-indigo-500',
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  error: 'text-red-500',
};

/**
 * 相对时间。
 *
 * 自己实现而不是引日期库：这里只需要「刚刚 / n 分钟前 / n 小时前 / 昨天 / 日期」
 * 五档，而引入 dayjs 之类的库会新增一个运行时依赖 —— 对一个只用于显示的函数
 * 来说不值得。后端给的是 RFC3339（UTC），`Date` 能直接解析。
 */
function formatRelativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '';

  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;

  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

const NotificationRow: React.FC<{
  notification: AppNotification;
  sourceLabel: string;
  canJump: boolean;
  onJump: (source: string) => void;
  onOpenUpdate: () => void;
}> = ({ notification, sourceLabel, canJump, onJump, onOpenUpdate }) => {
  /*
   * 更新通知单独一套外观。
   *
   * 为什么值得特殊对待：它是一条**有明确后续动作**的通知（去下载安装），而且
   * 用户没看到就等于不知道有新版本。混在插件日志里，它唯一的命运是被一起扫过去。
   * 特殊化只体现在呈现上 —— 数据仍是一条普通通知，因此未读、合并、清空这些
   * 既有机制对它同样生效。
   */
  const isUpdate = notification.category === 'app-update';
  const Icon = isUpdate ? Download : LEVEL_ICON[notification.level];

  return (
    <div
      className={`group relative flex items-start gap-2.5 border-b border-gray-100 px-3.5 py-2.5 transition-colors ${
        isUpdate
          ? 'bg-indigo-50/60 hover:bg-indigo-50'
          : `hover:bg-gray-50 ${notification.read ? '' : 'bg-indigo-50/40'}`
      }`}
    >
      {isUpdate && <span className="absolute inset-y-0 left-0 w-0.5 bg-indigo-500" />}

      <Icon
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
          isUpdate ? 'text-indigo-600' : LEVEL_CLASS[notification.level]
        }`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <p className="min-w-0 flex-1 text-xs font-medium text-gray-900 break-words">
            {notification.title}
            {/* 合并计数：同一条信息重复发生时不必占多行，但次数要说清楚 */}
            {notification.count > 1 && (
              <span className="ml-1 rounded bg-gray-100 px-1 text-[10px] font-normal text-gray-500">
                ×{notification.count}
              </span>
            )}
          </p>
          {isUpdate && (
            <span className="shrink-0 rounded bg-indigo-600 px-1 text-[10px] font-medium leading-4 text-white">
              更新
            </span>
          )}
          {!notification.read && (
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" aria-label="未读" />
          )}
        </div>

        {notification.body && (
          <p className="mt-1 text-[11px] leading-relaxed text-gray-500 break-words">
            {notification.body}
          </p>
        )}

        <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400">
          <span className="truncate">{sourceLabel}</span>
          <span>·</span>
          <span className="shrink-0">{formatRelativeTime(notification.createdAt)}</span>
          {isUpdate && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={onOpenUpdate}
                className="shrink-0 font-medium text-indigo-700 hover:text-indigo-800"
              >
                查看更新
              </button>
            </>
          )}
          {canJump && (
            <>
              <span>·</span>
              <button
                type="button"
                onClick={() => onJump(notification.source)}
                className="shrink-0 font-medium text-indigo-600 hover:text-indigo-700"
              >
                打开模块
              </button>
            </>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => void dismissNotification(notification.id)}
        aria-label="移除这条通知"
        title="移除"
        className="shrink-0 rounded p-1 text-gray-300 opacity-0 transition-all hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
};

export interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
  /** 更新通知里「查看更新」的去处：设置 → 关于 的更新卡片 */
  onOpenUpdate: () => void;
}

const NotificationCenter: React.FC<NotificationCenterProps> = ({
  open,
  onClose,
  onOpenUpdate,
}) => {
  const [notifications, setNotifications] = useState<AppNotification[]>(() => getNotifications());
  const catalog = useCatalog();

  useEffect(() => subscribeNotifications(() => setNotifications(getNotifications())), []);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const unread = useMemo(
    () => notifications.filter((item) => !item.read).length,
    [notifications]
  );

  const handleJump = useCallback((source: string) => {
    // 用解析器而不是直接把 source 当模块 ID：插件推来的通知 source 是**插件 ID**，
    // 直接打开它会得到一个不存在的标签
    const target = resolveNotificationTarget(source);
    if (!target) return;
    openTab(target);
    onClose();
  }, [onClose]);

  // 点「查看更新」之后要关掉通知中心：否则设置对话框会被这个浮层压住
  const handleOpenUpdate = useCallback(() => {
    onOpenUpdate();
    onClose();
  }, [onOpenUpdate, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 点击外部关闭。用一层透明遮罩而不是 window 监听：
              遮罩同时阻止了点击穿透到下面的界面 */}
          <div className="fixed inset-0 z-[65]" onMouseDown={onClose} aria-hidden />

          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="fixed right-3 top-11 z-[66] flex max-h-[70vh] w-[380px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
            role="dialog"
            aria-label="通知中心"
          >
            <div className="flex items-center gap-2 border-b border-gray-100 px-3.5 py-2.5">
              <span className="text-xs font-semibold text-gray-900">通知</span>
              {unread > 0 && (
                <span className="rounded-full bg-indigo-500 px-1.5 text-[10px] font-medium leading-4 text-white">
                  {unread}
                </span>
              )}

              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void markAllNotificationsRead()}
                  disabled={unread === 0}
                  title="全部标记为已读"
                  aria-label="全部标记为已读"
                  className="rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void clearNotifications()}
                  disabled={notifications.length === 0}
                  title="清空全部通知"
                  aria-label="清空全部通知"
                  className="rounded p-1.5 text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                  <BellOff className="mb-3 h-6 w-6 text-gray-300" />
                  <p className="text-xs text-gray-500">还没有通知</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                    插件与模块需要你注意的事情会出现在这里，重启应用后仍然保留。
                  </p>
                </div>
              ) : (
                notifications.map((notification) => {
                  // 跳转目标可能是模块本身（宿主与内建模块），也可能是该插件
                  // 注册的某个模块（插件的 source 是插件 ID）——由解析器统一处理
                  const target = resolveNotificationTarget(notification.source);
                  const descriptor = target ? catalog.get(target) : undefined;
                  const sourceLabel =
                    notification.source === 'host'
                      ? 'Modulith'
                      : descriptor?.name ?? notification.source;
                  // 解析不出目标时不提供跳转入口：点了会打开一个不存在的标签
                  const canJump = Boolean(target);

                  return (
                    <div
                      key={notification.id}
                      onClick={() => {
                        if (!notification.read) void markNotificationRead(notification.id);
                      }}
                    >
                      <NotificationRow
                        notification={notification}
                        sourceLabel={sourceLabel}
                        canJump={canJump}
                        onJump={handleJump}
                        onOpenUpdate={handleOpenUpdate}
                      />
                    </div>
                  );
                })
              )}
            </div>

            <div className="border-t border-gray-100 px-3.5 py-2 text-[10px] text-gray-400">
              最多保留 200 条，超出后优先移除已读的旧通知
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default NotificationCenter;
