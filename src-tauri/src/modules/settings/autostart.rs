// src-tauri/src/modules/settings/autostart.rs
//
// 开机自启动。
//
// **为什么自己写、不引 `tauri-plugin-autostart`：** 本项目只需要「当前用户、
// 单个值、一条命令行」这一种形态，而注册表 API 已经有 `windows-sys` 依赖可用
// （图标提取在用同一份）。引一个跨平台插件会带来它的平台分支、错误类型与版本
// 耦合，换来的却只是同一段注册表调用 —— 与「为什么不用 tauri-plugin-log」
// 是同一个判断。
//
// **只写 HKCU，不写 HKLM。** 前者不需要管理员权限，也只影响当前用户；把自启动项
// 写进 HKLM 会让安装或首次运行要求提权，而这件事完全不需要那种权限。
//
// **注册表是「是否自启动」的唯一真相。** 设置文件里刻意不存这份状态：用户可以在
// 任务管理器的「启动」页里直接关掉它，那时 `settings.json` 里的副本就会与事实
// 不符，而界面会显示一个位置错误的开关。因此界面读的是这里返回的**实际**状态。
//
// 非 Windows 平台返回明确的「不支持」，**不是静默假装成功** —— 一个显示为已开启、
// 实际什么都没做的开关，比不支持更糟。

/// Run 键下写入的值名。
///
/// 这个名字同时出现在任务管理器的「启动」页里，因此用产品显示名而不是包名。
const VALUE_NAME: &str = "Modulith Desktop";

/// 由系统自启动拉起时附加的命令行标记。
///
/// 这个标记是必要的：静默启动与启动全屏只应在「系统把我拉起来」时生效，用户
/// 双击图标启动不该被它们影响。没有它就无法区分这两种启动。
pub const AUTOSTART_FLAG: &str = "--autostart";

/// 构造要写入注册表的完整命令行。
///
/// 路径用引号包裹：`Program Files` 之类的路径含空格，不加引号会被系统按空格拆成
/// 「程序名 + 参数」，结果是开机时什么都没启动，而且不会有任何报错。
pub fn autostart_command(exe: &std::path::Path) -> String {
    format!("\"{}\" {}", exe.display(), AUTOSTART_FLAG)
}

/// 本次进程是否由开机自启动拉起。
pub fn launched_by_autostart() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_FLAG)
}

/// 读取**实际**的自启动状态。
pub fn is_enabled() -> Result<bool, String> {
    platform::is_enabled()
}

/// 使系统自启动状态与 `enabled` 一致。
pub fn set_enabled(enabled: bool, command: &str) -> Result<(), String> {
    platform::set_enabled(enabled, command)
}

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ,
    };

    use super::VALUE_NAME;

    /// 当前用户的 Run 键
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    /// Windows 错误码 `ERROR_FILE_NOT_FOUND`：值不存在时会返回它。
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    /// 转成以 NUL 结尾的 UTF-16（Win32 的 `PCWSTR`）
    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn open_run_key(write: bool) -> Result<HKEY, String> {
        let mut key: HKEY = std::ptr::null_mut();
        let access = if write { KEY_SET_VALUE } else { KEY_READ };
        let path = wide(RUN_KEY);

        let code = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut key) };

        if code != 0 {
            return Err(format!("打开注册表 Run 键失败（错误码 {code}）"));
        }
        Ok(key)
    }

    pub fn is_enabled() -> Result<bool, String> {
        let key = open_run_key(false)?;

        // REG_SZ 的数据是 UTF-16。这里只判断「值在不在」，因此不关心内容；给足
        // 2 KiB 是为了让常见路径一次读完（放不下时会返回 ERROR_MORE_DATA，那同样
        // 说明值存在，但我们把它当错误上报，不猜）。
        let mut buffer = [0u16; 1024];
        let mut size: u32 = (buffer.len() * 2) as u32;
        let name = wide(VALUE_NAME);

        let code = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut u8,
                &mut size,
            )
        };
        unsafe { RegCloseKey(key) };

        match code {
            0 => Ok(true),
            ERROR_FILE_NOT_FOUND => Ok(false),
            other => Err(format!("读取自启动项失败（错误码 {other}）")),
        }
    }

    pub fn set_enabled(enabled: bool, command: &str) -> Result<(), String> {
        let key = open_run_key(true)?;
        let name = wide(VALUE_NAME);

        let code = if enabled {
            let data = wide(command);
            unsafe {
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    data.as_ptr() as *const u8,
                    (data.len() * 2) as u32,
                )
            }
        } else {
            unsafe { RegDeleteValueW(key, name.as_ptr()) }
        };
        unsafe { RegCloseKey(key) };

        // 删除一个本就不存在的值会返回 ERROR_FILE_NOT_FOUND —— 那正是「关闭」想要
        // 的结果，不是失败。把它当错误会让用户在「我已经关过了」的情况下看到报错。
        if code == 0 || (code == ERROR_FILE_NOT_FOUND && !enabled) {
            Ok(())
        } else {
            Err(format!("写入自启动项失败（错误码 {code}）"))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    const UNSUPPORTED: &str =
        "当前平台尚未实现开机自启动（目前仅 Windows）。这个开关不会假装成功。";

    pub fn is_enabled() -> Result<bool, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn set_enabled(_enabled: bool, _command: &str) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}
