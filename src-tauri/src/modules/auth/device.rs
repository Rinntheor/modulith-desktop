// src-tauri/src/modules/auth/device.rs
//
// 设备标识：把前端上报的指纹字段折叠成一个稳定的设备 ID。
//
// 与 hive_atelier 的差异：原实现把各字段直接首尾相接后哈希，
// `"ab" + "c"` 与 `"a" + "bc"` 会得到同一个 ID；这里加入分隔符消除歧义。

use super::crypto::sha256_hex;
use super::types::DeviceFingerprint;

/// 字段分隔符（US，Unit Separator）：不会出现在任何真实指纹字段里
const FIELD_SEPARATOR: char = '\u{1f}';

impl DeviceFingerprint {
    /// 由前端上报字段生成设备 ID（SHA-256 十六进制，64 字符）
    pub fn device_id(&self) -> String {
        let mut joined = String::new();
        for part in [
            &self.user_agent,
            &self.screen_resolution,
            &self.timezone,
            &self.language,
            &self.platform,
        ] {
            joined.push_str(part);
            joined.push(FIELD_SEPARATOR);
        }
        sha256_hex(joined.as_bytes())
    }

    /// 设备标签，例如 `Win32 · 1a2b3c4d`
    pub fn label(&self) -> String {
        let id = self.device_id();
        let platform = self.platform.trim();
        let platform = if platform.is_empty() { "unknown" } else { platform };
        format!("{} · {}", platform, &id[..8.min(id.len())])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint() -> DeviceFingerprint {
        DeviceFingerprint {
            user_agent: "Mozilla/5.0".to_string(),
            screen_resolution: "1920x1080".to_string(),
            timezone: "Asia/Shanghai".to_string(),
            language: "zh-CN".to_string(),
            platform: "Win32".to_string(),
        }
    }

    #[test]
    fn device_id_is_stable() {
        let fp = fingerprint();
        assert_eq!(fp.device_id(), fingerprint().device_id());
        assert_eq!(fp.device_id().len(), 64);
        assert!(fp.device_id().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn device_id_changes_with_any_field() {
        let base = fingerprint().device_id();

        let mut other = fingerprint();
        other.screen_resolution = "2560x1440".to_string();
        assert_ne!(base, other.device_id());

        let mut other = fingerprint();
        other.user_agent = String::new();
        assert_ne!(base, other.device_id());
    }

    #[test]
    fn field_boundaries_cannot_collide() {
        // 没有分隔符时 "ab"+"c" 与 "a"+"bc" 会撞在一起，这里必须区分开
        let mut a = fingerprint();
        a.user_agent = "ab".to_string();
        a.screen_resolution = "c".to_string();

        let mut b = fingerprint();
        b.user_agent = "a".to_string();
        b.screen_resolution = "bc".to_string();

        assert_ne!(a.device_id(), b.device_id());
    }

    #[test]
    fn label_falls_back_for_empty_platform() {
        let mut fp = fingerprint();
        fp.platform = "   ".to_string();
        assert!(fp.label().starts_with("unknown · "));

        let label = fingerprint().label();
        assert!(label.starts_with("Win32 · "));
        assert_eq!(label.len(), "Win32 · ".len() + 8);
    }
}
