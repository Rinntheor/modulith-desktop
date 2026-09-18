#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use modulith_desktop_lib::run;

fn main() -> Result<(), tauri::Error> {
    run()
}