// src-tauri/src/core/watchdog.rs
//
// 主线程停滞看门狗。**只在 debug 构建里存在。**
//
// ============================================================
// 它为什么值得存在
// ============================================================
//
// 这个项目已经因为"主线程卡住"付出过两次代价，而两次的现象都**完全不像**
// "主线程卡住"：
//
//   * 关闭按钮点了没反应 —— 看起来像窗口管理的 bug；
//   * 全部插件失效 —— 看起来像插件加载的问题；
//   * 托盘菜单没反应 —— 看起来像托盘的问题；
//   * 日志戛然而止，没有任何 ERROR。
//
// 真因是同一个：主线程再也不返回事件循环，而窗口按钮、托盘、其它插件的 IPC
// 全都在那条线程上。**没有任何一处会因此报错**，因为出错的不是它们。
//
// 于是需要一件很便宜的事：一条独立的线程，每隔几秒往主线程投一个"报个到"的
// 闭包。主线程只要还在跑事件循环，那个闭包就会被执行；它要是不再被执行，
// 停滞就是事实，而不是猜测。
//
// 它**不做任何恢复动作**。已经停滞的主线程不会因为一条日志而复活，而在这种
// 状态下试图"救回来"只会把现场破坏掉。它唯一的产出是一句能定位的话。
//
// ============================================================
// 为什么是 debug-only
// ============================================================
//
// 它对用户没有任何价值，却会在每一次真实卡顿（磁盘抖动、主线程上有正常的长
// 任务）时往日志里写一条吓人的 ERROR。这类噪声的代价是真实存在的：一旦用户
// 习惯了忽略 ERROR，真出问题时就没人看了。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime};

/// 投一次"报到"之后等多久算停滞。
///
/// 3 秒而不是 1 秒：主线程上确实存在合法的长任务（安装插件、磁盘 IO、
/// 一次较大的序列化），把 1 秒级的正常抖动报成"卡死"会立刻让这条日志贬值。
const STALL: Duration = Duration::from_secs(3);

/// 投递间隔。停滞检查本身要花一个 `STALL`，两者合起来决定告警的密度。
const INTERVAL: Duration = Duration::from_secs(2);

/// 起一条看门狗线程。
///
/// 线程会因为"事件循环已经结束"（`run_on_main_thread` 返回 `Err`）而自行退出，
/// 因此不需要停机协议。
pub fn spawn_main_thread_watchdog<R: Runtime>(app: AppHandle<R>) {
    let counter = Arc::new(AtomicU64::new(0));

    std::thread::Builder::new()
        .name("modulith-watchdog".to_string())
        .spawn(move || {
            // 停在哪一段：只在"从活着变成停滞"的那一刻报一次。持续停滞时
            // 每一轮都写一条会把真正有用的那**第一条**埋掉。
            let mut reported = false;

            loop {
                std::thread::sleep(INTERVAL);

                let beat = counter.clone();
                if app
                    .run_on_main_thread(move || {
                        beat.fetch_add(1, Ordering::Relaxed);
                    })
                    .is_err()
                {
                    log::info!("[看门狗] 事件循环已结束，看门狗退出");
                    return;
                }

                std::thread::sleep(STALL);

                if counter.load(Ordering::Relaxed) == 0 {
                    if !reported {
                        reported = true;
                        log::error!(
                            "[看门狗] 主线程已经 ≥{} 秒没有响应事件循环。\
                             此时窗口的关闭/最大化/最小化、托盘菜单、以及所有插件的 IPC \
                             都不会有任何反应 —— 而它们都不会报错，因为它们本身没坏。\
                             **卡住的位置看这一条之前的最后几条日志。**",
                            STALL.as_secs()
                        );
                    }
                } else {
                    // 这一轮主线程是活的：把计数清回去，下一次停滞能再报一次。
                    counter.store(0, Ordering::Relaxed);
                    reported = false;
                }
            }
        })
        .ok();
}
