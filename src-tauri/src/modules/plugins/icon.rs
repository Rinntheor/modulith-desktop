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

use std::path::Path;

use super::types::PluginResult;

/// 提取图标的目标边长（像素）。
///
/// 64 是卡片缩略图在 2x 屏下的合理取值：32 放大后发虚，256 会让每个条目的
/// data URL 膨胀到数百 KB。Windows 会按这个尺寸缩放图标。
pub const ICON_SIZE: i32 = 64;

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
            return Err(PluginError::IconExtractionFailed(format!(
                "该文件没有可提取的图标: {}",
                path.display()
            )));
        }

        // HICON 必须被销毁，否则每提取一次就泄漏一个 GDI 对象 ——
        // 而 GDI 对象有进程级上限，泄漏足够多次会让整个应用画不出东西。
        let result = unsafe { hicon_to_rgba(hicon, path) };
        unsafe { DestroyIcon(hicon) };
        result
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

    /// 没有图标资源的文件应当明确失败，而不是返回一张空图
    #[cfg(windows)]
    #[test]
    fn reports_failure_for_a_file_without_icon_resource() {
        let plain = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert!(plain.is_file(), "样本文件应当存在: {}", plain.display());

        let err = extract_icon_data_url(&plain).expect_err("非 PE 文件不应有图标资源");
        assert!(
            matches!(
                err,
                super::super::types::PluginError::IconExtractionFailed(_)
            ),
            "期望 IconExtractionFailed，实际: {:?}",
            err
        );
    }
}
