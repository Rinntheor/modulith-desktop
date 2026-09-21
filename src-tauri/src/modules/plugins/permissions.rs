// src-tauri/src/modules/plugins/permissions.rs
// 插件权限元数据与风险推导
//
// 这里是插件权限的**唯一**真实来源。前端不再维护自己的权限表 —— 曾经有一份
// 手写的 `PERMISSION_INFO`，含标签、描述与风险等级；现在它通过
// `list_plugin_permissions` 取回本模块的产出。
//
// 为什么风险等级必须由宿主推导，而不是逐条手写：
//
//   1. 风险是安全信息，不能由被审查的一方提供。插件自己说"我只读剪贴板"，
//      远程索引说"这个插件风险很低"，两者都是被审查对象的自述。
//   2. 同一权限在不同插件里必须是同一等级，否则用户无法横向比较两个插件。
//   3. 手写清单会随权限数量增长而漂移，且漏填不会报错 —— 它只是安静地给出
//      一句没有依据的"低风险"。旧实现恰好就是这样：风险等级只存在于前端，
//      与 Rust 枚举是两份独立维护的清单。
//
// 因此风险是**输出**而非**输入**：每项权限只声明客观属性（做了什么、影响到
// 哪里、后果能否撤销），等级由 `derive_risk` 计算。少数公式覆盖不到的风险
// 允许显式覆盖，但**必须写明理由**。

use serde::Serialize;

use super::types::PluginPermission;

/// 权限对目标做了什么
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionEffect {
    /// 只操作插件自己的数据，不触及插件之外
    None,
    /// 读取
    Read,
    /// 写入或修改
    Write,
    /// 发起网络请求
    Network,
    /// 执行代码或外部程序
    Execute,
}

/// 权限影响到哪里
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionScope {
    /// 插件私有的存储
    Plugin,
    /// 应用内部（含本机回环地址）
    App,
    /// 用户设备上的资源（文件、剪贴板、通知）
    Device,
    /// 离开本机的远端
    Remote,
    /// 系统层面，可绕过宿主约束
    System,
}

/// 风险等级。
///
/// 取值沿用前端既有的 `PermissionRisk`（`low`/`medium`/`high`），不做无谓改名 ——
/// 改名的收益是措辞更好听，代价是同时改动前后端与已有样式判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionRisk {
    Low,
    Medium,
    High,
}

/// 宿主对该权限的实际强制程度。
///
/// 这个字段存在的理由是：文档里"哪七项已强制"是一句散文，代码里则是散落的
/// `require_permission` 调用，两者会漂移。把它变成数据之后，界面才能如实
/// 标注"声明了但宿主暂不强制" —— 让用户以为某项权限受管控、而它其实不受管控，
/// 比不告诉他更危险，因为他会基于一个错误的前提做决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionEnforcement {
    /// 后端命令检查，前端绕不过去
    Host,
    /// 前端接口检查；未声明时降级为空实现并记录警告
    Frontend,
    /// 已解析并保留，但当前不改变任何行为
    None,
}

/// 单项权限的客观属性。风险不在此列 —— 它由 `derive_risk` 算出。
struct Spec {
    label: &'static str,
    description: &'static str,
    effect: PermissionEffect,
    scope: PermissionScope,
    reversible: bool,
    enforcement: PermissionEnforcement,
    risk_override: Option<RiskOverride>,
}

/// 公式覆盖不到的风险类型的显式覆盖。
///
/// `reason` 是必填的：它回答"为什么这一项特殊"。没有理由的覆盖会退化成随手改
/// 数字，而风险等级一旦失去依据，就退化回了它要取代的那份手写清单。
struct RiskOverride {
    risk: PermissionRisk,
    reason: &'static str,
}

/// 暴露给前端的权限描述。
///
/// `effect` / `scope` / `reversible` 一并暴露，而不是只给一个等级：界面可以把
/// 它们作为解释"为什么这个权限是这个等级"的依据，从而不必把推导规则再抄一遍
/// 到前端 —— 抄一遍就等于又多了一处会漂移的副本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub effect: PermissionEffect,
    pub scope: PermissionScope,
    pub reversible: bool,
    pub enforcement: PermissionEnforcement,
    /// 最终等级（推导或覆盖的结果）
    pub risk: PermissionRisk,
    /// 覆盖理由。`None` 表示由公式推导，界面可据此区分两者
    pub risk_reason: Option<&'static str>,
}

/// 由客观属性推导风险等级。
///
/// 规则**从高到低短路匹配**，因此优先级是显式的，不存在"两个条件都成立时以哪个
/// 为准"的歧义。
///
/// 注意第三条规则为何要带上 `scope == Device`：不可逆的写入如果只作用于插件
/// 自己的数据（`scope == Plugin`），那是插件对自身数据的处置权，不该因为是
/// "不可逆"就升级为高危。旧写法只判断 `effect == Write && !reversible`，会把
/// 这类情况一并升到 high。
///
/// 另一处刻意保留的冗余：当前 12 项权限中 `Execute` 规则不会单独命中 ——
/// native-module / dev-tools / process-spawn 三项都是 execute，但同时是 System
/// 作用域，已被更高优先级的规则拦下。保留它是因为两者正交：将来的代码执行能力
/// 若作用于应用内而非系统层面，它必须自动成为 high，而不需要有人记得回来补规则。
pub fn derive_risk(
    effect: PermissionEffect,
    scope: PermissionScope,
    reversible: bool,
) -> PermissionRisk {
    use PermissionEffect as E;
    use PermissionScope as S;

    if scope == S::System {
        return PermissionRisk::High;
    }
    if effect == E::Execute {
        return PermissionRisk::High;
    }
    if scope == S::Device && effect == E::Write && !reversible {
        return PermissionRisk::High;
    }
    if matches!(scope, S::Device | S::Remote) {
        return PermissionRisk::Medium;
    }
    PermissionRisk::Low
}

impl PluginPermission {
    /// 该权限的客观属性。
    ///
    /// 用 `match` 而非查表：新增枚举值时会因匹配不穷尽而**编译失败**。这是
    /// 本设计里唯一"忘记维护就会报错"的地方，也是自动化能成立的支点 ——
    /// 只要有人加了权限，编译器就会逼他填完三项属性，等级随后自动得出。
    fn spec(self) -> Spec {
        use PermissionEffect as E;
        use PermissionEnforcement as F;
        use PermissionScope as S;

        match self {
            Self::Storage => Spec {
                label: "本地存储",
                description: "在应用数据目录中读写本插件自己的键值数据",
                effect: E::None,
                scope: S::Plugin,
                reversible: true,
                enforcement: F::Host,
                risk_override: None,
            },
            Self::Network => Spec {
                label: "本机网络",
                description: "请求本机地址（127.0.0.1 / localhost）上的服务",
                effect: E::Network,
                scope: S::App,
                reversible: true,
                enforcement: F::Host,
                risk_override: None,
            },
            Self::NetworkExternal => Spec {
                label: "外部网络",
                description: "请求任意外部域名，数据会离开本机",
                effect: E::Network,
                scope: S::Remote,
                reversible: true,
                enforcement: F::Host,
                risk_override: None,
            },
            Self::Notification => Spec {
                label: "系统通知",
                description: "弹出系统级通知",
                effect: E::Write,
                scope: S::App,
                reversible: true,
                enforcement: F::Frontend,
                risk_override: None,
            },
            Self::Clipboard => Spec {
                label: "剪贴板",
                description: "读取与写入系统剪贴板",
                effect: E::Write,
                scope: S::Device,
                reversible: true,
                enforcement: F::None,
                risk_override: None,
            },
            Self::FilesystemRead => Spec {
                label: "读取文件",
                description: "读取本机文件信息（图标、所在位置）、导入音频文件，并可接收拖入的文件路径",
                effect: E::Read,
                scope: S::Device,
                reversible: true,
                enforcement: F::Host,
                risk_override: None,
            },
            Self::FilesystemWrite => Spec {
                label: "写入文件",
                description: "修改或删除本机文件",
                effect: E::Write,
                scope: S::Device,
                // 删除与覆盖不可撤销，这是它比"读取文件"高一级的唯一依据
                reversible: false,
                enforcement: F::None,
                risk_override: None,
            },
            Self::FilesystemScoped => Spec {
                label: "限定目录访问",
                description: "仅在用户授权的目录内读写文件",
                effect: E::Write,
                scope: S::Device,
                // 限定在授权目录内，用户可撤销授权，因此可逆
                reversible: true,
                enforcement: F::None,
                risk_override: None,
            },
            Self::PluginCommunicate => Spec {
                label: "插件间通信",
                description: "与其他插件交换数据、调用其命令",
                effect: E::Network,
                scope: S::App,
                reversible: true,
                enforcement: F::Frontend,
                // 全表唯一的覆盖项：公式缺一个"混淆代理"轴，见下
                risk_override: Some(RiskOverride {
                    risk: PermissionRisk::Medium,
                    reason: "可构成混淆代理：没有文件权限的插件能借有文件权限的插件代为操作，从而绕过权限模型",
                }),
            },
            Self::NativeModule => Spec {
                label: "原生模块",
                description: "调用原生代码，可绕过沙箱限制",
                effect: E::Execute,
                scope: S::System,
                reversible: false,
                enforcement: F::None,
                risk_override: None,
            },
            Self::DevTools => Spec {
                label: "开发者工具",
                description: "访问开发者工具与调试接口",
                effect: E::Execute,
                scope: S::System,
                reversible: false,
                enforcement: F::None,
                risk_override: None,
            },
            Self::ProcessSpawn => Spec {
                label: "启动外部程序",
                description: "运行本机上的任意程序，权限等同于你自己的用户账户",
                effect: E::Execute,
                scope: S::System,
                reversible: false,
                enforcement: F::Host,
                risk_override: None,
            },
        }
    }

    /// 完整的权限描述（含推导出的风险等级）
    pub fn descriptor(self) -> PermissionDescriptor {
        let spec = self.spec();
        let (risk, risk_reason) = match spec.risk_override {
            Some(over) => (over.risk, Some(over.reason)),
            None => (
                derive_risk(spec.effect, spec.scope, spec.reversible),
                None,
            ),
        };

        PermissionDescriptor {
            id: self.as_str(),
            label: spec.label,
            description: spec.description,
            effect: spec.effect,
            scope: spec.scope,
            reversible: spec.reversible,
            enforcement: spec.enforcement,
            risk,
            risk_reason,
        }
    }

    /// 全部权限的描述，按枚举声明顺序
    pub fn all_descriptors() -> Vec<PermissionDescriptor> {
        Self::ALL.iter().map(|p| p.descriptor()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionEffect as E;
    use PermissionEnforcement as F;
    use PermissionRisk as R;
    use PermissionScope as S;

    /// 元数据快照：id、效果、作用域、可逆性、等级、强制程度。
    ///
    /// 任何改动 —— 改推导公式、改某项属性、新增权限、改变强制程度 —— 都会让这个
    /// 测试失败，从而强制人工确认。**自动化不等于无人监督**：这里锁定的是
    /// "风险等级会随属性变化而自动更新"，而不是"风险等级不会变"。
    const EXPECTED: &[(&str, E, S, bool, R, F)] = &[
        ("storage", E::None, S::Plugin, true, R::Low, F::Host),
        ("network", E::Network, S::App, true, R::Low, F::Host),
        (
            "network-external",
            E::Network,
            S::Remote,
            true,
            R::Medium,
            F::Host,
        ),
        ("notification", E::Write, S::App, true, R::Low, F::Frontend),
        ("clipboard", E::Write, S::Device, true, R::Medium, F::None),
        (
            "filesystem-read",
            E::Read,
            S::Device,
            true,
            R::Medium,
            F::Host,
        ),
        (
            "filesystem-write",
            E::Write,
            S::Device,
            false,
            R::High,
            F::None,
        ),
        (
            "filesystem-scoped",
            E::Write,
            S::Device,
            true,
            R::Medium,
            F::None,
        ),
        (
            "plugin-communicate",
            E::Network,
            S::App,
            true,
            R::Medium,
            F::Frontend,
        ),
        ("native-module", E::Execute, S::System, false, R::High, F::None),
        ("dev-tools", E::Execute, S::System, false, R::High, F::None),
        (
            "process-spawn",
            E::Execute,
            S::System,
            false,
            R::High,
            F::Host,
        ),
    ];

    #[test]
    fn metadata_snapshot_is_locked() {
        let actual: Vec<(&str, E, S, bool, R, F)> = PluginPermission::ALL
            .iter()
            .map(|p| {
                let d = p.descriptor();
                (d.id, d.effect, d.scope, d.reversible, d.risk, d.enforcement)
            })
            .collect();

        assert_eq!(
            actual,
            EXPECTED.to_vec(),
            "权限元数据发生变化。若这是有意的，请同步更新 docs/02-开发指南/插件开发/清单文件参考.md 第 4 节与 src/services/permissionRegistry.ts"
        );
    }

    #[test]
    fn every_permission_is_described() {
        for permission in PluginPermission::ALL {
            let d = permission.descriptor();
            assert_eq!(d.id, permission.as_str(), "描述里的 id 与枚举名不一致");
            assert!(!d.label.trim().is_empty(), "{} 缺少标签", d.id);
            assert!(!d.description.trim().is_empty(), "{} 缺少描述", d.id);
            assert_ne!(
                d.label.trim(),
                d.id,
                "{} 的标签退化成了原始标识符，说明元数据漏填",
                d.id
            );
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for permission in PluginPermission::ALL {
            assert!(
                seen.insert(permission.as_str()),
                "权限标识符重复：{}",
                permission.as_str()
            );
        }
        assert_eq!(seen.len(), PluginPermission::ALL.len());
    }

    /// 推导公式本身的行为，与 12 项权限的具体取值无关。
    ///
    /// 这一层测试不可省：只测快照的话，公式可以在 12 项权限恰好覆盖不到的地方
    /// 出错，而快照依然全绿。
    #[test]
    fn derive_risk_follows_documented_precedence() {
        // 系统作用域优先于一切
        assert_eq!(derive_risk(E::None, S::System, true), R::High);
        // 执行能力即便只作用于应用内也是 high
        assert_eq!(derive_risk(E::Execute, S::App, true), R::High);
        // 不可逆的写入在设备层面是 high
        assert_eq!(derive_risk(E::Write, S::Device, false), R::High);
        // 但同样的不可逆写入若只作用于插件自己的数据，不该被升级
        assert_eq!(derive_risk(E::Write, S::Plugin, false), R::Low);
        // 可逆的写入在设备层面只是 medium
        assert_eq!(derive_risk(E::Write, S::Device, true), R::Medium);
        // 只读设备资源
        assert_eq!(derive_risk(E::Read, S::Device, true), R::Medium);
        // 远端
        assert_eq!(derive_risk(E::Network, S::Remote, true), R::Medium);
        // 应用内与本机回环
        assert_eq!(derive_risk(E::Network, S::App, true), R::Low);
        assert_eq!(derive_risk(E::None, S::Plugin, true), R::Low);
    }

    #[test]
    fn overrides_carry_a_reason() {
        for permission in PluginPermission::ALL {
            let d = permission.descriptor();
            if let Some(reason) = d.risk_reason {
                assert!(
                    !reason.trim().is_empty(),
                    "{} 的风险覆盖没有写明理由",
                    d.id
                );
            }
        }
    }

    #[test]
    fn only_plugin_communicate_is_overridden() {
        let overridden: Vec<&str> = PluginPermission::ALL
            .iter()
            .map(|p| p.descriptor())
            .filter(|d| d.risk_reason.is_some())
            .map(|d| d.id)
            .collect();

        assert_eq!(
            overridden,
            vec!["plugin-communicate"],
            "覆盖项集合发生变化。覆盖是公式覆盖不到时的逃生口，应当少而明确"
        );
    }

    /// 覆盖数量是"公式是否够用"的体检指标。
    ///
    /// 本测试不是禁止新增覆盖，而是要求它在越过阈值时**被看见**：一旦覆盖持续
    /// 增多，说明轴选错了，应当修公式而不是继续加覆盖。阈值故意留了余量，免得
    /// 正常的个别情况也要改测试。
    #[test]
    fn override_count_stays_small() {
        let count = PluginPermission::ALL
            .iter()
            .filter(|p| p.descriptor().risk_reason.is_some())
            .count();

        assert!(
            count <= 2,
            "风险覆盖已达 {} 项，公式可能已不足：应当考虑增加推导轴，而不是继续加覆盖",
            count
        );
    }

    /// 强制程度的分组数量锁定。
    ///
    /// 这个数字与 docs/02-开发指南/插件开发/清单文件参考.md 第 4 节"当前是否强制"
    /// 一栏的说明直接对应。实现某项权限的强制后，这里会失败，提醒同步文档。
    #[test]
    fn enforcement_groups_match_documented_counts() {
        let count = |want: F| {
            PluginPermission::ALL
                .iter()
                .filter(|p| p.descriptor().enforcement == want)
                .count()
        };

        assert_eq!(count(F::Host), 5, "后端强制的权限数量变化");
        assert_eq!(count(F::Frontend), 2, "前端强制的权限数量变化");
        assert_eq!(count(F::None), 5, "未强制的权限数量变化");
    }
}
