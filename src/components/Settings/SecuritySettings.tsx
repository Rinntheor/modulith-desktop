// src/components/Settings/SecuritySettings.tsx
//
// 「设置 → 安全」分页：授权总览、设备白名单、登录审计、访问密钥管理。
//
// 迁移自 hive_atelier 的安全中心，改进点：
//   * 概览数据全部来自后端真实状态（hive_atelier 把剩余次数写死成 5、封锁写死 false）
//   * 设备列表可移除，且移除会真正踢掉该设备的会话
//   * 登录日志带「结果」列（ok / bad-key / blocked / rate-limited …）
//   * 明确区分「修改密钥」与「关闭授权」，关闭前有明确的后果说明

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  MonitorSmartphone,
  ScrollText,
  RefreshCw,
  Loader2,
  Trash2,
  CheckCircle,
  AlertCircle,
  Lock,
  Unlock,
  Fingerprint,
  LifeBuoy,
} from 'lucide-react';
import {
  MIN_KEY_LENGTH,
  changeAccessKey,
  clearLoginLogs,
  describeOutcome,
  formatBlockedUntil,
  formatDateTime,
  generateRecoveryCode,
  getHardwareFingerprint,
  getKnownDevices,
  getLoginLogs,
  getSecurityOverview,
  removeKnownDevice,
  setAutoLogin,
  setRequireAuth,
  type HardwareFingerprint,
  type KnownDevice,
  type LoginLogEntry,
  type SecurityOverview,
} from '../../services/auth';
import { refreshAuth } from '../../services/authStore';
import RecoveryCodePanel from '../../features/auth/RecoveryCodePanel';

/**
 * 一次生成的恢复码数量。
 *
 * 必须与后端 `crypto::RECOVERY_CODE_COUNT` 保持一致 —— 这里只用于显示
 * 「剩余 N / 总数」，不做任何校验判断，因此不同步也不会导致功能错误，
 * 只会让分母显示得不对。改动后端数量时请一并改这里。
 */
const RECOVERY_CODE_COUNT = 3;

// ============================================================
// 小组件
// ============================================================

const Card: React.FC<{ title: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; action?: React.ReactNode }> = ({
  title,
  icon: Icon,
  children,
  action,
}) => (
  <section className="bg-white rounded-xl border border-gray-200 px-5 py-2 mb-5">
    <div className="flex items-center justify-between pt-3">
      <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {title}
      </h3>
      {action}
    </div>
    {children}
  </section>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="flex items-start justify-between gap-6 py-3.5 border-b border-gray-100 last:border-0">
    <div className="min-w-0">
      <p className="text-sm font-medium text-gray-800">{label}</p>
      {hint && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{hint}</p>}
    </div>
    <div className="shrink-0 pt-0.5">{children}</div>
  </div>
);

const Toggle: React.FC<{ checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }> = ({
  checked,
  onChange,
  disabled,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 ${
      checked ? 'bg-indigo-600' : 'bg-gray-300'
    }`}
  >
    <motion.span
      initial={false}
      animate={{ x: checked ? 16 : 2 }}
      transition={{ type: 'spring', stiffness: 600, damping: 35 }}
      className="inline-block h-4 w-4 rounded-full bg-white shadow"
    />
  </button>
);

const StatTile: React.FC<{
  label: string;
  value: string;
  tone: string;
  icon: React.ComponentType<{ className?: string }>;
}> = ({ label, value, tone, icon: Icon }) => (
  <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-4 py-3">
    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${tone}`}>
      <Icon className="w-4 h-4" />
    </div>
    <div className="min-w-0">
      <p className="text-base font-semibold text-gray-900 leading-none truncate">{value}</p>
      <p className="text-[11px] text-gray-500 mt-1">{label}</p>
    </div>
  </div>
);

// ============================================================
// 主组件
// ============================================================

const SecuritySettings: React.FC = () => {
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [devices, setDevices] = useState<KnownDevice[]>([]);
  const [logs, setLogs] = useState<LoginLogEntry[]>([]);
  const [fingerprint, setFingerprint] = useState<HardwareFingerprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // 修改密钥表单
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [oldKey, setOldKey] = useState('');
  const [newKey, setNewKey] = useState('');
  const [confirmKey, setConfirmKey] = useState('');

  // 新生成的恢复码（生成后立刻展示，关闭即无法再取回）
  const [issuedRecoveryCodes, setIssuedRecoveryCodes] = useState<string[]>([]);

  const flash = useCallback((kind: 'ok' | 'error', text: string, ms = 4000) => {
    setFeedback({ kind, text });
    setTimeout(() => setFeedback(null), ms);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextOverview, nextDevices, nextLogs] = await Promise.all([
        getSecurityOverview(),
        getKnownDevices(),
        getLoginLogs(),
      ]);
      setOverview(nextOverview);
      setDevices(nextDevices);
      setLogs(nextLogs);
    } catch (error) {
      flash('error', error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    void load();
    getHardwareFingerprint()
      .then(setFingerprint)
      .catch(() => setFingerprint(null));
  }, [load]);

  // ---------- 操作 ----------

  const handleRequireAuth = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await setRequireAuth(enabled);
        await refreshAuth();
        await load();
        flash('ok', enabled ? '已开启：启动需要访问密钥' : '已关闭：启动将直接进入应用');
      } catch (error) {
        flash('error', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [flash, load]
  );

  const handleAutoLogin = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await setAutoLogin(enabled);
        await load();
        flash('ok', enabled ? '已开启「记住我」' : '已关闭「记住我」，凭据已删除');
      } catch (error) {
        flash('error', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [flash, load]
  );

  const handleChangeKey = useCallback(async () => {
    if (newKey.length < MIN_KEY_LENGTH) {
      flash('error', `新密钥至少需要 ${MIN_KEY_LENGTH} 个字符`);
      return;
    }
    if (newKey !== confirmKey) {
      flash('error', '两次输入的新密钥不一致');
      return;
    }

    setBusy(true);
    try {
      await changeAccessKey(oldKey, newKey);
      setOldKey('');
      setNewKey('');
      setConfirmKey('');
      setShowKeyForm(false);
      await load();
      flash('ok', '访问密钥已更新');
    } catch (error) {
      flash('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [confirmKey, flash, load, newKey, oldKey]);

  const handleRemoveDevice = useCallback(
    async (device: KnownDevice) => {
      setBusy(true);
      try {
        await removeKnownDevice(device.deviceId);
        await load();
        flash('ok', `已移除设备「${device.label}」及其会话`);
      } catch (error) {
        flash('error', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [flash, load]
  );

  const handleClearLogs = useCallback(async () => {
    setBusy(true);
    try {
      await clearLoginLogs();
      await load();
      flash('ok', '登录日志已清空');
    } catch (error) {
      flash('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [flash, load]);

  /** 重新生成整套恢复码：旧码全部立即失效，新码只显示这一次 */
  const handleGenerateRecovery = useCallback(async () => {
    setBusy(true);
    try {
      const codes = await generateRecoveryCode();
      setIssuedRecoveryCodes(codes);
      await load();
      flash('ok', `已生成 ${codes.length} 枚新恢复码，旧的已全部失效`);
    } catch (error) {
      flash('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [flash, load]);

  const sessionText = useMemo(() => {
    if (!overview) return '—';
    const hours = overview.sessionRemainingHours;
    if (hours <= 0) return '已过期';
    if (hours < 1) return `${Math.round(hours * 60)} 分钟`;
    return `${hours.toFixed(1)} 小时`;
  }, [overview]);

  if (loading && !overview) {
    return (
      <div className="px-6 py-10 flex items-center justify-center">
        <Loader2 className="w-5 h-5 text-indigo-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-6 py-5">
      {/* 反馈 */}
      <AnimatePresence>
        {feedback && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className={`mb-5 px-3 py-2 rounded-lg flex items-center gap-2 text-xs border overflow-hidden ${
              feedback.kind === 'error'
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-emerald-50 border-emerald-200 text-emerald-700'
            }`}
          >
            {feedback.kind === 'error' ? (
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
            )}
            <span className="break-all">{feedback.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 概览 */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <StatTile
          label="当前会话剩余"
          value={sessionText}
          tone="bg-indigo-50 text-indigo-600"
          icon={ShieldCheck}
        />
        <StatTile
          label="已知设备"
          value={`${overview?.knownDeviceCount ?? 0} 台`}
          tone="bg-violet-50 text-violet-600"
          icon={MonitorSmartphone}
        />
      </div>

      {overview?.blocked && (
        <div className="mb-5 flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>
            本机已被临时锁定
            {overview.blockedUntil ? `，解封倒计时 ${formatBlockedUntil(overview.blockedUntil)}` : ''}
          </span>
        </div>
      )}

      {/* 访问控制 */}
      <Card title="访问控制" icon={Lock}>
        <Row label="需要访问密钥" hint="关闭后启动应用将直接进入主界面，不再要求解锁">
          <Toggle
            checked={overview?.requireAuth ?? true}
            disabled={busy}
            onChange={handleRequireAuth}
          />
        </Row>
        <Row
          label="记住我"
          hint="开启后本机会自动解锁；凭据用硬件指纹加密，换机或改硬件即失效"
        >
          <Toggle
            checked={overview?.autoLogin ?? false}
            disabled={busy}
            onChange={handleAutoLogin}
          />
        </Row>
        <Row
          label="访问密钥"
          hint={
            overview?.keyUpdatedAt
              ? `最近修改：${formatDateTime(overview.keyUpdatedAt)}`
              : '尚未记录修改时间'
          }
        >
          <button
            onClick={() => setShowKeyForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {showKeyForm ? '收起' : '修改密钥'}
          </button>
        </Row>

        <AnimatePresence>
          {showKeyForm && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="pb-4 space-y-2.5">
                {[
                  { label: '原访问密钥', value: oldKey, set: setOldKey },
                  { label: '新访问密钥', value: newKey, set: setNewKey },
                  { label: '确认新密钥', value: confirmKey, set: setConfirmKey },
                ].map((field) => (
                  <div key={field.label}>
                    <label className="block text-[11px] text-gray-500 mb-1">{field.label}</label>
                    <input
                      type="password"
                      value={field.value}
                      onChange={(e) => field.set(e.target.value)}
                      autoComplete="off"
                      className="w-full px-3 py-2 text-sm font-mono bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                ))}
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    onClick={() => {
                      setShowKeyForm(false);
                      setOldKey('');
                      setNewKey('');
                      setConfirmKey('');
                    }}
                    disabled={busy}
                    className="px-3.5 py-2 text-xs rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleChangeKey}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50"
                  >
                    {busy && <Loader2 className="w-3 h-3 animate-spin" />}
                    确认修改
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* 恢复码：忘记访问密钥时的唯一自救通道 */}
      <Card
        title="密钥恢复"
        icon={LifeBuoy}
        action={
          <button
            onClick={handleGenerateRecovery}
            disabled={busy}
            className="px-2.5 py-1.5 text-[11px] rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {overview?.hasRecoveryCode ? '重新生成' : '生成恢复码'}
          </button>
        }
      >
        <Row
          label="恢复码"
          hint={
            overview?.hasRecoveryCode
              ? '忘记访问密钥时用它重置。每枚各能用一次，用过即作废；其余不受影响'
              : '尚未生成。此时忘记访问密钥将无法自救——只能删除 auth.json 重新初始化'
          }
        >
          <span
            className={`px-1.5 py-0.5 text-[10px] rounded-full border ${
              overview?.hasRecoveryCode
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}
          >
            {overview?.hasRecoveryCode
              ? `剩余 ${overview.remainingRecoveryCodes} / ${RECOVERY_CODE_COUNT} 枚`
              : '未生成'}
          </span>
        </Row>

        {overview?.hasRecoveryCode && overview.recoveryCreatedAt && (
          <Row
            label="生成时间"
            hint="作废旧恢复码的唯一方式是「重新生成」——它会把整套换成新的"
          >
            <span className="text-xs text-gray-600">
              {formatDateTime(overview.recoveryCreatedAt)}
            </span>
          </Row>
        )}

        {/* 剩得不多时提前提醒：等用光了才发现就晚了 */}
        {overview?.hasRecoveryCode && overview.remainingRecoveryCodes <= 1 && (
          <div className="pb-4">
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-300 text-[11px] text-amber-900 leading-relaxed">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
              <span>
                只剩 {overview.remainingRecoveryCodes} 枚可用。
                用完后「忘记访问密钥」将无法自救，建议现在重新生成一套。
              </span>
            </div>
          </div>
        )}

        {!overview?.hasRecoveryCode && (
          <div className="pb-4">
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 leading-relaxed">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                恢复码是访问密钥的唯一补救手段。密钥使用 Argon2id 单向哈希存储，
                没有任何后门可以绕过——没有恢复码，忘记密钥就等于丢失本机的授权状态。
              </span>
            </div>
          </div>
        )}

        {issuedRecoveryCodes.length > 0 && (
          <div className="pb-4">
            <RecoveryCodePanel
              codes={issuedRecoveryCodes}
              reason="regenerate"
              createdAt={overview?.recoveryCreatedAt}
              onContinue={() => setIssuedRecoveryCodes([])}
            />
          </div>
        )}
      </Card>

      {/* 硬件绑定 */}
      <Card title="硬件绑定" icon={Fingerprint}>
        <Row label="主机名" hint="参与硬件绑定密钥的派生">
          <span className="text-xs font-mono text-gray-600">{fingerprint?.hostname ?? '—'}</span>
        </Row>
        <Row label="系统 / CPU">
          <span className="text-xs text-gray-600">
            {fingerprint ? `${fingerprint.osId} · ${fingerprint.cpuCores} 核` : '—'}
          </span>
        </Row>
        <Row label="网卡 MAC" hint="虚拟网卡的全零地址会被忽略">
          <span className="text-xs font-mono text-gray-600">
            {fingerprint?.macAddress ?? '未检测到'}
          </span>
        </Row>
      </Card>

      {/* 设备 */}
      <Card
        title="已知设备"
        icon={MonitorSmartphone}
        action={
          <button
            onClick={() => void load()}
            disabled={loading}
            title="刷新"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        }
      >
        {devices.length === 0 ? (
          <p className="text-xs text-gray-500 py-3.5">还没有记录任何设备。</p>
        ) : (
          <div className="pb-2">
            {devices.map((device) => (
              <div
                key={device.deviceId}
                className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0"
              >
                <div className="w-8 h-8 rounded-lg bg-gray-50 border border-gray-200 flex items-center justify-center shrink-0">
                  <MonitorSmartphone className="w-3.5 h-3.5 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-gray-800 truncate">{device.label}</p>
                    {device.isCurrent && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
                        当前设备
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-400 font-mono truncate">
                    {device.deviceId.slice(0, 16)}… · 最近 {formatDateTime(device.lastSeen)}
                  </p>
                </div>
                <button
                  onClick={() => handleRemoveDevice(device)}
                  disabled={busy}
                  title="移除设备并结束其会话"
                  className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 登录日志 */}
      <Card
        title="登录记录"
        icon={ScrollText}
        action={
          <div className="flex items-center gap-1">
            <button
              onClick={handleClearLogs}
              disabled={busy || logs.length === 0}
              className="px-2.5 py-1.5 text-[11px] rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
            >
              清空
            </button>
            <button
              onClick={() => void load()}
              disabled={loading}
              title="刷新"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        }
      >
        {logs.length === 0 ? (
          <p className="text-xs text-gray-500 py-3.5">暂无登录记录。</p>
        ) : (
          <div className="pb-2 max-h-72 overflow-y-auto custom-scrollbar">
            {logs.map((log, index) => (
              <div
                key={`${log.timestamp}-${index}`}
                className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    log.success ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-700 truncate">
                    {describeOutcome(log.outcome)}
                  </p>
                  <p className="text-[11px] text-gray-400 truncate">{log.deviceLabel}</p>
                </div>
                <span className="text-[11px] text-gray-400 shrink-0">
                  {formatDateTime(log.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
        {overview?.requireAuth ? (
          <>
            <Lock className="w-3 h-3" />
            应用当前处于「需要访问密钥」状态，重启后需要重新解锁。
          </>
        ) : (
          <>
            <Unlock className="w-3 h-3" />
            已关闭访问密钥，任何能打开这台电脑的人都可以直接进入应用。
          </>
        )}
      </p>
    </div>
  );
};

export default SecuritySettings;
