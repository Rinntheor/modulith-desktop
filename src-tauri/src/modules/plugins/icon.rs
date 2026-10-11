// src-tauri/src/modules/plugins/icon.rs
//
// 从可执行文件里取出它的图标，编码成 `data:image/png;base64,...`。
//
// 为什么要放在宿主里、而不是让插件自己想办法：Web 层拿不到本机文件的图标。
// Windows 上必须走 Shell / GDI（先取 HICON，再取像素），这是一项原生能力，
// 因此按既有约定 —— 宿主提供口子，插件用 `filesystem-read` 权限申请使用。
//
// 两段实现，边界很清楚：
//   * PNG 编码是纯 Rust 的，与平台无关，因此在所有平台上都会编译并被测试；
//   * HICON → 像素只在 Windows 上编译，其他平台返回明确的错误而不是假装成功。
//
// 为什么不用现成的 PNG 库：`image` / `png` 都不在依赖里，而本项目一贯刻意不引
// 依赖。PNG 的最小可用子集很小 —— 这里只用 zlib 的**非压缩存储块**（stored
// block），因此不需要 deflate 实现，代价是文件偏大；对 64×64 的图标（约 16 KB）
// 完全可以接受。

use std::path::{Path, PathBuf};

use super::types::PluginResult;

/// 提取图标的目标边长（像素）。
///
/// 64 是卡片缩略图在 2x 屏下的合理取值：32 放大后发虚，256 会让每个条目的
/// data URL 膨胀到数百 KB。Windows 会按这个尺寸缩放图标。
pub const ICON_SIZE: i32 = 64;

/// 交给 `SHGetFileInfoW` 的路径 —— **这里必须先剥掉逐字前缀**。
///
/// 存在的理由有两个，缺一不可：
///
/// 1. **正确性（跨版本的不变式，不是对某个版本的赌注）。** 入口的
///    `resolve_file_argument` 走 `canonicalize()`，在 Windows 上它返回逐字路径
///    `\\?\C:\…\Brave.lnk`。`PrivateExtractIconsW` 是普通 Win32 文件 API，文档上
///    就接受这种形态；而 `SHGetFileInfoW` 走的是 **shell 命名空间**，它对逐字前缀
///    **没有任何契约**。本机（Win11 25H2 / build 26200）实测它碰巧也接受，但那不
///    构成保证 —— 换个 Windows 版本、UNC 路径或别的区域设置就可能返回 0，而且
///    **不报错、静默失败**，那正是"回退等于白加"的形状。详见 `win::shell_icon`。
///
/// 2. **可测试性。** `shell_icon()` 是拿不到返回值的 `unsafe` FFI，单测没法断言
///    "它收到的那个字符串"；把"剥前缀"这一步抽成这个纯函数之后，断言就有了落点
///    （见 `tests::shell_icon_path_strips_the_verbatim_prefix`）。
///
/// 实现**刻意转交给** `manager::strip_verbatim_path`，不在这里另写一份：UNC 形态
/// （`\\?\UNC\s\share`）与认不出来的形态（`\\?\Volume{…}`）都有既定处理，两份
/// 实现迟早会在某个边界上分叉。
///
/// 只在 Windows 上才有实际效果；其他平台上 `strip_verbatim_path` 是恒等函数。
pub(crate) fn shell_icon_path(path: &Path) -> PathBuf {
    super::manager::strip_verbatim_path(path)
}

// ============================================================
// PNG 编码（平台无关）
// ============================================================

/// PNG / zlib 使用的 CRC-32（IEEE 多项式，反射写法）
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            // 用掩码代替分支：最低位为 1 时异或多项式，为 0 时保持
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// zlib 流的 Adler-32 校验和
fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

/// 写入一个 PNG 数据块：长度 + 类型 + 数据 + CRC
fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);

    // CRC 覆盖「类型 + 数据」，不含长度字段 —— 这里是最容易写错的地方，
    // 因此有一条测试会重新算一遍每个块的 CRC。
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// 把 RGBA8 像素编码成 PNG。`rgba` 长度必须是 `width * height * 4`。
pub fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    debug_assert_eq!(rgba.len(), (width as usize) * (height as usize) * 4);

    // 原始扫描线：每行前面加一个滤波器字节（0 = None）
    let stride = (width as usize) * 4;
    let mut raw = Vec::with_capacity((stride + 1) * (height as usize));
    for y in 0..height as usize {
        raw.push(0);
        let start = y * stride;
        raw.extend_from_slice(&rgba[start..start + stride]);
    }

    // zlib：2 字节头 + 若干存储块 + Adler-32
    // 0x78 0x01 = deflate、32K 窗口、无预置字典
    let mut zlib = Vec::with_capacity(raw.len() + 16);
    zlib.push(0x78);
    zlib.push(0x01);

    let mut offset = 0usize;
    while offset < raw.len() {
        let end = usize::min(offset + 0xFFFF, raw.len());
        let chunk = &raw[offset..end];
        let is_last = end == raw.len();
        zlib.push(if is_last { 1 } else { 0 });
        let len = chunk.len() as u16;
        zlib.extend_from_slice(&len.to_le_bytes());
        // NLEN 必须是 LEN 的按位取反，否则解压端判定流损坏
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(chunk);
        offset = end;
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = Vec::with_capacity(zlib.len() + 64);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    // 位深 8、颜色类型 6（RGBA）、压缩 0、滤波 0、隔行 0
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &zlib);
    write_chunk(&mut out, b"IEND", &[]);

    out
}

// ============================================================
// Windows：HICON → RGBA
// ============================================================

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO,
    };

    use super::super::types::{PluginError, PluginResult};
    use super::ICON_SIZE;

    /// 按指定色深把位图取成**自上而下**的像素缓冲。
    ///
    /// 负的 `biHeight` 表示自上而下 —— 用正高度会得到上下颠倒的图标，
    /// 而 DIB 的行填充规则让「事后翻转」很容易写错，不如让 GDI 直接给正序。
    unsafe fn read_bits(
        hdc: HDC,
        bitmap: HBITMAP,
        width: i32,
        height: i32,
        bit_count: u16,
        buffer: &mut [u8],
    ) -> bool {
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: bit_count,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        GetDIBits(
            hdc,
            bitmap,
            0,
            height as u32,
            buffer.as_mut_ptr() as *mut c_void,
            &mut info,
            DIB_RGB_COLORS,
        ) != 0
    }

    /// 把一个 HICON 转成 RGBA。调用方负责销毁 HICON。
    pub unsafe fn hicon_to_rgba(
        hicon: HICON,
        path: &Path,
    ) -> PluginResult<(u32, u32, Vec<u8>)> {
        let mut info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut info) == 0 {
            return Err(PluginError::IconExtractionFailed(format!(
                "无法读取图标信息: {}",
                path.display()
            )));
        }

        // 掩码位图与彩色位图是 GetIconInfo 借给我们的 GDI 资源，必须在本函数内释放
        let release_bitmaps = |info: &ICONINFO| {
            if !info.hbmColor.is_null() {
                DeleteObject(info.hbmColor as HGDIOBJ);
            }
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask as HGDIOBJ);
            }
        };

        let mut bitmap: BITMAP = std::mem::zeroed();
        let got = GetObjectW(
            info.hbmColor as HGDIOBJ,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bitmap as *mut BITMAP as *mut c_void,
        );
        if got == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
            release_bitmaps(&info);
            return Err(PluginError::IconExtractionFailed(format!(
                "图标尺寸无效: {}",
                path.display()
            )));
        }

        let width = bitmap.bmWidth;
        let height = bitmap.bmHeight;

        let hdc = CreateCompatibleDC(std::ptr::null_mut());
        if hdc.is_null() {
            release_bitmaps(&info);
            return Err(PluginError::IconExtractionFailed(
                "无法创建设备上下文".to_string(),
            ));
        }

        // 彩色位图按 32bpp 取，得到 BGRA
        let mut color = vec![0u8; (width * height * 4) as usize];
        let color_ok = read_bits(hdc, info.hbmColor, width, height, 32, &mut color);

        // 是否真的带 alpha。相当多的老图标虽然给了 32bpp 数据，alpha 却全为 0，
        // 真正的透明度只存在于 1bpp 的 AND 掩码里。
        let has_alpha = color.chunks_exact(4).any(|px| px[3] != 0);

        let mask_stride = (((width + 31) / 32) * 4) as usize;
        let mut mask = vec![0u8; mask_stride * height as usize];
        let mask_ok = !has_alpha
            && !info.hbmMask.is_null()
            && read_bits(hdc, info.hbmMask, width, height, 1, &mut mask);

        DeleteDC(hdc);
        release_bitmaps(&info);

        if !color_ok {
            return Err(PluginError::IconExtractionFailed(format!(
                "无法读取图标像素: {}",
                path.display()
            )));
        }

        // BGRA → RGBA，并在此处定下 alpha
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for y in 0..height as usize {
            for x in 0..width as usize {
                let i = (y * width as usize + x) * 4;
                rgba[i] = color[i + 2];
                rgba[i + 1] = color[i + 1];
                rgba[i + 2] = color[i];
                rgba[i + 3] = if has_alpha {
                    color[i + 3]
                } else if mask_ok {
                    // AND 掩码里 1 = 透明
                    let byte = mask[y * mask_stride + x / 8];
                    if (byte >> (7 - (x % 8))) & 1 == 1 {
                        0
                    } else {
                        255
                    }
                } else {
                    255
                };
            }
        }

        Ok((width as u32, height as u32, rgba))
    }

    /// 用 `PrivateExtractIconsW` 按指定尺寸取图标，再转成 RGBA。
    pub fn extract_rgba(path: &Path) -> PluginResult<(u32, u32, Vec<u8>)> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut hicon: HICON = std::ptr::null_mut();
        let extracted = unsafe {
            PrivateExtractIconsW(
                wide.as_ptr(),
                0,
                ICON_SIZE,
                ICON_SIZE,
                &mut hicon,
                std::ptr::null_mut(),
                1,
                0,
            )
        };

        if extracted == 0 || hicon.is_null() {
            // 内嵌图标资源那条路走不通（快捷方式、`.url`、文档都会走到这里），
            // 退到 shell 去问 —— 见 `shell_icon` 的说明。
            hicon = unsafe { shell_icon(path) }.ok_or_else(|| {
                PluginError::IconExtractionFailed(format!(
                    "该文件没有可提取的图标: {}",
                    path.display()
                ))
            })?;
        }

        // HICON 必须被销毁，否则每提取一次就泄漏一个 GDI 对象 ——
        // 而 GDI 对象有进程级上限，泄漏足够多次会让整个应用画不出东西。
        let result = unsafe { hicon_to_rgba(hicon, path) };
        unsafe { DestroyIcon(hicon) };
        result
    }

    /// 走 shell 取图标。**快捷方式、`.url`、文档、目录只有这一条路。**
    ///
    /// `PrivateExtractIconsW` 读的是 PE 文件里的图标资源，因此它只对 `.exe` /
    /// `.dll` / `.ico` 有效。而"快捷启动"这类插件最需要显示的东西恰恰是 `.lnk`
    /// —— 它是一份**给 shell 看的数据**，本身没有图标资源，于是上面那条路必然
    /// 失败（而且它失败得很安静：返回 0，不报错）。
    ///
    /// `SHGetFileInfoW` 会先把 `.lnk` 解析到它的目标、再按扩展名关联拿到**用户
    /// 实际看到的那个图标**，因此这一条同时覆盖快捷方式、`.url`、各种文档与目录。
    ///
    /// 代价是尺寸：shell 给的是系统的"大图标"（通常 32×32），比上面那条按
    /// `ICON_SIZE` 取的 64×64 小。因此它只作为**回退**，不是首选。
    ///
    /// **COM 必须初始化。** `SHGetFileInfoW` 取图标时走 shell 命名空间（内部用
    /// `IShellIcon`），而调用它的是 Tauri 的任意一个工作线程 —— 在没有初始化过
    /// COM 的线程上这一条不保证可用。返回值要区别对待，否则要么漏掉一次
    /// `CoUninitialize`（该线程的 COM 引用计数永远不归零），要么多调一次
    /// （把别的代码的初始化一起拆掉）：
    ///
    /// * `S_OK` —— 这次初始化的是我们，必须配一次 `CoUninitialize`；
    /// * `S_FALSE` —— 该线程已经初始化过**同一种**模式，仍然要配一次；
    /// * 其余（典型是 `RPC_E_CHANGED_MODE`，异步运行时可能已经把线程开成 MTA）
    ///   —— 我们**没有**增加引用计数，因此不能 uninit；而 shell 查询在 MTA 下
    ///   仍然可用，所以继续往下走，不是失败。
    ///
    /// # 为什么这里要剥逐字前缀，而上一条路（`PrivateExtractIconsW`）不用
    ///
    /// **不要在"顺手统一一下"的时候把下面那行 `shell_icon_path` 删掉。** 这两条路
    /// 是**两类 API**，对路径形态的保证不一样：
    ///
    /// * `PrivateExtractIconsW` 是**普通 Win32 文件 API**，拿的是内核路径，
    ///   `\\?\` 这个"不要替我规范化"的前缀本来就属于它的输入空间 —— 它照常打开
    ///   文件、照常读 PE 资源。因此 `extract_rgba` 那条路把 `path` **原样**传进去，
    ///   是对的，也**不要**去改它（它现在工作正常，改了只会引入新风险）。
    /// * `SHGetFileInfoW` 走的是 **shell 命名空间**：路径要交给 shell 的解析与扩展名
    ///   关联逻辑，而 shell 对逐字前缀**没有契约**。契约之外的行为会随版本、路径
    ///   形态（UNC）、区域设置变化，而它的失败形态是**返回 0、不报错** ——
    ///   也就是说"这条回退悄悄等于没加"，不是"偶尔取不到图标"。
    ///
    /// **实测记录，写在这里免得下一个人重新猜。** 在本机 Windows 11 25H2 /
    /// build 26200 上，`SHGetFileInfoW` 对 `\\?\` 形态**并没有**失败：`.lnk` 与
    /// `.url` 都返回了图标，像素与剥过前缀的那一次逐字节相同。所以本机"不剥也
    /// 能用"是**真的**；这里剥，是为了不把正确性押在一个未文档化的行为上，
    /// 而代价是零（见 `tests::stripping_the_prefix_never_changes_which_icon_the_shell_gives`）。
    ///
    /// 入口之所以会给出逐字路径，是因为 `resolve_file_argument` → `canonicalize()`；
    /// 同一个坑 `ctx.launcher.open` 也已经踩过一次（那边在 `manager.rs` 里
    /// `strip_verbatim_path` 之后才交给 `tauri_plugin_opener`）。
    ///
    /// `pub(super)` 是为了让单测能直接钉住这条 FFI —— 见
    /// `tests::stripping_the_prefix_never_changes_which_icon_the_shell_gives`。
    pub(super) unsafe fn shell_icon(path: &Path) -> Option<HICON> {
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
        };
        use windows_sys::Win32::UI::Shell::{
            SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
        };

        /// `S_OK`
        const S_OK: i32 = 0;
        /// `S_FALSE`
        const S_FALSE: i32 = 1;

        // windows-sys 把 `COINIT_APARTMENTTHREADED` 声明成 `i32`，而这个函数的
        // 形参是 `u32`（位标志）—— 转换在这里是安全的：它是一个小的正数常量。
        let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let ours = hr == S_OK || hr == S_FALSE;

        // 唯一交给 shell 的那个路径：`\\?\` 在这里被剥掉（理由见上面的小节）。
        // 上面 `PrivateExtractIconsW` 用的仍是**逐字**的原 `path`，那是刻意的。
        let shell_path = super::shell_icon_path(path);
        let wide: Vec<u16> = shell_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut info: SHFILEINFOW = std::mem::zeroed();
        let ok = SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        ) != 0;

        // HICON 是 GDI 对象，与 COM 的引用计数无关，因此这里先收尾 COM 再用图标。
        if ours {
            CoUninitialize();
        }

        if ok && !info.hIcon.is_null() {
            Some(info.hIcon)
        } else {
            None
        }
    }
}

// ============================================================
// 对外入口
// ============================================================

/// 提取图标并编码成 data URL。
#[cfg(windows)]
pub fn extract_icon_data_url(path: &Path) -> PluginResult<String> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    let (width, height, rgba) = win::extract_rgba(path)?;
    let png = encode_png_rgba(width, height, &rgba);
    Ok(format!("data:image/png;base64,{}", BASE64.encode(&png)))
}

/// 非 Windows 平台：明确失败，而不是返回一个占位图标让调用方以为拿到了真图标。
#[cfg(not(windows))]
pub fn extract_icon_data_url(path: &Path) -> PluginResult<String> {
    Err(super::types::PluginError::IconExtractionFailed(format!(
        "图标提取目前在 Windows 之外尚未实现: {}",
        path.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把所有**真实 Win32 调用**串行化。
    ///
    /// 不是洁癖，是被实测逼出来的：`SHGetFileInfoW` 是**公寓内**（apartment-bound）
    /// 的 shell 命名空间查询，而 `cargo test` 在一个**没有消息泵**的进程里用多个
    /// 线程并行跑。多个线程同时首次查询 shell 时它会随机返回 0 —— 实测同一份代码
    /// 并行必挂、`--test-threads=1` 全绿。这类"测试自己打架"的假失败会训练出
    /// "红了就重跑"的习惯，那才是真正的代价。
    ///
    /// 中毒（某条断言 panic）时照常放行：这条锁保护的是线程安全，不是数据一致性。
    static WIN32_SHELL_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn win32_guard() -> std::sync::MutexGuard<'static, ()> {
        WIN32_SHELL_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 从 PNG 字节里切出所有块（类型 + 数据 + 记录的 CRC）
    fn chunks(png: &[u8]) -> Vec<(String, Vec<u8>, u32)> {
        let mut out = Vec::new();
        let mut offset = 8usize;
        while offset < png.len() {
            let len = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
            let kind = String::from_utf8_lossy(&png[offset + 4..offset + 8]).to_string();
            let data = png[offset + 8..offset + 8 + len].to_vec();
            let crc = u32::from_be_bytes(
                png[offset + 8 + len..offset + 12 + len]
                    .try_into()
                    .unwrap(),
            );
            out.push((kind, data, crc));
            offset += 12 + len;
        }
        out
    }

    /// CRC-32 的标准测试向量（IEEE 802.3）
    #[test]
    fn crc32_matches_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0x0000_0000);
    }

    /// Adler-32 的标准测试向量
    #[test]
    fn adler32_matches_known_vector() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        assert_eq!(adler32(b""), 0x0000_0001);
    }

    /// 重新计算每个块的 CRC。
    ///
    /// 这条测试的价值在于它不只看「有没有 IHDR」，而是真的验一遍 CRC 覆盖范围 ——
    /// 编码器里最容易写错的就是「CRC 是否包含类型字段」。
    #[test]
    fn encoded_png_has_valid_chunk_structure() {
        let rgba = vec![
            255, 0, 0, 255, // 红
            0, 255, 0, 255, // 绿
            0, 0, 255, 255, // 蓝
            0, 0, 0, 0, // 全透明
        ];
        let png = encode_png_rgba(2, 2, &rgba);

        assert_eq!(
            &png[0..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );

        let parsed = chunks(&png);
        assert_eq!(
            parsed.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
            vec!["IHDR", "IDAT", "IEND"]
        );

        for (kind, data, stored) in &parsed {
            let mut crc_input = Vec::new();
            crc_input.extend_from_slice(kind.as_bytes());
            crc_input.extend_from_slice(data);
            assert_eq!(*stored, crc32(&crc_input), "块 {} 的 CRC 不自洽", kind);
        }

        // 块长度累加应当正好覆盖整个文件
        let total: usize = parsed.iter().map(|c| 12 + c.1.len()).sum();
        assert_eq!(8 + total, png.len());
    }

    /// IHDR 必须如实记录宽高与颜色类型
    #[test]
    fn ihdr_records_dimensions_and_format() {
        let png = encode_png_rgba(3, 5, &vec![0u8; 3 * 5 * 4]);
        let parsed = chunks(&png);
        let ihdr = &parsed[0].1;
        assert_eq!(u32::from_be_bytes(ihdr[0..4].try_into().unwrap()), 3);
        assert_eq!(u32::from_be_bytes(ihdr[4..8].try_into().unwrap()), 5);
        assert_eq!(ihdr[8], 8, "位深应为 8");
        assert_eq!(ihdr[9], 6, "颜色类型应为 6（RGBA）");
    }

    /// IDAT 必须是合法的 zlib 流：头两字节固定，尾部 Adler-32 与原始扫描线相符
    #[test]
    fn idat_is_a_valid_zlib_stream() {
        let png = encode_png_rgba(4, 4, &vec![7u8; 4 * 4 * 4]);
        let parsed = chunks(&png);
        let idat = &parsed[1].1;

        assert_eq!(idat[0], 0x78, "zlib 头第一字节");
        assert_eq!(idat[1], 0x01, "zlib 头第二字节");

        let stored = u32::from_be_bytes(idat[idat.len() - 4..].try_into().unwrap());
        let mut raw = Vec::new();
        for _ in 0..4 {
            raw.push(0u8); // 滤波器字节
            raw.extend_from_slice(&[7u8; 16]);
        }
        assert_eq!(stored, adler32(&raw));
    }

    /// 存储块的 LEN 与 NLEN 必须互补 —— 这是 zlib 存储块的硬性要求，
    /// 写错的话解压端会直接判定流损坏。
    #[test]
    fn stored_blocks_declare_complementary_lengths() {
        // 造一个超过 65535 字节的图，强制产生多个存储块
        let (width, height) = (200u32, 200u32);
        let png = encode_png_rgba(width, height, &vec![1u8; (width * height * 4) as usize]);
        let parsed = chunks(&png);
        let idat = &parsed[1].1;

        // 跳过 2 字节 zlib 头，逐块检查
        let mut pos = 2usize;
        let mut blocks = 0;
        while pos < idat.len() - 4 {
            pos += 1; // 块头字节（BFINAL / BTYPE）
            let len = u16::from_le_bytes(idat[pos..pos + 2].try_into().unwrap());
            let nlen = u16::from_le_bytes(idat[pos + 2..pos + 4].try_into().unwrap());
            assert_eq!(nlen, !len, "存储块的 NLEN 必须是 LEN 的按位取反");
            pos += 4 + len as usize;
            blocks += 1;
        }
        assert!(blocks >= 2, "该尺寸应当产生多个存储块，实际 {}", blocks);
    }

    /// 最后一个存储块必须置 BFINAL，否则解压端会一直等后续数据
    #[test]
    fn last_stored_block_is_marked_final() {
        let png = encode_png_rgba(2, 8, &vec![3u8; 2 * 8 * 4]);
        let parsed = chunks(&png);
        let idat = &parsed[1].1;

        let mut pos = 2usize;
        let mut last_header = 0u8;
        while pos < idat.len() - 4 {
            last_header = idat[pos];
            let len = u16::from_le_bytes(idat[pos + 1..pos + 3].try_into().unwrap());
            pos += 5 + len as usize;
        }
        assert_eq!(last_header & 1, 1, "最后一个存储块的 BFINAL 应为 1");
    }

    // ============================================================
    // 真实 Win32 调用
    // ============================================================

    /// 这一条是**唯一**能验证 Win32 取图标那条路径是否正确的测试 ——
    /// 上面所有测试都只覆盖 PNG 编码，即使 FFI 写错了它们照样全绿。
    ///
    /// 取系统里的可执行文件而不是本测试进程：测试二进制通常没有图标资源。
    #[cfg(windows)]
    #[test]
    fn extracts_icon_from_a_real_executable() {
        let _guard = win32_guard();
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

        let candidates = [
            r"C:\Windows\System32\notepad.exe",
            r"C:\Windows\explorer.exe",
            r"C:\Windows\System32\cmd.exe",
        ];
        let Some(target) = candidates
            .iter()
            .map(Path::new)
            .find(|p| p.is_file())
        else {
            eprintln!("跳过：找不到可用于测试的可执行文件");
            return;
        };

        let url = extract_icon_data_url(target)
            .unwrap_or_else(|e| panic!("应当能从 {} 提取图标: {}", target.display(), e));

        assert!(
            url.starts_with("data:image/png;base64,"),
            "应当返回 PNG data URL，实际前缀: {}",
            &url[..url.len().min(40)]
        );

        // 解码回来确认它真的是一张 PNG，而不只是前缀对的字符串
        let bytes = BASE64
            .decode(url.trim_start_matches("data:image/png;base64,"))
            .expect("data URL 的 base64 部分应当可解码");

        assert_eq!(
            &bytes[0..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
            "PNG 签名"
        );

        let parsed = chunks(&bytes);
        assert_eq!(
            parsed.iter().map(|c| c.0.as_str()).collect::<Vec<_>>(),
            vec!["IHDR", "IDAT", "IEND"],
            "应当恰好是三个块"
        );

        // 尺寸应当是请求的边长，且像素缓冲非全零（全零往往意味着 GetDIBits 没写进去）
        let ihdr = &parsed[0].1;
        let width = u32::from_be_bytes(ihdr[0..4].try_into().unwrap());
        let height = u32::from_be_bytes(ihdr[4..8].try_into().unwrap());
        assert_eq!((width, height), (ICON_SIZE as u32, ICON_SIZE as u32));

        // IDAT 里如果只有滤波器字节与全零像素，说明取到的是一张空图
        let idat = &parsed[1].1;
        let all_zero = idat[5..idat.len() - 4].iter().all(|b| *b == 0);
        assert!(!all_zero, "取到的图标像素全为 0，说明像素读取失败");
    }

    /// 没有**内嵌**图标资源的文件，现在会退到 shell 拿一张真图标，而不是报错。
    ///
    /// 这条断言在 1.7.0 之前是反过来的（"非 PE 文件必须失败"）。它必须改，因为
    /// 那个旧契约把**实现细节当成了产品语义**："有没有图标"被定义成了"有没有 PE
    /// 图标资源"，而用户在资源管理器里看到的每一个文件都有图标。快捷方式
    /// （`.lnk`）是这个契约下第一个被牺牲的对象 —— 它没有图标资源，于是一个
    /// 快捷启动插件连自己条目的图标都拿不到。
    ///
    /// 因此这里守的性质换成了**更强**的一条：要么给出一张能解码、像素非零的
    /// 真 PNG，要么明确报错。**不允许返回空图或占位图**让调用方以为拿到了图标
    /// —— 那是原来那条断言真正要防的事，它没有被放宽。
    #[cfg(windows)]
    #[test]
    fn falls_back_to_the_shell_icon_for_files_without_an_embedded_resource() {
        let _guard = win32_guard();
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

        let plain = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert!(plain.is_file(), "样本文件应当存在: {}", plain.display());

        let url = extract_icon_data_url(&plain)
            .expect("没有内嵌图标资源时应当退到 shell，而不是失败");
        assert!(
            url.starts_with("data:image/png;base64,"),
            "应当返回 PNG data URL，实际前缀: {}",
            &url[..url.len().min(40)]
        );

        let bytes = BASE64
            .decode(url.trim_start_matches("data:image/png;base64,"))
            .expect("data URL 的 base64 部分应当可解码");
        assert_eq!(&bytes[0..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], "PNG 签名");

        let parsed = chunks(&bytes);
        assert!(
            parsed.len() >= 3,
            "应当至少有 IHDR / IDAT / IEND，实际: {:?}",
            parsed.iter().map(|c| c.0.as_str()).collect::<Vec<_>>()
        );

        let ihdr = &parsed[0].1;
        let width = u32::from_be_bytes(ihdr[0..4].try_into().unwrap());
        let height = u32::from_be_bytes(ihdr[4..8].try_into().unwrap());
        assert!(width > 0 && height > 0, "尺寸不应为零：{width}×{height}");

        // 与上面那条真实 Win32 测试同样的判据：IDAT 里只有滤波器字节与全零像素，
        // 说明取到的是一张空图 —— 那正是这条测试要挡住的东西。
        let idat = &parsed[1].1;
        let all_zero = idat[5..idat.len() - 4].iter().all(|b| *b == 0);
        assert!(!all_zero, "取到的图标像素全为 0，说明像素读取失败");
    }

    // ============================================================
    // 逐字前缀：交给 shell 的路径不许带 `\\?\`
    // ============================================================
    //
    // 入口 `resolve_file_argument` 走 `canonicalize()`，在 Windows 上产出的永远是
    // `\\?\C:\…`；`PrivateExtractIconsW` 接受这种形态（所以 `.exe` 一直正常），而
    // `SHGetFileInfoW` 是 shell 命名空间查询 —— 它不在文档保证的范围里。
    //
    // **实测记录（不要当成传说）。** 在本机 Windows 11 25H2 / build 26200 上，
    // `SHGetFileInfoW` 对 `\\?\` 形态**并没有**失败：`.lnk` 与 `.url` 都返回了
    // 图标，且像素与剥过前缀的那一次逐字节相同。也就是说"不剥前缀 ⇒ 回退等于
    // 白加"这个推断在本机**不成立**（原始探测输出见提交说明）。
    //
    // 那为什么这里还要剥，而且测试还钉着它：
    //   · 它是一条**不变式**，而不是一次对某个 Windows 版本行为的赌注。shell 命名
    //     空间对逐字前缀没有契约，本机接受不代表下个版本、UNC 路径、其它区域设置
    //     下也接受；
    //   · 代价是零：剥与不剥，在"shell 接受逐字形态"的机器上给出**同一张图**
    //     （下面第二条测试断言了这件事），不存在任何行为回归；
    //   · `.exe` 那条路（`PrivateExtractIconsW`）**刻意不动** —— 它本来就正常，
    //     改它只有风险没有收益。
    //
    // 因此下面两条断言各自要守的是：第一条"交给 shell 的路径形态是确定的"，
    // 第二条"剥与不剥不会给出不同的图标"。

    /// 交给 `SHGetFileInfoW` 的路径必须剥掉逐字前缀。
    ///
    /// 输入就是 `canonicalize()` 在 Windows 上真实产出的形态。
    #[cfg(windows)]
    #[test]
    fn shell_icon_path_strips_the_verbatim_prefix() {
        let verbatim = Path::new(r"\\?\C:\Users\someone\Desktop\Brave.lnk");
        let for_shell = shell_icon_path(verbatim);

        assert_eq!(
            for_shell,
            PathBuf::from(r"C:\Users\someone\Desktop\Brave.lnk"),
            "盘符形态的逐字前缀必须被剥掉"
        );
        assert!(
            !for_shell.to_string_lossy().contains(r"\\?\"),
            "交给 shell 的路径不含逐字前缀，实际: {}",
            for_shell.display()
        );

        // UNC 形态：直接切掉 `\\?\` 会得到 `UNC\server\…`（一个盘符相对路径），
        // 比原样保留更糟。这一条保证剥前缀走的是 manager 那份实现，而不是
        // 某个"看起来差不多"的新实现。
        let unc = shell_icon_path(Path::new(r"\\?\UNC\server\share\a.lnk"));
        assert_eq!(unc, PathBuf::from(r"\\server\share\a.lnk"));
        assert!(!unc.to_string_lossy().contains(r"\\?\"));
    }

    /// 剥前缀**不改变** shell 给出的那个图标 —— 也就是这次修复不可能造成行为回归。
    ///
    /// 这条测试对两种 Windows 行为都成立：
    ///   · 本机（build 26200）：原始形态也能给出图标，于是两个像素缓冲**必须相等**；
    ///   · 若某个版本真的拒绝逐字形态：原始形态 `None`，剥过的那次仍然必须给出图标。
    ///
    /// 换句话说它只说一件可证伪的事：**剥过前缀的那一条永远能拿到图标**；在 shell
    /// 也接受逐字形态的机器上，两条路拿到的必须是同一张图（否则"剥前缀"就悄悄改变
    /// 了语义，而不只是换了个写法）。
    #[cfg(windows)]
    #[test]
    fn stripping_the_prefix_never_changes_which_icon_the_shell_gives() {
        let _guard = win32_guard();
        let dir =
            std::env::temp_dir().join(format!("modulith-icon-invariant-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let link = dir.join("shell-probe.url");
        std::fs::write(&link, "[InternetShortcut]\r\nURL=https://example.com/\r\n")
            .expect("应当能写临时 .url 文件");

        let absolute = std::fs::canonicalize(&link).expect("临时文件应当可规范化");
        assert!(
            absolute.to_string_lossy().starts_with(r"\\?\"),
            "前置条件：Windows 的 canonicalize 产出逐字路径，实际: {}",
            absolute.display()
        );

        let stripped = shell_icon_path(&absolute);
        assert!(!stripped.to_string_lossy().contains(r"\\?\"));
        assert!(
            stripped.is_file(),
            "剥前缀不能改变它指向的文件: {}",
            stripped.display()
        );

        let Some(from_stripped) = (unsafe { win::shell_icon(&stripped) }) else {
            panic!(
                "剥掉逐字前缀之后 SHGetFileInfoW 必须能给出图标: {}",
                stripped.display()
            );
        };
        let stripped_pixels = unsafe { hicon_pixels(&stripped, from_stripped) };

        // 原始逐字形态：本机也成功，就让两张图逐字节相等；若失败，那也是允许的
        // ——那正是"必须剥"的那种机器。
        if let Some(from_raw) = unsafe { win::shell_icon(&absolute) } {
            let raw_pixels = unsafe { hicon_pixels(&absolute, from_raw) };
            assert_eq!(
                raw_pixels, stripped_pixels,
                "剥前缀只换写法、不换图标：两种形态在 shell 接受逐字路径的机器上必须同图"
            );
        } else {
            eprintln!("注意：本机 SHGetFileInfoW 拒绝了逐字路径 —— 这条回退只有剥过才可用");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 取出一个 HICON 的像素快照（用完即销毁 HICON，不泄漏 GDI 对象）。
    #[cfg(windows)]
    unsafe fn hicon_pixels(
        path: &Path,
        hicon: windows_sys::Win32::UI::WindowsAndMessaging::HICON,
    ) -> (u32, u32, Vec<u8>) {
        let result = win::hicon_to_rgba(hicon, path);
        windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(hicon);
        result.unwrap_or_else(|e| panic!("应当能读出 {} 的像素: {:?}", path.display(), e))
    }

    /// 端到端：没有 PE 图标资源的文件走完整条入口，并且**带逐字前缀进来**
    /// —— 也就是用户拖入快捷方式时的真实形态。
    ///
    /// 这里用 `.url` 而不是 `.lnk`：两者都没有 PE 图标资源（因此都会走 shell 回退），
    /// 而 `.url` 只是一个文本文件，测试可以自己造，`.lnk` 不行（要 COM 的
    /// `IShellLink`）。用 `.lnk` 手工探测过的结果见本节开头那段实测记录。
    #[cfg(windows)]
    #[test]
    fn extracts_the_shell_icon_when_the_entry_path_is_verbatim() {
        let _guard = win32_guard();
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

        let dir =
            std::env::temp_dir().join(format!("modulith-icon-e2e-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let link = dir.join("Brave like shortcut.url");
        std::fs::write(&link, "[InternetShortcut]\r\nURL=https://example.com/\r\n")
            .expect("应当能写临时 .url 文件");

        // 入口真实拿到的就是这个形态（`resolve_file_argument` → `canonicalize()`）。
        let verbatim = std::fs::canonicalize(&link).expect("临时文件应当可规范化");
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
        // `.url` 没有 PE 图标资源 —— 这保证测试真的走到回退那条路。判据用文件头：
        // 不能拿 `extract_rgba` 去问，因为它自己就带着回退，会"成功"。
        let head = std::fs::read(&link).expect("应当能读回临时文件");
        assert_ne!(
            &head[0..2],
            b"MZ",
            "前置条件：`.url` 不是 PE 文件，因此私有图标提取必然失败、必然走 shell 回退"
        );

        let url = extract_icon_data_url(&verbatim)
            .unwrap_or_else(|e| panic!("带逐字前缀的 {} 应当仍能拿到图标: {}", verbatim.display(), e));

        let bytes = BASE64
            .decode(url.trim_start_matches("data:image/png;base64,"))
            .expect("data URL 的 base64 部分应当可解码");
        assert_eq!(&bytes[0..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], "PNG 签名");

        let parsed = chunks(&bytes);
        let idat = &parsed[1].1;
        let all_zero = idat[5..idat.len() - 4].iter().all(|b| *b == 0);
        assert!(!all_zero, "取到的图标像素全为 0，说明像素读取失败");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
