// src-tauri/src/modules/plugins/db.rs
//
// `ctx.db`：**每个插件一个 SQLite 文件**，由宿主侧 `rusqlite` 执行。
//
// ============================================================
// 为什么是 SQLite，而不是"再加一层键值"
// ============================================================
//
// 已经有两层了：`ctx.storage`（一个小键值表，单值 1 MB）与 `ctx.dataDir`
// （一个有界的文件目录，单文件 256 MB）。它们装得下笔记正文与图片，但装不下
// **查询**：一个笔记插件要"按标签筛、按更新时间排、取第 3 页"时，前两层能做的
// 只有把所有数据拉进 JS 里自己过滤 —— 而那是插件作者最容易写出
// "一千条以后就开始卡"的地方。
//
// SQLite 把这件事交回给它本来就该在的地方。它还有一个别的好处：**一个插件
// 一个文件**，因此"这个插件的数据有多少"是 `fs::metadata` 一次调用的事。
//
// ============================================================
// 边界在**引擎**里，不在 SQL 文本上
// ============================================================
//
// 数据库文件放在插件自己的数据目录里，而 `ATTACH DATABASE '/任意/路径'` 能让它
// 在**同一个连接**里打开第二个文件 —— 那一步跨出了这个目录，也就绕过了整个
// `data_dir::resolve` 的 chroot 语义。
//
// 挡它的办法**不能**是"在 SQL 里找 `ATTACH`"：注释（`AT/**/TACH`）、大小写、
// 字符串字面量、以及将来某个 SQLite 版本新增的同义写法，都能绕过文本过滤 ——
// 而这类判据的失效方式是"看起来正常但读到了别的文件"。
//
// 因此这里用的是 `sqlite3_set_authorizer`（rusqlite 的 `hooks` 特性）：
// **SQLite 自己在编译每一条语句时回调我们**，我们按动作类型拒绝。这是引擎级的，
// SQL 怎么写都绕不开。
//
// 同一条通道还挡掉三类东西：
//
//   * `DETACH` —— 与 `ATTACH` 对称；
//   * 几个**会让资源上限失效**的 PRAGMA（`max_page_count` 自己、
//     `page_size`、`journal_mode`、`locking_mode`）—— 插件把自己那一档上限
//     改大，等于把宿主给的配额变成一句建议；
//   * `writable_schema` —— 它允许直接改 `sqlite_master`，也就是把表结构改成
//     引擎自己都不认识的样子（后续每一条查询都会报"malformed"，而那个库里
//     的数据再也取不出来）。这不是安全边界，是**数据完整性的护栏**，而它恰好
//     也只有引擎挡得住；
//   * `load_extension` —— 加载任意动态库，它是"插件里再开一个没有边界的洞"。
//
// ============================================================
// 资源上限也是引擎级的
// ============================================================
//
// `PRAGMA max_page_count = N` 是 SQLite 自己执行的：写满之后它会以
// `SQLITE_FULL` 失败，而不是先写满磁盘再让宿主去发现。这比"写完再统计"可靠得多。
//
// 上限取**数据目录配额的一半**（见 `DB_BUDGET_SHARE`）。理由：数据库与文件目录
// 是同一个配额池里的两样东西，而 `data_dir::write` 那条路仍然按"整目录占用"判。
// 如果数据库自己能吃掉全部配额，那么一个插件只要多写几行记录，它的文件写入就会
// 全部失败 —— 而失败的形状是"文件写不进去"，离原因（另一个东西把配额用光了）很远。
//
// ============================================================
// 一次调用只编译一条语句
// ============================================================
//
// `Connection::prepare` 在 SQL 里有多条语句时会返回 `MultipleStatement` 错误。
// 这不是性能考量，是**语义**考量：一个"最后一条失败、前几条已经生效"的调用没法
// 被插件正确地处理（它不知道该回滚到哪），而 `ctx.db` 没有跨调用的回滚手段
// （见 `transaction` 的说明）。多条语句要一起成功或一起失败，就用 `transaction`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::PluginState;

/// 数据库文件名。放在插件数据目录的**根**下。
///
/// 不以 `.` 开头是有意的：数据目录的列表接口会把点开头的文件当成隐藏项，
/// 而"我的数据在哪"是插件作者与用户都会问的问题 —— 一个藏起来的 `plugin.db`
/// 只会让"这个插件的数据库到底是哪个文件"变成一次猜测。
pub const DB_FILE_NAME: &str = "plugin.db";

/// 数据库能占的配额比例。
///
/// 见文件头"资源上限也是引擎级的"那一节：数据库与文件目录共用同一个配额池，
/// 而数据库独占全部配额会让文件写入以一种离原因很远的方式失败。
const DB_BUDGET_SHARE: u64 = 2;

/// 一次 RPC 里 SQL 文本的长度上限。
///
/// 64 KiB：足够放下一条很宽的 `CREATE TABLE` 或一个几百个 `?` 的插入，
/// 又明显挡得住"把整个文件当 SQL 发过来"那种情况。
const MAX_SQL_BYTES: usize = 64 * 1024;

/// 一条语句的参数个数上限。
const MAX_PARAMS: usize = 256;

/// 一次 `transaction` 里最多多少条语句。
///
/// 上限的理由是**失败时的代价**：这一批要么全成功要么全回滚，而一个几千条的批次
/// 会在磁盘上留一个很大的回滚日志。分批提交是插件自己的决定。
const MAX_TRANSACTION_STATEMENTS: usize = 512;

/// 每插件一个连接。**Tauri 托管**。
///
/// 用 `std::sync::Mutex` 而不是 tokio 的：真正的等待发生在
/// `spawn_blocking` 里的那个临界区，而它是同步代码 —— tokio 的锁在那里只能用
/// `blocking_lock()`，那反而更容易写出死锁。见 `run_blocking`。
#[derive(Default)]
pub struct PluginDatabases {
    open: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl PluginDatabases {
    pub fn new() -> Self {
        Self::default()
    }

    /// 关掉一个插件的连接（禁用 / 卸载 / 重载时）。
    ///
    /// **不动那个文件。** §6 的生命周期表写的是"卸载 → 删代码、**保留数据**"，
    /// 而数据库是数据的一部分 —— 关连接只是不让它继续占着一个文件句柄
    /// （Windows 上那个句柄会让备份与"数据目录被占用"的排查变得麻烦）。
    pub fn close(&self, plugin_id: &str) {
        self.open
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(plugin_id);
    }

    /// 关掉全部连接（应用退出时）。
    pub fn close_all(&self) {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// 当前打开了几个连接（诊断用）。
    pub fn open_count(&self) -> usize {
        self.open.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// 取（必要时建立）某个插件的连接。
    async fn connection<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
    ) -> Result<Arc<Mutex<Connection>>, String> {
        if let Some(existing) = self
            .open
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(plugin_id)
            .cloned()
        {
            return Ok(existing);
        }

        // 路径要经 `PluginManager` 取 —— 它自己会强制 `plugin-data` 权限与
        // "数据根可用"这两件事，因此这里不必再判一遍（判两遍一定会漂）。
        let path = {
            let Some(state) = app.try_state::<PluginState>() else {
                return Err("插件系统尚未就绪".to_string());
            };
            let manager = state.0.read().await;
            manager.database_path(plugin_id).map_err(|e| e.to_string())?
        };

        // 建库是**阻塞**的（要碰磁盘、要初始化文件头），因此不能在异步线程上做。
        let opened = tokio::task::spawn_blocking(move || open_at(&path, budget_bytes()))
            .await
            .map_err(|e| format!("打开插件数据库的任务没能完成：{e}"))??;

        let entry = Arc::new(Mutex::new(opened));
        // 两个并发调用同时建库时，**只有一个的连接留下来**，另一个被丢掉。
        // 用 `entry().or_insert_with()` 而不是"先查再插"：后者会让两个连接同时
        // 写同一个文件，而 SQLite 的写锁会让其中一条路径随机地报 `SQLITE_BUSY`。
        let stored = self
            .open
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(plugin_id.to_string())
            .or_insert_with(|| Arc::clone(&entry))
            .clone();

        Ok(stored)
    }

    /// 在连接上跑一段同步代码。
    ///
    /// ============================================================
    /// 为什么必须是 `spawn_blocking`
    /// ============================================================
    ///
    /// SQLite 的调用是**同步且可能很慢**的（一次全表扫描在大库上要几百毫秒）。
    /// 直接在异步线程上跑会把 tokio 的调度线程钉住 —— 那是整个宿主共用的，
    /// 于是"某个插件做了一次慢查询"会表现为**所有插件一起变卡**。
    ///
    /// 锁也在阻塞线程里拿：先在异步线程上拿锁会让 `await` 落在临界区里，
    /// 而那个临界区里跑的是同步的 SQLite 调用。
    async fn run<T, F>(
        &self,
        app: &AppHandle<impl Runtime>,
        plugin_id: &str,
        work: F,
    ) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    {
        let connection = self.connection(app, plugin_id).await?;

        tokio::task::spawn_blocking(move || {
            // `into_inner` 而不是 `unwrap`：一次 panic 不该让这个插件的数据库
            // **永久**不可用（poisoned 锁会让之后每一次调用都失败），而 SQLite
            // 连接在 panic 之后仍然是可用的（它自己的状态是完整的）。
            let mut guard = connection.lock().unwrap_or_else(|e| e.into_inner());
            work(&mut guard)
        })
        .await
        .map_err(|e| format!("执行插件数据库操作的任务没能完成：{e}"))?
    }

    /// `ctx.db.query`
    pub async fn query<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
        sql: &str,
        params: &[Value],
    ) -> Result<QueryResult, String> {
        validate(sql, params)?;
        let sql = sql.to_string();
        let params = params.to_vec();

        self.run(app, plugin_id, move |conn| run_query(conn, &sql, params.as_slice()))
            .await
    }

    /// `ctx.db.exec`
    pub async fn exec<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
        sql: &str,
        params: &[Value],
    ) -> Result<ExecResult, String> {
        validate(sql, params)?;
        let sql = sql.to_string();
        let params = params.to_vec();

        self.run(app, plugin_id, move |conn| run_exec(conn, &sql, params.as_slice()))
            .await
    }

    /// `ctx.db.transaction`
    ///
    /// ============================================================
    /// 为什么是"一批语句"而不是 `begin` / `commit` 三次调用
    /// ============================================================
    ///
    /// 跨调用的显式事务是**会泄漏的状态**：插件在 `begin` 之后崩溃、被卸载、
    /// 或者只是忘了 `commit`，那条写事务就一直挂在那里，而这个连接被下一个
    /// 打开它的实例继续用 —— 于是"我什么都没干，它却说数据库被锁住了"。
    ///
    /// 更要命的是没有 `finally`：RPC 是发出去、等结果，插件那一侧拿不到一个
    /// "无论发生什么都会执行"的钩子（它的界面可能只是被隐藏了，也可能整个文档
    /// 已经被销毁）。因此宿主**必须**让事务的边界落在这**一次**调用里。
    ///
    /// 一批语句满足这一点，也是绝大多数真实用法（导入一批记录、迁移一次表结构）。
    pub async fn transaction<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        plugin_id: &str,
        statements: Vec<Statement>,
    ) -> Result<Vec<ExecResult>, String> {
        if statements.is_empty() {
            return Err("transaction 至少需要一条语句".to_string());
        }
        if statements.len() > MAX_TRANSACTION_STATEMENTS {
            return Err(format!(
                "transaction 最多 {MAX_TRANSACTION_STATEMENTS} 条语句，收到 {}",
                statements.len()
            ));
        }
        for (index, statement) in statements.iter().enumerate() {
            validate(&statement.sql, &statement.params)?;
            statement.sql_params(index)?;
        }

        self.run(app, plugin_id, move |conn| run_transaction(conn, &statements))
            .await
    }
}

// ============================================================
// 实际执行（全部跑在阻塞线程上）
// ============================================================

/// 一次查询的结果。
///
/// **列名与行分开返回**，而不是"每行一个对象"。理由：SQL 允许重名列
/// （`SELECT a.id, b.id FROM …`），而一个对象在那种情况下只能保留一个 ——
/// 插件拿到的是一个**悄悄少了东西**的结果，那是最难查的一类错误。
/// 桥接层会把这两个数组拼成对象给绝大多数用法，拼不出来的少数情况仍然拿得到原始形状。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// 一次写入的结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// 受影响的**行数**。DDL 与建索引都是 0。
    pub changes: u64,
    /// 这个连接上最后一次插入的 rowid。没插入过时是 0。
    pub last_insert_row_id: i64,
}

/// 一批语句里的一条。
///
/// `params` 是 **JSON 值**而不是 `rusqlite::types::Value`：后者只在
/// `serde_json` 那个特性打开时才可反序列化，而更重要的是 —— 参数来自插件，
/// 一个形状不对的参数应该得到一句"这个参数表示不了"，而不是一个反序列化错误。
/// 转换集中在 `json_to_sql` 一处。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

impl Statement {
    /// 把 JSON 参数转成 SQLite 参数。失败时带上"第几条"的信息。
    fn sql_params(&self, index: usize) -> Result<Vec<SqlValue>, String> {
        if self.params.len() > MAX_PARAMS {
            return Err(format!(
                "第 {index} 条：参数太多（{} 个，上限 {MAX_PARAMS}）",
                self.params.len()
            ));
        }
        self.params
            .iter()
            .map(|value| json_to_sql(value).map_err(|e| format!("第 {index} 条：{e}")))
            .collect()
    }
}

/// 把一组 JSON 参数转成 SQLite 参数。
fn sql_params(params: &[Value]) -> Result<Vec<SqlValue>, String> {
    params.iter().map(json_to_sql).collect()
}

/// SQL 与参数的基本形状检查。
///
/// 这些是**输入卫生**，不是安全边界 —— 边界在 authorizer 那一层（见文件头）。
/// 它们挡的是"插件把一个几百 MB 的字符串当 SQL 发过来"这类会先耗尽宿主内存的情况。
fn validate(sql: &str, params: &[Value]) -> Result<(), String> {
    if sql.trim().is_empty() {
        return Err("SQL 不能为空".to_string());
    }
    if sql.len() > MAX_SQL_BYTES {
        return Err(format!(
            "SQL 太长（{} 字节，上限 {MAX_SQL_BYTES}）",
            sql.len()
        ));
    }
    if params.len() > MAX_PARAMS {
        return Err(format!(
            "参数太多（{} 个，上限 {MAX_PARAMS}）",
            params.len()
        ));
    }
    Ok(())
}

/// 打开（或建立）一个数据库文件，并装上那几道引擎级的限制。
fn open_at(path: &Path, budget_bytes: u64) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("建不了插件数据目录 {}：{e}", parent.display()))?;
    }

    // **刻意不带 `SQLITE_OPEN_URI`。** 带上它之后 `file:` 那种写法会被当成
    // URI 解析，于是路径里的一段可以改变它指向哪里 —— 而这里的路径是宿主拼的，
    // 不该有任何"再解释一次"的余地。
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|e| format!("打不开插件数据库 {}：{e}", path.display()))?;

    // **先设限制，再装规则。** 反过来的话，`PRAGMA max_page_count = N` 这句
    // 宿主自己写的语句会被自己的规则拦下 —— 而症状是"数据库根本打不开"。
    apply_limits(&connection, budget_bytes)?;
    install_authorizer(&connection)?;

    Ok(connection)
}

/// 装上引擎级的拒绝规则。
///
/// 见文件头。这里的每一条都是"SQL 文本过滤挡不住、只有引擎挡得住"的东西。
fn install_authorizer(connection: &Connection) -> Result<(), String> {
    connection
        .authorizer(Some(|context: AuthContext<'_>| match context.action {
            // 跨出插件数据目录的唯一一条 SQL 路径。
            AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,

            // 让资源上限失效的那些。改大自己那一档等于把配额变成建议；
            // 改 `page_size` 会在**下一次 VACUUM** 时改变已用页数对字节数的换算。
            // **只拦"设"，不拦"读"。** 不带值的 `PRAGMA page_size` 是一次读取，
            // 插件用它算自己的用量是合理的；带上值才是要改引擎行为。
            // 一刀切地把读也拦掉的表现是"插件问一下页大小就被拒绝" ——
            // 而那看起来像数据库坏了。
            AuthAction::Pragma {
                pragma_name,
                pragma_value,
            } => {
                if pragma_value.is_some() && is_reserved_pragma(pragma_name) {
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }

            // **刻意没有"拒绝写 sqlite_master"这一条。**
            //
            // 它看起来很像该有的一条（直接把表结构改成引擎不认识的样子，
            // 库里的数据就再也取不出来了），而实测发现它**同时拒绝了所有 DDL**：
            // SQLite 自己的 `CREATE TABLE` 也是以一次针对 `sqlite_master` 的
            // `SQLITE_UPDATE` 上报的。按动作类型区分不了"引擎在建表"与"插件在
            // 改表结构"，于是那条规则把整个数据库变成只读的。
            //
            // 真正需要挡的那件事已经由 SQLite 自己挡了：没有 `writable_schema`
            // （上面那份保留名单里有它）时，`UPDATE sqlite_master` 会被引擎拒绝，
            // 报的是 "table sqlite_master may not be modified"。

            // 加载任意动态库 —— 它在插件里再开一个没有边界的洞。
            AuthAction::Function { function_name } => {
                if function_name.eq_ignore_ascii_case("load_extension") {
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }

            _ => Authorization::Allow,
        }));

    Ok(())
}

/// 哪些 PRAGMA 是**宿主保留**的。
///
/// 抽成一个函数是为了让"保留名单"只有一处 —— 它同时被 authorizer 与单元测试读到，
/// 而两处各写一份名单的话，加一条新保留项时总有一边会忘。
fn is_reserved_pragma(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        // 资源上限本身
        "max_page_count"
            // 用页数换算字节数的除数：改了它，"已用多少字节"就变了
            | "page_size"
            // 把数据写到内存或临时文件里，于是磁盘上那个文件不再反映真实占用
            | "journal_mode"
            // 独占锁：让宿主自己的诊断（备份、用量统计）拿不到这个库
            | "locking_mode"
            // 直接改表结构定义
            | "writable_schema"
            // 把库映射进内存，绕过 SQLite 自己的页缓存计量
            | "mmap_size"
    )
}

/// 把资源上限写进引擎。
fn apply_limits(connection: &Connection, budget_bytes: u64) -> Result<(), String> {
    let page_size: u64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(|e| format!("读不到数据库的页大小：{e}"))?;

    if page_size == 0 {
        return Err("数据库报出的页大小是 0".to_string());
    }

    // 向上取整：宁可多给一页，也不要因为"上限比一页还小"让数据库**一条都写不进去**
    // （那种状态下的错误消息是 `database or disk is full`，而磁盘明明有空间）。
    let max_pages = budget_bytes.div_ceil(page_size).max(1);

    connection
        .execute_batch(&format!("PRAGMA max_page_count = {max_pages};"))
        .map_err(|e| format!("设不上数据库的页数上限：{e}"))?;

    // 只读查询走 `query_row`，因此这里用 `execute_batch` 一次设完两件事。
    // `foreign_keys` 默认是**关**的（SQLite 的历史包袱），而一个插件声明了
    // 外键却发现自己删掉了父行时子行还在 —— 那看起来像"数据库不守规矩"。
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("开不上外键约束：{e}"))?;

    Ok(())
}

/// 数据库能占多少字节。
fn budget_bytes() -> u64 {
    super::data_dir::MAX_TOTAL_BYTES / DB_BUDGET_SHARE
}

fn run_query(conn: &Connection, sql: &str, params: &[Value]) -> Result<QueryResult, String> {
    // **在进引擎之前**把 JSON 参数转成 SQLite 参数。转换失败是一句能读懂的话
    // （"$blob 不是合法的 base64"），而直接让 rusqlite 去碰 JSON 值只会得到
    // 一句 trait 未实现的编译错误 —— 那是在写代码时就能发现的，不该留到运行期。
    let params = sql_params(params)?;

    // `prepare` 在 SQL 里有多条语句时会返回 `MultipleStatement` —— 那条错误
    // 正是我们要的语义（见文件头的说明），因此原样透出，不自己再判一遍。
    let mut statement = conn.prepare(sql).map_err(|e| sql_error("编译", sql, e))?;

    let columns: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    let column_count = columns.len();

    let mut rows = Vec::new();
    let mut cursor = statement
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(|e| sql_error("执行", sql, e))?;

    while let Some(row) = cursor.next().map_err(|e| sql_error("读取", sql, e))? {
        let mut values = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let raw = row
                .get_ref(index)
                .map_err(|e| sql_error("取值", sql, e))?;
            values.push(value_to_json(raw));
        }
        rows.push(values);
    }

    Ok(QueryResult { columns, rows })
}

fn run_exec(conn: &Connection, sql: &str, params: &[Value]) -> Result<ExecResult, String> {
    let params = sql_params(params)?;
    let mut statement = conn.prepare(sql).map_err(|e| sql_error("编译", sql, e))?;

    let changes = statement
        .execute(rusqlite::params_from_iter(params.iter()))
        .map_err(|e| sql_error("执行", sql, e))?;

    Ok(ExecResult {
        changes: changes as u64,
        last_insert_row_id: conn.last_insert_rowid(),
    })
}

/// 一批语句，全成功或全回滚。
fn run_transaction(conn: &mut Connection, statements: &[Statement]) -> Result<Vec<ExecResult>, String> {
    let transaction = conn
        .transaction()
        .map_err(|e| format!("开启事务失败：{e}"))?;

    let mut results = Vec::with_capacity(statements.len());

    for (index, statement) in statements.iter().enumerate() {
        let params = statement.sql_params(index)?;

        let mut prepared = transaction
            .prepare(&statement.sql)
            .map_err(|e| format!("第 {index} 条：{}", sql_error("编译", &statement.sql, e)))?;

        let changes = prepared
            .execute(rusqlite::params_from_iter(params.iter()))
            .map_err(|e| format!("第 {index} 条：{}", sql_error("执行", &statement.sql, e)))?;

        results.push(ExecResult {
            changes: changes as u64,
            last_insert_row_id: transaction.last_insert_rowid(),
        });
    }

    // 显式 `commit`：`Transaction` 的 `Drop` 会**回滚**，因此中途任何一条失败
    // 都会自动走到那个行为上 —— 那正是"全成功或全回滚"的意思。
    transaction
        .commit()
        .map_err(|e| format!("提交事务失败：{e}"))?;

    Ok(results)
}

/// SQLite 的值 → JSON。
///
/// ============================================================
/// BLOB 用 `{"$blob": "<base64>"}`，不用裸字符串
/// ============================================================
///
/// 裸 base64 字符串与一段**恰好是合法 base64 的文本**分不开，而"我从数据库里读回
/// 一段文本，它却变成了字节"是那种要到很后面才会被发现的问题。加一个标签，
/// 两个方向的语义就都明确：带标签的是字节，不带的是文本。
fn value_to_json(value: ValueRef<'_>) -> Value {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::from(number),
        // 非有限浮点数在 JSON 里没有表示（`JSON.stringify(NaN)` 得到 `null`），
        // 因此与 SQLite 自己把 NaN 存成 NULL 的行为保持一致。
        ValueRef::Real(number) => serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => {
            serde_json::json!({ "$blob": BASE64.encode(bytes) })
        }
    }
}

/// 把 SQLite 的错误翻成一句**能指路**的话。
///
/// 原文照抄（它有"near …: syntax error"这类关键信息），但把 SQL 前 200 个字节
/// 一起带上 —— 一个插件里同时有十几条 SQL 时，只有错误没有语句是没法定位的。
fn sql_error(action: &str, sql: &str, error: rusqlite::Error) -> String {
    let head: String = sql.chars().take(200).collect();
    format!("{action} SQL 失败：{error}（语句：{head}）")
}

/// 从 JSON 值构造一个 SQLite 参数。
///
/// `{"$blob": "<base64>"}` → BLOB；对象与数组 → JSON 文本（插件要存结构化数据时
/// 不必自己 `JSON.stringify`）；其余按字面类型。
pub fn json_to_sql(value: &Value) -> Result<SqlValue, String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                SqlValue::Integer(integer)
            } else {
                SqlValue::Real(
                    number
                        .as_f64()
                        .ok_or_else(|| format!("这个数字表示不了：{number}"))?,
                )
            }
        }
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(map) => {
            if let Some(Value::String(encoded)) = map.get("$blob") {
                if map.len() != 1 {
                    return Err(
                        "{\"$blob\": …} 里不能有别的字段 —— 它要么是字节，要么是别的".to_string()
                    );
                }
                SqlValue::Blob(
                    BASE64
                        .decode(encoded)
                        .map_err(|e| format!("$blob 不是合法的 base64：{e}"))?,
                )
            } else {
                SqlValue::Text(Value::Object(map.clone()).to_string())
            }
        }
        Value::Array(_) => SqlValue::Text(value.to_string()),
    })
}

/// 插件数据目录里那个数据库文件的路径。
///
/// 单独一个函数是为了让"数据库文件在哪"只有一处定义 —— 备份、用量统计与
/// 未来的"导出插件数据"都要问同一个问题。
pub fn database_file(root: &Path) -> PathBuf {
    root.join(DB_FILE_NAME)
}

/// 一条**相对数据根的路径**是否指向那个数据库文件。
///
/// 由 `PluginManager` 在 `data_write` / `data_remove` 里调用：它是引擎掌握的文件，
/// 写一段普通内容进去会让整个库变成 "file is not a database"，而插件自己一点数据
/// 都取不回来 —— 那是不可逆的。**读不拦**：把 `plugin.db` 复制出去做备份是合理
/// 用法，而备份恰好应该在损坏发生之前就能做。
///
/// 判据是**文件名比较**，不是路径规范化 —— 后者已经由 `data_dir::resolve` 做完
/// （`..`、盘符、符号链接都到不了这里）。额外的 `trim_end_matches` 是因为
/// Windows 会静默丢掉文件名末尾的空格与点：`plugin.db ` 打开的仍然是 `plugin.db`，
/// 而一个只比字面量的判据会放过它。
pub fn is_reserved_data_path(rel: &str) -> bool {
    let name = rel
        .trim_start_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', '.']);

    name.eq_ignore_ascii_case(DB_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join("modulith-db-tests")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("建临时目录");
        root
    }

    fn open_temp(name: &str) -> (Connection, PathBuf) {
        let root = temp_root(name);
        let path = database_file(&root);
        let connection = open_at(&path, 16 * 1024 * 1024).expect("应当能打开");
        (connection, root)
    }

    /// **这一节最重要的一条。**
    ///
    /// `ATTACH` 是唯一一条能让插件在同一个连接里打开**插件数据目录之外**的文件
    /// 的 SQL。挡它的必须是引擎（authorizer），不能是文本过滤 ——
    /// 这条测试直接执行 `ATTACH`，也就是"文本过滤被绕过之后"的那一刻。
    #[test]
    fn attach_and_detach_are_refused_by_the_engine() {
        let (connection, root) = open_temp("attach");
        let outside = root.join("..").join("outside.db");
        let outside_text = outside.to_string_lossy().replace('\\', "/");

        let attach = connection.execute_batch(&format!("ATTACH DATABASE '{outside_text}' AS other;"));
        assert!(attach.is_err(), "ATTACH 必须被拒绝");
        assert!(
            !outside.exists(),
            "被拒绝的 ATTACH 不该真的建出那个文件"
        );

        // 注释与大小写都绕不过它 —— 这正是不做文本过滤的理由。
        assert!(
            connection
                .execute_batch(&format!("AT/**/TACH DATABASE '{outside_text}' AS other2;"))
                .is_err(),
            "带注释的 ATTACH 同样要被拒绝"
        );
        assert!(
            connection
                .execute_batch(&format!("attach database '{outside_text}' as other3;"))
                .is_err(),
            "小写的 ATTACH 同样要被拒绝"
        );
        assert!(!outside.exists(), "任何一次都不该真的建出那个文件");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 让配额失效的那几个 PRAGMA 必须被拒绝 —— 否则"上限"只是一句建议。
    #[test]
    fn pragmas_that_defeat_the_budget_are_refused() {
        let (connection, root) = open_temp("pragma");

        for hostile in [
            "PRAGMA max_page_count = 100000000;",
            "PRAGMA page_size = 65536;",
            "PRAGMA journal_mode = MEMORY;",
            "PRAGMA locking_mode = EXCLUSIVE;",
            "PRAGMA writable_schema = ON;",
        ] {
            assert!(
                connection.execute_batch(hostile).is_err(),
                "这条 PRAGMA 必须被拒绝：{hostile}"
            );
        }

        // 反方向：正常的 PRAGMA 必须照常可用 —— 否则上面那条测试可以靠"全部拒绝"通过。
        for ok in ["PRAGMA foreign_keys = ON;", "PRAGMA user_version = 3;"] {
            assert!(
                connection.execute_batch(ok).is_ok(),
                "这条 PRAGMA 应当被允许：{ok}"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 上限真的是引擎在管：写满之后返回的是 `SQLITE_FULL`，而不是把磁盘写满。
    #[test]
    fn the_page_limit_is_enforced_by_the_engine() {
        let root = temp_root("budget");
        let path = database_file(&root);

        // 给一个只有十几页的预算，然后塞进远超它的数据
        let connection = open_at(&path, 16 * 4096).expect("应当能打开");
        connection
            .execute_batch("CREATE TABLE big (payload TEXT);")
            .expect("建表");

        let big = "x".repeat(4096);
        let mut refused = false;
        for _ in 0..200 {
            if connection
                .execute("INSERT INTO big (payload) VALUES (?1)", [&big])
                .is_err()
            {
                refused = true;
                break;
            }
        }

        assert!(refused, "超出页数上限之后写入必须失败");

        // 而 SQL 层面的错误确实在说"满了"，不是别的什么错误
        let message = connection
            .execute("INSERT INTO big (payload) VALUES (?1)", [&big])
            .unwrap_err()
            .to_string();
        assert!(
            message.to_lowercase().contains("full"),
            "错误消息该说清是满了：{message}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 一次调用只编译一条语句。
    #[test]
    fn a_second_statement_in_one_call_is_refused() {
        let (connection, root) = open_temp("multi");

        let two = run_exec(&connection, "SELECT 1; SELECT 2;", &[]);
        assert!(two.is_err(), "多条语句必须在**编译**阶段就被拒绝");

        // 单条带分号的正常语句照常可用（末尾的分号不该被当成第二条）。
        // 走 `run_query` 而不是 `run_exec`：后者对返回行的语句本来就会报
        // `ExecuteReturnedResults`，那是 rusqlite 的接口形状，与"几条语句"无关。
        assert!(run_query(&connection, "SELECT 1;", &[]).is_ok());
        assert!(run_query(&connection, "SELECT 1", &[]).is_ok());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 值在 Rust ↔ SQLite 之间往返必须**无损**，而 BLOB 与文本必须分得开。
    #[test]
    fn values_round_trip_and_blobs_stay_distinguishable() {
        let (connection, root) = open_temp("types");
        connection
            .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v);")
            .expect("建表");

        let cases: Vec<Value> = vec![
            Value::Null,
            Value::from(true),
            Value::from(42_i64),
            Value::from(1.5_f64),
            Value::from("文本"),
            Value::from("eA=="), // 一段**恰好是合法 base64 的文本**
            serde_json::json!({ "$blob": "aGVsbG8=" }),
            serde_json::json!({ "nested": [1, 2, 3] }),
            serde_json::json!([1, "二", null]),
        ];

        for value in cases.iter() {
            run_exec(
                &connection,
                "INSERT INTO t (v) VALUES (?1)",
                std::slice::from_ref(value),
            )
            .expect("插入");
        }

        let result = run_query(&connection, "SELECT v FROM t ORDER BY id", &[]).expect("查询");
        assert_eq!(result.rows.len(), cases.len());

        // 文本 "eA==" 读回来必须**还是文本**，而不是被当成字节
        assert_eq!(result.rows[5][0], Value::from("eA=="));
        // 而真正的字节回来自带标签
        assert_eq!(result.rows[6][0], serde_json::json!({ "$blob": "aGVsbG8=" }));
        // 对象与数组按 JSON 文本存，读回来是一段文本（插件自己 parse）
        assert_eq!(
            result.rows[7][0],
            Value::from(serde_json::json!({ "nested": [1, 2, 3] }).to_string())
        );
        assert_eq!(
            result.rows[8][0],
            Value::from(serde_json::json!([1, "二", null]).to_string())
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 重名列必须**各占一列**，不能被折成一个键。
    ///
    /// 这正是"列与行分开返回"的理由：折成对象之后插件拿到的是一个悄悄少了东西的
    /// 结果，而那种错误要到很后面才会被发现。
    #[test]
    fn duplicate_column_names_are_preserved() {
        let (connection, root) = open_temp("columns");

        let result = run_query(&connection, "SELECT 1 AS id, 2 AS id", &[]).expect("查询");
        assert_eq!(result.columns, vec!["id".to_string(), "id".to_string()]);
        assert_eq!(result.rows, vec![vec![Value::from(1), Value::from(2)]]);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 事务：全成功，或者**一条都不生效**。
    #[test]
    fn a_failed_transaction_leaves_nothing_behind() {
        let (mut connection, root) = open_temp("transaction");
        connection
            .execute_batch("CREATE TABLE t (v INTEGER NOT NULL CHECK (v >= 0));")
            .expect("建表");

        let ok = vec![
            Statement {
                sql: "INSERT INTO t (v) VALUES (?1)".to_string(),
                params: vec![Value::from(1)],
            },
            Statement {
                sql: "INSERT INTO t (v) VALUES (?1)".to_string(),
                params: vec![Value::from(2)],
            },
        ];
        let results = run_transaction(&mut connection, &ok).expect("这一批应当成功");
        assert_eq!(results.len(), 2);

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        // 第二条违反 CHECK —— 第一条也**不该**留下来
        let bad = vec![
            Statement {
                sql: "INSERT INTO t (v) VALUES (?1)".to_string(),
                params: vec![Value::from(3)],
            },
            Statement {
                sql: "INSERT INTO t (v) VALUES (?1)".to_string(),
                params: vec![Value::from(-1)],
            },
        ];
        assert!(run_transaction(&mut connection, &bad).is_err(), "应当失败");

        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "失败的那一批一条都不该生效");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 外键**默认就是开的** —— 插件声明了外键却发现自己删掉父行之后子行还在，
    /// 那看起来像"数据库不守规矩"。
    #[test]
    fn foreign_keys_are_on_by_default() {
        let (connection, root) = open_temp("fk");
        connection
            .execute_batch(
                "CREATE TABLE parent (id INTEGER PRIMARY KEY);
                 CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));",
            )
            .expect("建表");

        let orphan = connection.execute("INSERT INTO child (parent_id) VALUES (999)", []);
        assert!(orphan.is_err(), "没有父行时外键必须拒绝插入");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 输入卫生：空 SQL、超长 SQL、参数过多都要在**进引擎之前**被挡下。
    #[test]
    fn absurd_inputs_are_rejected_before_reaching_the_engine() {
        assert!(validate("", &[]).is_err());
        assert!(validate("   ", &[]).is_err());
        assert!(validate(&"a".repeat(MAX_SQL_BYTES + 1), &[]).is_err());
        assert!(validate("SELECT 1", &vec![Value::Null; MAX_PARAMS + 1]).is_err());

        // 正常的照常通过
        assert!(validate("SELECT ?1", &[Value::Null]).is_ok());
        assert!(validate(&"a".repeat(MAX_SQL_BYTES), &[]).is_ok());
    }

    /// 直接改 `sqlite_master` 必须被挡住 —— 但挡它的是 **SQLite 自己**，
    /// 不是我们那条 authorizer 规则（那条因为会连带拒绝所有 DDL 已经删掉了，
    /// 见 `install_authorizer` 里的说明）。
    ///
    /// 这条测试是那次教训的护栏：它证明"删掉那条规则"没有把保护一起删掉。
    #[test]
    fn schema_editing_is_refused_by_sqlite_itself() {
        let (connection, root) = open_temp("schema");
        connection
            .execute_batch("CREATE TABLE t (v INTEGER);")
            .expect("建表");

        let tamper = connection.execute("UPDATE sqlite_master SET sql = ''", []);
        assert!(tamper.is_err(), "直接改 sqlite_master 必须失败");

        let message = tamper.unwrap_err().to_string();
        assert!(
            message.contains("may not be modified"),
            "挡住它的应当是引擎自己的那句话：{message}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 预算必须是数据目录配额的一半，而且**至少得一页**。
    #[test]
    fn the_database_budget_is_a_sane_share_of_the_data_quota() {
        let budget = budget_bytes();
        assert!(budget > 0);
        assert!(budget < super::super::data_dir::MAX_TOTAL_BYTES);
        assert_eq!(
            budget,
            super::super::data_dir::MAX_TOTAL_BYTES / DB_BUDGET_SHARE
        );
    }

    #[test]
    fn a_fresh_registry_has_nothing_open() {
        let databases = PluginDatabases::new();
        assert_eq!(databases.open_count(), 0);
        databases.close("nobody");
        assert_eq!(databases.open_count(), 0);
        databases.close_all();
        assert_eq!(databases.open_count(), 0);
    }

    /// 数据库文件是保留名 —— `ctx.dataDir` 不能覆盖或删掉它。
    ///
    /// **这条测试的重点是那张"必须命中"的表**：一个只比字面量 `plugin.db` 的
    /// 判据会放过 `plugin.db `（Windows 会静默丢掉末尾的空格）与 `Plugin.DB`
    /// （同一个文件的另一种大小写），而它们打开的正是那个引擎掌握的文件。
    #[test]
    fn the_database_file_name_is_reserved() {
        for reserved in [
            "plugin.db",
            "Plugin.DB",
            "PLUGIN.DB",
            "plugin.db ",
            "plugin.db.",
            "sub/plugin.db",
            "/plugin.db",
            "\\plugin.db",
        ] {
            assert!(
                is_reserved_data_path(reserved),
                "这个路径指向数据库文件，必须被拦住：{reserved:?}"
            );
        }

        // 反方向：别的名字必须照常可用 —— 否则上面那条可以靠"全部拒绝"通过。
        for allowed in [
            "plugin.db.bak",
            "notes.db",
            "backup/plugin.db.bak",
            "plugin.db2",
            "myplugin.db",
            "",
        ] {
            assert!(
                !is_reserved_data_path(allowed),
                "这个路径不是数据库文件，不该被拦住：{allowed:?}"
            );
        }
    }
}
