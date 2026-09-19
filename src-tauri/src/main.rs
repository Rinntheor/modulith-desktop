#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use modulith_desktop_lib::modules::logging;
use modulith_desktop_lib::run;

fn main() -> Result<(), tauri::Error> {
    // 日志器必须在最前面装好，而且要在 `run()` 之前 ——
    // 这时还没有 `AppHandle`，因此拿不到日志目录；记录会先进入内存队列，
    // 等 `LoggingModule::setup` 解析出目录后按原顺序补写到文件开头。
    //
    // 只有这样，启动阶段那几行最有用的记录（授权模块就绪、插件目录在哪）
    // 才不会丢 —— 它们发生在任何模块 setup 之前。
    logging::install_early();

    run()
}
