// src/features/auth/AuthScreen.tsx
//
// 授权界面：解锁 / 首次初始化 / 用恢复码重置。
//
// 职责边界（重构后）：这里只负责**与用户交互**并把结果写入 authStore。
// 「记住我自动登录」「读取状态」「解锁后继续初始化」全部属于启动流程，
// 由 services/boot.ts 编排；因此本组件不再自己判断启动顺序，
// 也不再 `window.location.reload()` —— 解锁成功后 boot 会从断点继续。
//
// 另外修正了从 hive_atelier 带过来的两个问题：
//   1. 不做 `sanitizeInput` 字符过滤：原实现会删掉密钥里的 `< > ' "`，
//      当初用这些字符设置的密钥将永远无法解锁。
//   2. 不人为 setTimeout 拖慢解锁：防时序攻击靠 Argon2id 的常数时间比较。
//
// 恢复码（忘记密钥的退路）在本界面的两个位置出现：
//   * 首次创建密钥成功后 → 展示一次性恢复码，确认保存后才放行；
//   * 解锁界面点「忘记访问密钥」 → 输入恢复码 + 新密钥，随后展示换发的新恢复码。

import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  LifeBuoy,
  ArrowLeft,
} from 'lucide-react';
import {
  MIN_KEY_LENGTH,
  formatBlockedUntil,
  resetAccessKeyWithRecoveryCode,
  setupAccessKey,
  unlock,
  verifyRecoveryCode,
  type AuthStatus,
} from '../../services/auth';
import { getCachedAuth, refreshAuth } from '../../services/authStore';
import { bootManager } from '../../services/boot';
import { getHostVersion } from '../../services/pluginRuntime';
import { useReduceMotion } from '../../hooks/usePerformanceMode';
import KeyInput from './KeyInput';
import ParticleBackground from './ParticleBackground';
import RecoveryCodePanel from './RecoveryCodePanel';
import AppLogo from '../../components/icons/AppLogo';
import {
  buttonVariants,
  containerVariants,
  formVariants,
  logoVariants,
  titleVariants,
} from './animations';

/**
 * 授权界面的模式。
 *
 * `recover`（输入恢复码）与 `recoverNewKey`（设置新密钥）**刻意分成两个模式**，
 * 而不是把三个输入框放在同一个表单里。
 *
 * 原因是一个真实的可用性问题：三步合一时只要出错，错误提示与自动聚焦都会
 * 落在第一个输入框上，用户看到"恢复码"被标红就会怀疑是自己恢复码输错了，
 * 而实际可能是下面新密钥的格式问题 —— 即便下方另有提示，视线也已经被带走。
 *
 * 拆开之后每个屏幕只有一个待完成的动作：
 *   第一步只校验恢复码，出错就明确说恢复码不对；
 *   第二步只校验新密钥，恢复码此时已核验通过并显示为只读。
 */
type Mode = 'setup' | 'unlock' | 'recover' | 'recoverNewKey' | 'created';

const AuthScreen: React.FC = () => {
  const cached: AuthStatus | null = getCachedAuth();
  const [mode, setMode] = useState<Mode>(cached?.initialized === false ? 'setup' : 'unlock');
  const [status, setStatus] = useState<AuthStatus | null>(cached);
  const [key, setKey] = useState('');
  const [confirmKey, setConfirmKey] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  /** 第一步核验通过后签发的一次性令牌，供第二步设置新密钥使用 */
  const [recoveryToken, setRecoveryToken] = useState('');
  const [issuedCodes, setIssuedCodes] = useState<string[]>([]);
  /** 恢复码的生成时间，用于打印件的时间戳 */
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rememberMe, setRememberMe] = useState(cached?.autoLogin ?? false);

  /** 有效动效开关：「关闭动画」或「性能模式」任一开启时，装饰性循环不再挂载 */
  const reduceMotion = useReduceMotion();

  // 初始化期间产生的告警（例如「记住我」凭据已失效）在这里给用户一句解释
  const [notice] = useState(() => {
    const warnings = bootManager.getState().warnings;
    return warnings.length > 0 ? warnings[warnings.length - 1] : '';
  });

  /**
   * 是否处于「用户主动锁定」状态。
   *
   * 用于解释「我明明开了记住我，为什么还要输密钥」—— 否则用户会以为
   * 「记住我」坏了。这不是错误，是用户自己要求的锁定。
   */
  const lockedByUser = Boolean(status?.lockedByUser);

  // 未初始化 → 引导创建密钥；已初始化 → 解锁
  useEffect(() => {
    if (!cached) return;
    setStatus(cached);
    // 正在展示恢复码时不要被状态刷新打断
    setMode((current) => (current === 'created' ? current : cached.initialized ? 'unlock' : 'setup'));
    setRememberMe(cached.autoLogin);
  }, [cached]);

  /**
   * 恢复码确认保存后：刷新授权状态，让 boot 从断点继续。
   *
   * 这里做了三件事，缺一不可 —— 之前只有中间那一件，用户点「继续」后就卡住了：
   *
   *   1. 清掉已展示的恢复码（它们已经没用了，留在内存里没有意义）；
   *   2. `refreshAuth()` 让 boot 状态机感知到「已解锁」并从断点继续；
   *   3. **把 mode 切回 `unlock`** 作为兜底。若 boot 因为任何原因没有继续
   *      （例如某个关键初始化步骤在中途已经失败），界面至少会回到一个可用
   *      状态 —— 此时会话已经建立，用户能立刻用新密钥解锁，而不会对着一个
   *      空白的"已保存"面板发呆。
   */
  const finishIssuedCode = useCallback(async () => {
    setIssuedCodes([]);
    setMode('unlock');
    try {
      await refreshAuth();
    } catch (err) {
      // 不吞掉错误：状态刷新失败时用户需要知道"解锁可能没生效"
      setError(
        `已保存恢复码，但刷新授权状态失败：${err instanceof Error ? err.message : String(err)}。请用新访问密钥解锁。`
      );
    }
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;

      setError('');

      /*
       * 恢复流程第一步：只核验恢复码。
       *
       * 这一步不校验新密钥（此时用户还没输入），因此任何报错都必然是
       * 恢复码本身的问题 —— 提示落在恢复码输入框上就是准确的。
       */
      if (mode === 'recover') {
        if (!recoveryCode.trim()) {
          setError('请输入恢复码');
          return;
        }

        setBusy(true);
        try {
          const result = await verifyRecoveryCode(recoveryCode);

          if (result.verified && result.token) {
            setRecoveryToken(result.token);
            // 进入第二步：新密钥表单，恢复码置为只读摘要
            setKey('');
            setConfirmKey('');
            setMode('recoverNewKey');
            return;
          }

          const blockedFor = formatBlockedUntil(result.blockedUntil);
          setError(
            blockedFor
              ? `尝试次数过多，请在 ${blockedFor}后重试`
              : (result.message ?? '恢复码不正确')
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
        return;
      }

      /*
       * 恢复流程第二步：用令牌设置新密钥。
       *
       * 恢复码此时已经核验通过，因此这里的所有校验都只针对新密钥，
       * 提示也只可能出现在两个新密钥输入框上。
       */
      if (mode === 'recoverNewKey') {
        if (key.length < MIN_KEY_LENGTH) {
          setError(`新访问密钥至少需要 ${MIN_KEY_LENGTH} 个字符`);
          return;
        }
        if (key !== confirmKey) {
          setError('两次输入的新访问密钥不一致');
          return;
        }

        setBusy(true);
        try {
          const response = await resetAccessKeyWithRecoveryCode(recoveryToken, key);
          if (response.success) {
            /*
             * 重置成功。
             *
             * **不再展示换发的恢复码** —— 后端只作废了被用掉的那一枚，
             * 其余保留（换发会把整套交给重置者，若重置者是攻击者，
             * 合法用户就被永久锁在门外）。
             *
             * 因此这里直接刷新授权状态让 boot 从断点继续；同时把 mode 切回
             * `unlock` 作为兜底，避免 boot 未推进时停在一个空的展示面板上。
             */
            setRecoveryCode('');
            setRecoveryToken('');
            setKey('');
            setConfirmKey('');

            // 剩余枚数告知用户：他需要知道手里还有几张纸可用
            const left = response.remainingRecoveryCodes;
            if (left === 0) {
              setError(
                '访问密钥已重置，但这组恢复码已经用完。请进入「设置 → 安全 → 密钥恢复」重新生成一套。'
              );
            }

            setMode('unlock');
            try {
              await refreshAuth();
            } catch (refreshError) {
              setError(
                `访问密钥已重置，但刷新授权状态失败：${
                  refreshError instanceof Error ? refreshError.message : String(refreshError)
                }。请用新访问密钥解锁。`
              );
            }
            return;
          }
          setError('重置失败，请重试');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          // 令牌失效（过期 / 已被使用）→ 退回第一步重新核验恢复码，
          // 而不是让用户对着一个永远失败的表单反复点
          if (message.includes('恢复凭据已失效')) {
            setRecoveryToken('');
            setMode('recover');
          }
        } finally {
          setBusy(false);
        }
        return;
      }

      if (key.length < MIN_KEY_LENGTH) {
        setError(`访问密钥至少需要 ${MIN_KEY_LENGTH} 个字符`);
        return;
      }
      if (mode === 'setup' && key !== confirmKey) {
        setError('两次输入的访问密钥不一致');
        return;
      }

      setBusy(true);
      try {
        if (mode === 'setup') {
          const response = await setupAccessKey(key);
          // 首次创建：必须在进入应用前把恢复码交给用户
          setIssuedCodes(response.recoveryCodes);
          setIssuedAt(new Date().toISOString());
          setKey('');
          setConfirmKey('');
          setMode('created');
          return;
        }

        const response = await unlock(key, rememberMe);

        if (response.success) {
          // 刷新授权状态 → boot 状态机据此从断点继续执行剩余初始化
          await refreshAuth();
          return;
        }

        const remaining = response.securityInfo?.remainingAttempts ?? 0;
        const blockedFor = formatBlockedUntil(response.securityInfo?.blockedUntil);
        if (blockedFor) {
          setError(`尝试次数过多，请在 ${blockedFor}后重试`);
        } else if (response.securityInfo?.message) {
          setError(response.securityInfo.message);
        } else {
          setError(`访问密钥不正确，还可尝试 ${remaining} 次`);
        }
        setKey('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, confirmKey, key, mode, recoveryCode, recoveryToken, rememberMe]
  );

  const isSetup = mode === 'setup';
  const isRecover = mode === 'recover';
  const isRecoverNewKey = mode === 'recoverNewKey';
  const isCreated = mode === 'created';
  const blocked = Boolean(status?.blocked);
  const blockedFor = formatBlockedUntil(status?.blockedUntil);
  const remaining = status?.remainingAttempts;
  // 没有恢复码时不提供「忘记密钥」入口 —— 那会是个死胡同
  const canRecover = Boolean(status?.hasRecoveryCode);
  /** 剩余可用的恢复码枚数，用于在第一步提示用户「还有几枚」 */
  const remainingCodes = status?.remainingRecoveryCodes ?? 0;

  const subtitle = isCreated
    ? '请立即保存下面这串恢复码'
    : isRecover
      ? '第 1 步：输入你的恢复码'
      : isRecoverNewKey
        ? '第 2 步：设置新的访问密钥'
        : isSetup
          ? '首次使用：为这台设备创建一个访问密钥'
          : '输入访问密钥以继续';

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="fixed inset-0 z-40 flex items-center justify-center bg-linear-to-br from-gray-900 via-gray-800 to-gray-900 p-6 overflow-y-auto"
    >
      {/*
        粒子背景：18 个粒子各自带一条 `repeat: Infinity` 的循环（y / opacity / scale）。

        它必须被显式关掉，而不能指望 framer-motion 的 reducedMotion —— 实测
        framer-motion 12 只对**位置类**属性（transform / width / height / inset）
        短路，`opacity` 不在其中，因此那条透明度循环会永远跑下去（18 条 rAF 动画
        + 18 个合成层）。这是「关了动画还在卡」里最实在的一条：授权界面默认每次
        启动都会出现。

        关掉它没有任何功能损失：这些粒子不承载任何信息。
      */}
      {!reduceMotion && <ParticleBackground />}
      {/*
        两个装饰球。

        **尺寸与模糊必须跟随窗口**，否则窗口一放大两球就从「交叉」变成「各据一角」
        （位置是百分比、尺寸固定时，重叠条件 `尺寸 > 0.25 × 窗口宽` 会失效）。

        这里走**内联样式**而不是 Tailwind 任意值：上一版写的是 `w-[36vmax]` /
        `blur-[3.5vmax]`，实测没有生成对应规则 —— 而 `absolute` 元素没有宽高就是
        0×0，两个球直接「消失」了。对这类必须生效的尺寸，内联样式不依赖类名扫描，
        可靠得多。
      */}
      <div
        className="absolute top-1/4 left-1/4 bg-indigo-500/10 rounded-full"
        style={{ width: '36vmax', height: '36vmax', filter: 'blur(3.5vmax)' }}
      />
      <div
        className="absolute bottom-1/4 right-1/4 bg-violet-500/10 rounded-full"
        style={{ width: '36vmax', height: '36vmax', filter: 'blur(3.5vmax)' }}
      />

      {/* py-12 给顶部的窗口边框（BootChrome，高 2.5rem）留出空间，
          让内容在视觉上仍然居中 */}
      <div className="relative w-full max-w-sm py-12">
        {/* 应用标识 */}
        <motion.div variants={logoVariants} className="mb-8 text-center">
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.97 }}
            className="mx-auto mb-5 w-20 h-20 cursor-pointer"
          >
            {/* 授权界面本就是深色，用带底板的主视觉版本 */}
            <motion.div
              animate={{ scale: [1, 1.04, 1] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <AppLogo className="w-20 h-20" withSurface shadow />
            </motion.div>
          </motion.div>

          <motion.h1 variants={titleVariants} className="text-2xl font-bold text-white mb-2">
            Modulith Desktop
          </motion.h1>
          <motion.p variants={titleVariants} className="text-sm text-gray-400">
            {subtitle}
          </motion.p>
        </motion.div>

        {/* 锁定 / 提示 */}
        <AnimatePresence>
          {blocked && !isCreated && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-4 flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-sm text-amber-300"
            >
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>该设备已被临时锁定{blockedFor ? `，请在 ${blockedFor}后重试` : ''}</span>
            </motion.div>
          )}
          {notice && !blocked && !isCreated && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-4 flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-gray-700/30 border border-gray-600/40 text-xs text-gray-300"
            >
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 恢复码展示：占用表单位置，确认后才继续 */}
        {isCreated ? (
          <RecoveryCodePanel
            codes={issuedCodes}
            reason="setup"
            createdAt={issuedAt}
            onContinue={finishIssuedCode}
          />
        ) : (
          <motion.form variants={formVariants} onSubmit={handleSubmit} className="space-y-5">
            {isSetup && (
              <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                <Sparkles className="w-4 h-4 text-indigo-300 mt-0.5 shrink-0" />
                <p className="text-xs text-indigo-200 leading-relaxed">
                  密钥只保存 Argon2id 哈希，无法找回。创建后会给你一枚
                  <span className="font-medium">恢复码</span>
                  ——那是忘记密钥时唯一的自救通道，请务必离线保存。
                </p>
              </div>
            )}

            {/*
              恢复流程第一步：只有恢复码一个输入框。
              这样出错时"恢复码不对"的提示落在它身上就是准确的。
            */}
            {isRecover && (
              <>
                <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-amber-500/10 border border-amber-500/25">
                  <LifeBuoy className="w-4 h-4 text-amber-300 mt-0.5 shrink-0" />
                  <div className="text-xs text-amber-100 leading-relaxed space-y-1">
                    <p>
                      输入你保存的<strong className="text-white">任意一枚</strong>恢复码
                      （形如 <code className="font-mono text-amber-200">XXXXX-XXXXX-XXXXX-XXXXX</code>）。
                    </p>
                    <p>
                      连字符与大小写都可以省略，照抄原件即可。
                      {remainingCodes > 0 && (
                        <> 本机还有 <strong className="text-white">{remainingCodes}</strong> 枚可用。</>
                      )}
                    </p>
                    <p className="text-amber-200">
                      核验通过后才会让你设置新的访问密钥。
                    </p>
                  </div>
                </div>

                <KeyInput
                  value={recoveryCode}
                  onChange={setRecoveryCode}
                  error={error}
                  disabled={busy}
                  autoFocus
                  placeholder="恢复码（XXXXX-XXXXX-XXXXX-XXXXX）"
                  mono
                />
              </>
            )}

            {/*
              恢复流程第二步：恢复码已核验通过，只显示只读摘要；
              两个输入框都是新密钥，因此校验与提示只针对新密钥。
            */}
            {isRecoverNewKey && (
              <>
                <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                  <p className="text-xs text-emerald-200 leading-relaxed">
                    恢复码已核验通过，请设置新的访问密钥。
                  </p>
                </div>

                <KeyInput
                  value={key}
                  onChange={setKey}
                  error={error}
                  disabled={busy}
                  autoFocus
                  placeholder="新的访问密钥"
                />

                <KeyInput
                  value={confirmKey}
                  onChange={setConfirmKey}
                  disabled={busy}
                  placeholder="再次输入以确认"
                />
              </>
            )}

            {/* 常规的解锁 / 首次设置 */}
            {(mode === 'unlock' || isSetup) && (
              <>
                <KeyInput
                  value={key}
                  onChange={setKey}
                  error={error}
                  disabled={busy || blocked}
                  autoFocus
                  placeholder={isSetup ? '设置访问密钥' : '输入访问密钥'}
                />

                {isSetup && (
                  <KeyInput
                    value={confirmKey}
                    onChange={setConfirmKey}
                    disabled={busy || blocked}
                    placeholder="再次输入以确认"
                  />
                )}
              </>
            )}

            {mode === 'unlock' && (
              <button
                type="button"
                onClick={() => setRememberMe((v) => !v)}
                className="flex items-center gap-2.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                    rememberMe ? 'bg-indigo-500 border-indigo-500' : 'border-gray-600 bg-transparent'
                  }`}
                >
                  {rememberMe && <ShieldCheck className="w-3 h-3 text-white" />}
                </span>
                记住我（下次自动解锁，凭据与本机硬件绑定）
              </button>
            )}

            {/*
              主动锁定说明。
              用户可能刚点过「锁定」，也可能按了 Ctrl+R 重载界面 —— 两种情况下
              「记住我」都会被刻意跳过。不解释的话会被当成功能坏了。
            */}
            {mode === 'unlock' && lockedByUser && (
              <p className="text-[11px] text-gray-500 leading-relaxed">
                你已主动锁定本应用，本次运行期间需要输入访问密钥。
                「记住我」仍然有效，下次重新启动应用会自动解锁。
              </p>
            )}

            <motion.button
              type="submit"
              disabled={busy || blocked}
              variants={buttonVariants}
              initial="rest"
              whileHover="hover"
              whileTap="tap"
              className="w-full relative overflow-hidden rounded-xl bg-linear-to-r from-indigo-600 to-violet-600 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition-all disabled:cursor-not-allowed disabled:opacity-50"
            >
              <AnimatePresence>
                {busy && (
                  <motion.div
                    key="loading-bar"
                    initial={{ x: '-100%' }}
                    animate={{ x: '100%' }}
                    exit={{ x: '100%', opacity: 0 }}
                    transition={{
                      x: { duration: 1.2, repeat: Infinity, ease: 'linear' },
                      opacity: { duration: 0.2 },
                    }}
                    className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent"
                  />
                )}
              </AnimatePresence>

              <span className="relative flex items-center justify-center gap-2">
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>处理中…</span>
                  </>
                ) : (
                  <>
                    <KeyRound className="h-4 w-4" />
                    <span>
                      {isRecover
                        ? '核验恢复码'
                        : isRecoverNewKey
                          ? '设置新密钥'
                          : isSetup
                            ? '创建访问密钥'
                            : '解锁'}
                    </span>
                  </>
                )}
              </span>
            </motion.button>

            {/* 入口与返回 */}
            {mode === 'unlock' && canRecover && (
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setMode('recover');
                }}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                <LifeBuoy className="w-3.5 h-3.5" />
                忘记访问密钥？用恢复码重置
              </button>
            )}

            {mode === 'unlock' && !canRecover && (
              <p className="text-center text-[11px] text-gray-600 leading-relaxed">
                本机尚未生成恢复码。忘记密钥将需要删除授权文件（auth.json）重新初始化，
                <br />
                那会一并清除设备白名单与登录记录。
              </p>
            )}

            {(isRecover || isRecoverNewKey) && (
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setRecoveryCode('');
                  setRecoveryToken('');
                  setKey('');
                  setConfirmKey('');
                  setMode('unlock');
                }}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                返回解锁
              </button>
            )}

            {isRecoverNewKey && (
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setRecoveryToken('');
                  setKey('');
                  setConfirmKey('');
                  setMode('recover');
                }}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                重新输入恢复码
              </button>
            )}

            {mode === 'unlock' && remaining !== undefined && remaining < 5 && !blocked && (
              <p className="text-center text-xs text-gray-500">本机还可尝试 {remaining} 次</p>
            )}
          </motion.form>
        )}

        {/* 底部 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.4 }}
          className="mt-8 text-center"
        >
          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
            <span className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse" />
            <span>本地授权 · 硬件绑定</span>
            <span className="w-1 h-1 bg-gray-600 rounded-full" />
            <span>v{getHostVersion()}</span>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
};

export default AuthScreen;
