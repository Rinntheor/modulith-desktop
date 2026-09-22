// src/components/Settings/ReminderSettings.tsx
//
// 「提醒」分页：增删改定时提醒，并**验证它真的会响**。
//
// ============================================================
// 这一页为什么与「通知」分开
// ============================================================
//
// 「通知」页管的是"通知长什么样、要不要响"（音色、音量、开关）。
// 这一页管的是"什么时候产生一条通知"，而它的技术前提完全不同：
// 提醒由**后台宿主进程**计时，因此它能在窗口关掉之后照样响 ——
// 那是通知中心本身做不到的事。
//
// 把两者塞进一页会让"为什么关掉窗口它还会提醒"这件事变得难以解释。
//
// ============================================================
// 三个刻意的呈现决定
// ============================================================
//
// 1. **"下一次什么时候响"只显示后台回报的值。** 前端不去自己算那件事
//    （见 services/reminders.ts 的说明）。后台没在跑时这里显示的是
//    "后台未运行，当前没有在计时"，而不是一个我们猜的时刻。
//
// 2. **"现在试一下"走的是真实链路。** 它让后台宿主真的发一条事件，
//    于是用户按下之后**通知中心里会出现一条真的提醒**。一个只在自己内部
//    打个勾的"测试"按钮证明不了任何事 —— 而这个功能最需要被证明的恰恰是
//    "它真的会响"。
//
// 3. **校验错误原样显示，不做相邻取值。** 后端拒绝的每一条都会把原因带回来
//    （"间隔太短：最少 60 秒"），这里直接显示它。界面自己再判断一次
//    "要不要帮用户改成 60"会让用户以为自己设的就是生效的那个值。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bell,
  CheckCircle,
  Clock,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import {
  deleteReminder,
  describeKind,
  formatAbsoluteTime,
  formatRelative,
  getReminderRuntime,
  listReminders,
  parseMinuteOfDay,
  runReminderNow,
  saveReminder,
  setReminderEnabled,
  type Reminder,
  type ReminderKind,
  type ReminderRuntimeReport,
} from '../../services/reminders';
import Toggle from './Toggle';

/** 新建表单的本地状态。`id` 不进表单 —— 它按标题自动生成，用户不必填。 */
interface DraftState {
  title: string;
  body: string;
  kind: ReminderKind;
  /** 间隔用**分钟**填写：秒级提醒在这个场景里没有正当用途 */
  intervalMinutes: string;
  /** 每日时刻用 `HH:MM` 填写 */
  dailyAt: string;
  /** 一次性提醒用 `datetime-local` 的值 */
  onceAt: string;
}

const EMPTY_DRAFT: DraftState = {
  title: '',
  body: '',
  kind: 'interval',
  intervalMinutes: '60',
  dailyAt: '09:00',
  onceAt: '',
};

/**
 * 由标题生成一个稳定的 id。
 *
 * 中文标题**直接保留**：后端的字符集只允许字母数字与 `-_.`，因此这里把其它字符
 * 换成 `-`。若换完没有任何有效字符（例如标题是纯英文以外的符号），
 * 回落到一个按时间戳生成的 id —— 一个可读性差但能用的 id，好过一个被拒绝的保存。
 */
function deriveId(title: string, existing: Reminder[]): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  const base = slug === '' ? `reminder-${Date.now().toString(36)}` : slug;

  // 同名的再建一条时加序号：id 冲突会让后一条**覆盖**前一条，
  // 而用户以为自己建了两条。
  if (!existing.some((item) => item.id === base)) return base;

  let index = 2;
  while (existing.some((item) => item.id === `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** 把表单换算成后端入参，校验失败时返回一句给用户看的话 */
function draftToInput(
  draft: DraftState,
  existing: Reminder[]
): { input: Parameters<typeof saveReminder>[0] } | { error: string } {
  const title = draft.title.trim();
  if (title === '') return { error: '请填写提醒标题' };

  const base = {
    id: deriveId(title, existing),
    title,
    body: draft.body.trim(),
    kind: draft.kind,
    enabled: true,
  };

  if (draft.kind === 'interval') {
    const minutes = Number(draft.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { error: '请填写一个大于 0 的间隔分钟数' };
    }
    return { input: { ...base, intervalSeconds: Math.round(minutes * 60) } };
  }

  if (draft.kind === 'daily') {
    const minuteOfDay = parseMinuteOfDay(draft.dailyAt);
    if (minuteOfDay === null) {
      return { error: '每日时刻要写成 HH:MM（例如 09:00）' };
    }
    return { input: { ...base, minuteOfDay } };
  }

  if (draft.onceAt.trim() === '') return { error: '请选择一次性提醒的时刻' };

  // `datetime-local` 给的是本地时间字符串，`new Date` 按本地时区解释它 ——
  // 那正是用户填"明天 9:00"时的意思。
  const at = new Date(draft.onceAt).getTime();
  if (Number.isNaN(at)) return { error: '一次性提醒的时刻无法解析' };
  if (at <= Date.now()) return { error: '一次性提醒的时刻必须在将来' };

  return { input: { ...base, at } };
}

const ReminderSettings: React.FC = () => {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [runtime, setRuntime] = useState<ReminderRuntimeReport | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** 组件的挂载标记：异步回来后不再 setState，避免卸载后更新 */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshRuntime = useCallback(async () => {
    const report = await getReminderRuntime();
    if (alive.current) setRuntime(report);
  }, []);

  const refreshAll = useCallback(async () => {
    setBusy(true);
    try {
      const list = await listReminders();
      if (!alive.current) return;
      setReminders(list);
      await refreshRuntime();
    } catch (error) {
      if (alive.current) {
        setMessage({ kind: 'error', text: `读取提醒失败：${String(error)}` });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [refreshRuntime]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // 运行状态每 5 秒刷一次，**只在页面可见时** —— 一个后台标签页里跑定时器
  // 只是白白唤醒 CPU，而我们正在做的整件事就是减少常驻开销。
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshRuntime();
    };
    const timer = window.setInterval(tick, 5000);
    return () => window.clearInterval(timer);
  }, [refreshRuntime]);

  /** 按 id 取运行状态 */
  const runtimeById = useMemo(() => {
    const map = new Map<string, ReminderRuntimeReport['runtime'][number]>();
    for (const entry of runtime?.runtime ?? []) map.set(entry.id, entry);
    return map;
  }, [runtime]);

  const now = Date.now();

  const handleSave = async () => {
    const converted = draftToInput(draft, reminders);
    if ('error' in converted) {
      setMessage({ kind: 'error', text: converted.error });
      return;
    }

    setBusy(true);
    try {
      const list = await saveReminder(converted.input);
      if (!alive.current) return;
      setReminders(list);
      setDraft(EMPTY_DRAFT);
      setMessage({ kind: 'ok', text: '已保存。后台宿主已收到这条提醒。' });
      await refreshRuntime();
    } catch (error) {
      // 后端的校验消息原样显示：它比界面自己再判断一次更接近事实
      if (alive.current) setMessage({ kind: 'error', text: String(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      setReminders(await deleteReminder(id));
      if (alive.current) setMessage(null);
      await refreshRuntime();
    } catch (error) {
      if (alive.current) setMessage({ kind: 'error', text: String(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    try {
      setReminders(await setReminderEnabled(id, enabled));
      await refreshRuntime();
    } catch (error) {
      if (alive.current) setMessage({ kind: 'error', text: String(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  /**
   * 立刻试响一次。
   *
   * 刻意**不做任何本地提示音或本地通知**：如果这里自己弹一个东西，
   * 用户就无法分辨"是真的走通了后台"还是"界面自己演了一下"。
   * 它唯一的可见结果应当是通知中心里真的多出一条提醒。
   */
  const handleTryNow = async (id: string) => {
    setBusy(true);
    try {
      const outcome = await runReminderNow(id);
      if (!alive.current) return;

      setMessage(
        outcome.ok
          ? {
              kind: 'ok',
              text: '已触发。去通知中心看看 —— 那条提醒应当已经出现在那里。',
            }
          : {
              kind: 'error',
              text: `触发失败：${outcome.error ?? '未知原因'}${
                runtime?.hostRunning === false ? '（后台宿主当前未运行）' : ''
              }`,
            }
      );
      await refreshRuntime();
    } catch (error) {
      if (alive.current) setMessage({ kind: 'error', text: String(error) });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const enabledCount = reminders.filter((item) => item.enabled).length;

  return (
    <div className="px-4 lg:px-6 py-5">
      {/* ── 后台计时状态 ───────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-gray-800 flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" />
              后台计时
            </h3>
            {runtime === null ? (
              <p className="mt-1 text-[11px] text-gray-400">（读取中…）</p>
            ) : runtime.ok ? (
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                后台宿主正在计时，当前有 {runtime.runtime.length} 条启用的提醒。
                窗口关掉之后它依然会响。
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-gray-500 leading-relaxed">
                {runtime.hostRunning
                  ? `后台宿主在运行，但没有正在计时的提醒${
                      enabledCount > 0 ? '——同步可能还没跟上，刷新一次试试' : ''
                    }。`
                  : '后台宿主当前未运行，因此现在没有在计时。' +
                    (enabledCount > 0
                      ? '提醒会在后台第一次被用到时自动重新排程，或点「现在试一下」立刻拉起它。'
                      : '')}
              </p>
            )}

            {/* 定义与运行态不一致时如实说明，而不是假装一切正常 */}
            {runtime?.ok && runtime.enabledDefinitions !== runtime.runtime.length && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-700">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                应用侧启用了 {runtime.enabledDefinitions} 条，后台只认 {runtime.runtime.length} 条
                —— 同步没跟上。点「现在试一下」或重启后会自动重新同步。
              </p>
            )}

            {runtime?.error && (
              <p className="mt-1 text-[11px] text-gray-400">后台回报：{runtime.error}</p>
            )}
          </div>

          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={busy}
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </section>

      {message && (
        <div
          className={`mb-5 px-3 py-2 rounded-lg flex items-start gap-2 text-xs border ${
            message.kind === 'error'
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-emerald-50 border-emerald-200 text-emerald-700'
          }`}
        >
          {message.kind === 'error' ? (
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          )}
          <span className="break-words">{message.text}</span>
        </div>
      )}

      {/* ── 已有提醒 ───────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-4 mb-5">
        <h3 className="text-sm font-medium text-gray-800 mb-3">
          已有提醒（{reminders.length} 条，{enabledCount} 条启用）
        </h3>

        {reminders.length === 0 ? (
          <p className="py-3 text-[11px] text-gray-500 leading-relaxed">
            还没有提醒。下面加一条试试 —— 比如「每 60 分钟」提醒自己起来走走。
          </p>
        ) : (
          <ul className="space-y-2">
            {reminders.map((reminder) => {
              const state = runtimeById.get(reminder.id);
              return (
                <li
                  key={reminder.id}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2.5"
                >
                  <div className="flex items-start gap-3">
                    <Bell
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        reminder.enabled ? 'text-indigo-500' : 'text-gray-300'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-800 break-words">{reminder.title}</p>
                      <p className="mt-0.5 text-[11px] text-gray-500">
                        {describeKind(reminder)}
                        {reminder.body && (
                          <span className="text-gray-400"> · {reminder.body}</span>
                        )}
                      </p>

                      {/* 下一次什么时候响：**只显示后台回报的值** */}
                      <p className="mt-1 text-[11px] text-gray-400">
                        {!reminder.enabled ? (
                          '已停用 —— 不会被推送给后台，因此不会响'
                        ) : state && state.nextAt !== null ? (
                          <>
                            下一次：{formatAbsoluteTime(state.nextAt)}（
                            {formatRelative(state.nextAt, now)}）
                            {state.fireCount > 0 && ` · 已响过 ${state.fireCount} 次`}
                          </>
                        ) : state ? (
                          '这条已经不再等待触发'
                        ) : runtime?.hostRunning ? (
                          '后台没有报告这条的状态 —— 同步可能还没跟上'
                        ) : (
                          '后台未运行，当前没有在计时'
                        )}
                      </p>
                    </div>

                    <div className="shrink-0 flex items-center gap-1.5">
                      <Toggle
                        checked={reminder.enabled}
                        onChange={(next) => void handleToggle(reminder.id, next)}
                      />
                      <button
                        type="button"
                        onClick={() => void handleTryNow(reminder.id)}
                        disabled={busy}
                        title="立刻触发一次，并让通知中心里出现一条真的提醒"
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                      >
                        <Play className="w-3 h-3" />
                        试一下
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(reminder.id)}
                        disabled={busy}
                        title="删除这条提醒"
                        aria-label={`删除 ${reminder.title}`}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── 新建 ──────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-200 px-5 py-4">
        <h3 className="text-sm font-medium text-gray-800 mb-3 flex items-center gap-2">
          <Plus className="w-4 h-4 text-gray-400" />
          新建提醒
        </h3>

        <div className="space-y-3">
          <label className="block">
            <span className="text-[11px] text-gray-500">标题</span>
            <input
              type="text"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="起来走走"
              className="mt-1 w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-gray-500">内容（可留空）</span>
            <input
              type="text"
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="已经坐了一小时"
              className="mt-1 w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
          </label>

          <div>
            <span className="text-[11px] text-gray-500">重复方式</span>
            <div
              className="mt-1 grid grid-cols-3 gap-2"
              role="radiogroup"
              aria-label="提醒的重复方式"
            >
              {(
                [
                  { value: 'interval', label: '每隔一段时间' },
                  { value: 'daily', label: '每天某时刻' },
                  { value: 'once', label: '只提醒一次' },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === option.value}
                  onClick={() => setDraft({ ...draft, kind: option.value })}
                  className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                    draft.kind === option.value
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {draft.kind === 'interval' && (
            <label className="block">
              <span className="text-[11px] text-gray-500">间隔（分钟，最少 1 分钟）</span>
              <input
                type="number"
                min={1}
                value={draft.intervalMinutes}
                onChange={(e) => setDraft({ ...draft, intervalMinutes: e.target.value })}
                className="mt-1 w-40 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          )}

          {draft.kind === 'daily' && (
            <label className="block">
              <span className="text-[11px] text-gray-500">每日时刻（本地时间）</span>
              <input
                type="time"
                value={draft.dailyAt}
                onChange={(e) => setDraft({ ...draft, dailyAt: e.target.value })}
                className="mt-1 w-40 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          )}

          {draft.kind === 'once' && (
            <label className="block">
              <span className="text-[11px] text-gray-500">提醒时刻（必须在将来）</span>
              <input
                type="datetime-local"
                value={draft.onceAt}
                onChange={(e) => setDraft({ ...draft, onceAt: e.target.value })}
                className="mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
              />
            </label>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[11px] text-gray-400 leading-relaxed">
              提醒由后台进程计时，因此窗口关掉之后它依然会响。
            </p>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              保存提醒
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default ReminderSettings;
