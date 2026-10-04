// src-tauri/src/modules/auth/state.rs
//
// 授权模块的运行时状态。
//
// 全部使用 `std::sync::Mutex`：临界区只有内存操作、绝不跨 await，
// 因此不需要异步锁，也不会因为 await 造成持锁。命令层刻意「先取数据、
// 释放锁、再 await」，这样 MutexGuard（!Send）永远不会跨越 await 点。
//
// 与 hive_atelier 的差异：取消了独立的 `is_authenticated: Mutex<bool>` 标志，
// 「是否已认证」完全由会话表推导。原实现里标志位与会话表可能不一致
// （例如换 webview 后标志为 true 但会话已丢失），这里从结构上排除了这种状态。

use super::config::SESSION_TTL_SECS;
use super::ratelimit::RateLimiter;
use super::security::AttemptTracker;
use super::types::SessionInfo;
use super::{config, config::AuthConfig, crypto};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// 已核验恢复码后签发的一次性凭据
///
/// 为什么需要它：恢复流程分成两步（先核验恢复码，再设置新密钥），
/// 这一步之间必须有个东西来证明"恢复码确实已经验证通过了"。
///
/// 直接把恢复码原文交给前端保存是不行的 —— 那等于让凭据在内存里多留一份，
/// 而后端本来只保存 Argon2id 哈希。
///
/// 因此这里用一个随机的短时效令牌：
///   * 单次使用 —— 用掉即删除，无法重放；
///   * 10 分钟过期 —— 足够完成"输入新密钥"这一步，又不至于长期有效；
///   * 只记下"命中了第几枚恢复码"，不存恢复码本身。
///
/// 这不构成额外的攻击面：拿到令牌需要先通过恢复码核验，
/// 而恢复码核验成功后本来就能直接重置密钥。
struct RecoveryGrant {
    /// 命中的恢复码在 `AuthConfig::recovery_hash` 中的下标。
    ///
    /// 多枚恢复码各自独立，第二步需要知道用掉的是哪一枚才能正确记账。
    ///
    /// 只作废命中的那一枚，其余保留（见 `config.rs` 的 `consume_recovery_code` 与
    /// `docs/06-项目/已知问题与技术债.md` 第 4.7 节）。这里此前写着"当前实现会整套
    /// 换发"——那是更早的设计，早已被推翻，为避免读者据此推出错误结论一并改正。
    matched_index: usize,
    /// 过期时间（Unix 秒）
    expires_at: i64,
}

/// 恢复码核验通过后签发的一次性令牌有效期（秒）
const RECOVERY_GRANT_TTL_SECS: i64 = 600;

/// 授权模块的全局状态（由 Tauri 托管）
pub struct AuthState {
    /// 持久化的授权配置
    pub config: Mutex<AuthConfig>,
    /// 活跃会话（内存态，进程退出即失效）
    pub sessions: Mutex<HashMap<String, SessionInfo>>,
    /// 失败尝试与封锁
    pub attempts: AttemptTracker,
    /// 请求频率限制（10 次 / 60 秒）
    pub limiter: RateLimiter,
    /// 恢复码核验通过后的待用令牌（令牌 -> 凭据）
    recovery_grants: Mutex<HashMap<String, RecoveryGrant>>,
    /// 本进程内是否已被用户主动锁定
    ///
    /// 存在的理由是修一个真实的安全漏洞：用户点「锁定」后，只要按 Ctrl+R
    /// 重载 WebView，`sessionStorage` 被清空、启动流程重新跑一遍，而
    /// 「记住我」凭据仍然有效 —— 于是自动登录把用户直接放了进去。
    /// 锁定形同虚设，任何能碰到键盘的人按一下 F5 就能进入。
    ///
    /// 关键区分：**「应用冷启动」与「运行中主动锁定」是两件事**，
    /// 它们对「是否允许自动登录」的答案相反：
    ///   * 冷启动 —— 自动登录正是「记住我」的目的，应当允许；
    ///   * 主动锁定 —— 用户明确表达了「我要离开一下」，必须要求输入密钥。
    ///
    /// 因此不能用「作废凭据」来实现（那样冷启动的自动登录也没了，
    /// 「记住我」就退化成「只在同一次运行内有效」）。正确做法是记一个
    /// **跨越页面重载、但不跨越进程重启** 的标记，而这个位置恰好就是
    /// 它 —— Rust 进程活着，WebView 刷新影响不到它；关掉应用再开则是新进程。
    locked: Mutex<bool>,
}

impl AuthState {
    pub fn new(config: AuthConfig) -> Self {
        Self {
            config: Mutex::new(config),
            sessions: Mutex::new(HashMap::new()),
            attempts: AttemptTracker::new(),
            limiter: RateLimiter::new(10, 60),
            recovery_grants: Mutex::new(HashMap::new()),
            locked: Mutex::new(false),
        }
    }

    // ---------- 主动锁定 ----------

    /// 标记为「已被用户主动锁定」，并结束全部会话
    pub fn lock(&self) {
        *self.locked.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.drop_all_sessions();
    }

    /// 本进程是否处于「用户主动锁定」状态
    pub fn is_locked(&self) -> bool {
        *self.locked.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 解除锁定标记（任何一次成功解锁都要调用）
    pub fn clear_lock(&self) {
        *self.locked.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    // ---------- 时间 ----------

    /// 当前 Unix 秒
    pub fn now_secs() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// 当前时间（ISO 8601 / RFC 3339）
    pub fn now_iso() -> String {
        chrono::Utc::now().to_rfc3339()
    }

    // ---------- 会话 ----------

    /// 新建会话并返回令牌
    pub fn create_session(&self, device_id: &str) -> String {
        let token = crypto::generate_token();
        let now = Self::now_secs();

        let session = SessionInfo {
            token: token.clone(),
            device_id: device_id.to_string(),
            created_at: now,
            last_seen: now,
        };

        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token.clone(), session);

        token
    }

    /// 校验令牌；有效则顺带刷新 `last_seen` 并清理过期会话
    pub fn validate_session(&self, token: &str) -> bool {
        let now = Self::now_secs();
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());

        sessions.retain(|_, s| s.is_valid(SESSION_TTL_SECS, now));

        match sessions.get_mut(token) {
            Some(session) => {
                session.last_seen = now;
                true
            }
            None => false,
        }
    }

    /// 结束单个会话
    pub fn drop_session(&self, token: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
    }

    /// 结束全部会话
    pub fn drop_all_sessions(&self) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// 结束除 `keep` 之外的全部会话，返回被结束的数量。
    ///
    /// 用于「修改访问密钥」：密钥一换，其他会话就不该继续有效 —— 但那**不包括**
    /// 发起这次操作的那个会话，否则用户刚改完密钥就被自己登出。
    ///
    /// （`reset_access_key_with_recovery_code` 走的是另一条路：它先
    /// `drop_all_sessions()` 再重新签发一个令牌返回给前端，因为那条路径上用户手上
    /// 本来就没有有效会话。两条路径的差别是「有没有会话需要保住」，不是松紧不同。）
    pub fn drop_other_sessions(&self, keep: &str) -> usize {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let before = sessions.len();
        sessions.retain(|token, _| token == keep);
        before - sessions.len()
    }

    /// 结束某台设备的所有会话，返回被结束的数量。
    ///
    /// 「移除已知设备」依赖它才真正生效（hive_atelier 只删了列表项，
    /// 会话依然有效，等于没有撤销任何东西）。
    pub fn drop_sessions_for_device(&self, device_id: &str) -> usize {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let before = sessions.len();
        sessions.retain(|_, session| session.device_id != device_id);
        before - sessions.len()
    }

    /// 当前有效会话中剩余时间最长的一个（小时）
    pub fn session_remaining_hours(&self) -> f64 {
        let now = Self::now_secs();
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());

        sessions
            .values()
            .map(|s| s.remaining_hours(SESSION_TTL_SECS, now))
            .fold(0.0_f64, f64::max)
    }

    /// 读取一份配置快照（短临界区，便于后续跨 await 使用）
    pub fn config_snapshot(&self) -> AuthConfig {
        self.config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    // ---------- 恢复码核验凭据 ----------

    /// 签发一个核验通过的一次性令牌
    pub fn issue_recovery_grant(&self, matched_index: usize) -> String {
        let token = crypto::generate_token();
        let now = Self::now_secs();

        let mut grants = self
            .recovery_grants
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        // 顺手清理过期条目，避免长期运行后无限增长
        grants.retain(|_, g| g.expires_at > now);

        grants.insert(
            token.clone(),
            RecoveryGrant {
                matched_index,
                expires_at: now + RECOVERY_GRANT_TTL_SECS,
            },
        );

        token
    }

    /// 消费一个令牌，返回它命中的恢复码下标；无效或过期返回 `None`。
    ///
    /// 无论成功与否都会移除该令牌 —— 单次使用，不可重放。
    pub fn consume_recovery_grant(&self, token: &str) -> Option<usize> {
        let now = Self::now_secs();
        let mut grants = self
            .recovery_grants
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let grant = grants.remove(token)?;
        if grant.expires_at <= now {
            return None;
        }
        Some(grant.matched_index)
    }

    /// 作废全部待用令牌（重置密钥后调用）
    pub fn drop_all_recovery_grants(&self) {
        self.recovery_grants
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

// ============================================================
// Tauri 托管的状态单元
// ============================================================

/// 授权状态的**托管单元**：进程内唯一，第一次被取用时才真正建立。
///
/// ============================================================
/// 为什么不直接 `app.manage(AuthState)`
/// ============================================================
///
/// 发行版冷启动时，界面会在后端 **setup 钩子跑完之前**就开始执行 JS ——
/// 主窗口由 Tauri 在创建阶段就建好并开始加载前端资源，而模块的 `app.manage(...)`
/// 在 setup 里。于是 `get_auth_status`（启动流程里**唯一一个没有把错误吞掉**的
/// 早期命令）撞上了一个尚未托管的状态：
///
///   state not managed for field `state` on command `get_auth_status`.
///   You must call `.manage()` before using this command
///
/// 它在**启动第二步**抛错，而那一项是关键步骤 —— 于是整个初始化失败，用户只
/// 剩下「重试初始化」一条路；重试时 setup 早已完成，所以一点就过。开发模式看不到，
/// 因为 `devUrl` 那一跳（连 Vite、编译、加载模块图）比 setup 慢了一个数量级，
/// 恰好把竞态盖住 —— 这是一个只在发行版出现、且每次冷启动必现的缺陷。
///
/// 因此这里把「初始化」从**生命周期的一个时刻**改成**取用时的一个保证**：
/// `OnceLock` 保证进程内只有一份；第一次取用（无论是谁、什么时候）就地建立它。
/// 用户拿到的不再是"你调用得太早"，而是正确的授权状态。
///
/// 代价与取舍：
///
/// * 不改变任何安全语义 —— 配置来源、解析与降级仍走 `config::load`，解析失败
///   依旧回落到"需要授权 + 未初始化"（见 `load_from_with_reason`）；
/// * 只在**第一次取用**时读盘一次。setup 与首次取用共享同一份单元：
///   谁先到谁建立，后到的那个直接用现成的；
/// * 它是这一类缺陷的**局部**修法：每一个"状态只在 setup 里注入"的模块都有同一堵墙
///   （托盘菜单那个窗口在 mount 时就会调 `tray_menu_state`）。
///   全局修法是前端的启动闸门 —— `src/services/backendReady.ts`，
///   判据来自 `core::registry::ReadyState`。这里这一层保留，理由见该文件的说明：
///   闸门负责"不该早调"，这里负责"早调了也不出错"。
pub struct AuthSession(OnceLock<AuthState>);

impl AuthSession {
    /// 建立一个尚未初始化的托管单元。
    ///
    /// 只是分配一个空 `OnceLock`（一次内存写入），真正的读盘推迟到第一次取用 ——
    /// 这正是"启动路径上不做多余工作"与"调用时一定拿得到"两者的交点。
    pub fn new() -> Self {
        Self(OnceLock::new())
    }

    /// 取用授权状态；尚未初始化时就地建立。
    ///
    /// 初始化用 `std::sync::OnceLock::get_or_init`：并发调用时只会有一份存活，
    /// 落败的那个初始化结果会被丢弃。因此这里故意**不做**任何有副作用的动作
    /// （迁移回写由 `config::load` 自己保证幂等），重复初始化是安全的。
    pub fn ready(&self, app: &AppHandle) -> &AuthState {
        self.0.get_or_init(|| {
            log::info!("授权状态首次取用：现场读取 auth.json（早期调用不再失败）");
            AuthState::new(config::load(app))
        })
    }

    /// 与 [`AuthSession::ready`] 同一件事，但借出的生命周期**只到本次调用**。
    ///
    /// 参数里的 `&AppHandle` 而不是 `&'a AppHandle` 是有意的：命令层从
    /// `State<'_, AuthSession>` 里拿不到调用者 `AppHandle` 的生命周期保证
    /// （Tauri 的 `State` 借用的生命周期与 `&self` 无关），因此返回一个绑在
    /// `app` 上的引用，让调用处按需重借，而不是逼调用方去满足一个它无法证明的约束。
    ///
    /// 用它是为了**绕开** `Deref`：需要 trait 分派（例如 `serde::Serialize`）
    /// 时，传 `&AuthState` 会拿到 `&AuthSession` 或 `&&AuthState` ——
    /// 两者的报错都长得不像原因。多写四个字符换一个看得懂的编译错误。
    pub fn ready_service(&self, app: &AppHandle) -> &AuthState {
        self.ready(app)
    }
}

impl Default for AuthSession {
    fn default() -> Self {
        Self::new()
    }
}

/// 把托管单元里的状态借出来。
///
/// 单独一个函数（而不是在每个命令里写 `auth_state.ready(&app)`）的理由是统一：
/// 命令体里满是 `&app`、`&state`，一处漏掉就又是一次"只在发行版出现"的启动失败，
/// 因此让所有命令走同一个入口。
///
/// 注意它**不是**为了绕开借用检查：返回值的生命周期来自 `AuthSession`，
/// 因此托管单元的借用会一直活到本次命令结束。
pub fn state_of<'a>(app: &AppHandle, session: &'a AuthSession) -> &'a AuthState {
    session.ready(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> AuthState {
        AuthState::new(AuthConfig::default())
    }

    #[test]
    fn sessions_start_empty() {
        let state = state();
        assert!(!state.validate_session("nope"));
        assert_eq!(state.session_remaining_hours(), 0.0);
    }

    #[test]
    fn created_session_validates_and_reports_ttl() {
        let state = state();
        let token = state.create_session("dev-1");

        assert_eq!(token.len(), 64);
        assert!(state.validate_session(&token));

        let hours = state.session_remaining_hours();
        assert!(hours > 23.9 && hours <= 24.0, "unexpected ttl: {hours}");
    }

    #[test]
    fn dropping_removes_the_session() {
        let state = state();
        let token = state.create_session("dev-1");
        state.drop_session(&token);
        assert!(!state.validate_session(&token));
    }

    #[test]
    fn drop_all_sessions_logs_everyone_out() {
        let state = state();
        let a = state.create_session("dev-1");
        let b = state.create_session("dev-2");

        state.drop_all_sessions();

        assert!(!state.validate_session(&a));
        assert!(!state.validate_session(&b));
        assert_eq!(state.session_remaining_hours(), 0.0);
    }

    /// **改密钥时只保留发起操作的那个会话。**
    ///
    /// 这条测试锁的是 `change_access_key` 的安全性质：密钥一换，其他会话必须失效；
    /// 但发起操作的那个会话要保住，否则用户刚改完密钥就被自己登出。
    #[test]
    fn drop_other_sessions_keeps_only_the_given_one() {
        let state = state();
        let keep = state.create_session("dev-1");
        let other_same_device = state.create_session("dev-1");
        let other_device = state.create_session("dev-2");

        assert_eq!(state.drop_other_sessions(&keep), 2);

        assert!(state.validate_session(&keep));
        assert!(!state.validate_session(&other_same_device));
        assert!(!state.validate_session(&other_device));
        // 幂等：再调一次没有可撤销的会话
        assert_eq!(state.drop_other_sessions(&keep), 0);
    }

    #[test]
    fn dropping_by_device_only_affects_that_device() {
        let state = state();
        let a1 = state.create_session("dev-1");
        let a2 = state.create_session("dev-1");
        let b = state.create_session("dev-2");

        assert_eq!(state.drop_sessions_for_device("dev-1"), 2);

        assert!(!state.validate_session(&a1));
        assert!(!state.validate_session(&a2));
        assert!(state.validate_session(&b));
        assert_eq!(state.drop_sessions_for_device("nobody"), 0);
    }

    #[test]
    fn expired_sessions_are_rejected_and_pruned() {
        let state = state();
        let token = state.create_session("dev-1");

        {
            let mut sessions = state.sessions.lock().unwrap();
            let session = sessions.get_mut(&token).unwrap();
            // 手工把它推到 TTL 之前
            session.created_at -= SESSION_TTL_SECS + 1;
        }

        assert!(!state.validate_session(&token));
        assert!(
            state.sessions.lock().unwrap().is_empty(),
            "过期会话应当被清理掉"
        );
    }

    #[test]
    fn config_snapshot_is_a_copy() {
        let state = state();
        {
            let mut config = state.config.lock().unwrap();
            config.auto_login = true;
        }
        let snapshot = state.config_snapshot();
        assert!(snapshot.auto_login);

        // 修改快照不应影响真实状态
        let mut snapshot = snapshot;
        snapshot.auto_login = false;
        assert!(state.config_snapshot().auto_login);
    }

    #[test]
    fn timestamps_are_usable() {
        assert!(AuthState::now_secs() > 1_700_000_000);
        let iso = AuthState::now_iso();
        assert!(
            iso.contains('T') && iso.len() >= 20,
            "unexpected iso: {iso}"
        );
    }

    // ---------- 恢复码核验凭据 ----------

    #[test]
    fn recovery_grant_is_single_use() {
        let state = state();

        let token = state.issue_recovery_grant(3);
        assert_eq!(token.len(), 64);

        // 第一次消费成功，返回的是命中的恢复码下标
        assert_eq!(state.consume_recovery_grant(&token), Some(3));

        // 第二次立即失效 —— 单次使用，不可重放
        assert!(
            state.consume_recovery_grant(&token).is_none(),
            "同一个凭据只能使用一次"
        );
    }

    #[test]
    fn recovery_grant_rejects_unknown_token() {
        let state = state();
        assert!(state.consume_recovery_grant("nonexistent").is_none());
        assert!(state.consume_recovery_grant("").is_none());
    }

    #[test]
    fn recovery_grant_expires() {
        let state = state();
        let token = state.issue_recovery_grant(0);

        // 手工把它推到过期之前
        {
            let mut grants = state.recovery_grants.lock().unwrap();
            let grant = grants.get_mut(&token).expect("刚签发");
            grant.expires_at -= RECOVERY_GRANT_TTL_SECS + 1;
        }

        assert!(
            state.consume_recovery_grant(&token).is_none(),
            "过期凭据必须被拒绝"
        );
    }

    /// 签发新凭据时应顺手清理已过期的条目，避免长期运行后无限增长
    #[test]
    fn issuing_prunes_expired_grants() {
        let state = state();

        let stale = state.issue_recovery_grant(0);
        {
            let mut grants = state.recovery_grants.lock().unwrap();
            grants.get_mut(&stale).unwrap().expires_at -= RECOVERY_GRANT_TTL_SECS + 1;
        }
        assert_eq!(state.recovery_grants.lock().unwrap().len(), 1);

        let fresh = state.issue_recovery_grant(1);
        let grants = state.recovery_grants.lock().unwrap();
        assert_eq!(grants.len(), 1, "过期的应被清理");
        assert!(grants.contains_key(&fresh));
    }

    #[test]
    fn drop_all_recovery_grants_clears_everything() {
        let state = state();
        let a = state.issue_recovery_grant(0);
        let b = state.issue_recovery_grant(1);

        state.drop_all_recovery_grants();

        assert!(state.consume_recovery_grant(&a).is_none());
        assert!(state.consume_recovery_grant(&b).is_none());
    }

    // ---------- 主动锁定 ----------

    /// 核心回归：锁定必须结束**全部**会话，而不只是调用方那一个。
    ///
    /// 这条测试锁定的是"点锁定 → 按 F5 就能进去"那个安全漏洞的一半修复。
    #[test]
    fn lock_drops_every_session() {
        let state = state();
        let a = state.create_session("dev-1");
        let b = state.create_session("dev-2");

        state.lock();

        assert!(state.is_locked(), "锁定后标记必须置位");
        assert!(!state.validate_session(&a), "锁定后所有会话都应失效");
        assert!(!state.validate_session(&b));
        assert_eq!(state.session_remaining_hours(), 0.0);
    }

    /// 解锁（用户亲手输入密钥 / 用恢复码）后必须解除标记，
    /// 否则「记住我」会永久失效。
    #[test]
    fn clear_lock_restores_auto_login_eligibility() {
        let state = state();

        state.lock();
        assert!(state.is_locked());

        state.clear_lock();
        assert!(!state.is_locked(), "解锁后必须解除锁定标记");
    }

    /// 新进程（新建 AuthState）默认是未锁定 —— 冷启动应当允许自动登录。
    ///
    /// 这是与"页面重载"的关键区别：重载复用同一个进程（标记保留），
    /// 重启才是新进程（标记重置）。
    #[test]
    fn a_fresh_process_starts_unlocked() {
        let state = state();
        assert!(
            !state.is_locked(),
            "新建状态必须是未锁定：冷启动应允许「记住我」自动登录"
        );
    }

    #[test]
    fn repeated_lock_is_idempotent() {
        let state = state();
        let token = state.create_session("dev-1");

        state.lock();
        state.lock();

        assert!(state.is_locked());
        assert!(!state.validate_session(&token));
    }
}
