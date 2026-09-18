// src/services/permissionRegistry.ts
// 插件权限元数据的本地缓存
//
// 权限的**定义**在宿主（Rust `modules/plugins/permissions.rs`），不在前端。
// 这个模块只做一件事：把宿主的注册表取回来，供界面同步查询。
//
// 为什么不在前端维护一份表：
//
//   曾经这里有一份手写的 `PERMISSION_INFO`（标签、描述、风险等级）。它与 Rust
//   的 `PluginPermission` 枚举是两份独立维护的清单，新增权限要改两处，漏掉任何
//   一处都不报错 —— 界面只会安静地展示一个没有依据的风险等级。
//
//   更关键的是风险等级属于**安全信息**：它必须由宿主推导，且同一权限在"已安装
//   插件"与"市场里待安装的插件"两处必须显示一致。若它来自前端常量或远程索引，
//   一个被篡改的索引就能把 `process-spawn` 标成低风险。

import { invoke } from '@tauri-apps/api/core';

/** 风险等级。与 Rust `PermissionRisk` 的序列化一致。 */
export type PermissionRisk = 'low' | 'medium' | 'high';

/** 权限对目标做了什么 */
export type PermissionEffect = 'none' | 'read' | 'write' | 'network' | 'execute';

/** 权限影响到哪里 */
export type PermissionScope = 'plugin' | 'app' | 'device' | 'remote' | 'system';

/** 宿主对该权限的实际强制程度 */
export type PermissionEnforcement = 'host' | 'frontend' | 'none';

/**
 * 宿主提供的权限描述。字段与 Rust `PermissionDescriptor` 一一对应。
 *
 * `effect` / `scope` / `reversible` 也在其中，而不是只给一个等级：界面可以把它们
 * 作为解释"为什么是这个等级"的依据，而不必把推导规则再抄一遍到前端 —— 抄一遍
 * 就等于又多了一处会漂移的副本。
 */
export interface PermissionDescriptor {
  id: string;
  label: string;
  description: string;
  effect: PermissionEffect;
  scope: PermissionScope;
  reversible: boolean;
  enforcement: PermissionEnforcement;
  /** 最终等级（宿主推导或覆盖的结果） */
  risk: PermissionRisk;
  /** 覆盖理由；`null` 表示由宿主的推导公式得出 */
  riskReason: string | null;
}

const registry = new Map<string, PermissionDescriptor>();

/**
 * 取回宿主的权限注册表。幂等，重复调用只是覆盖同一份数据。
 *
 * **失败不抛出。** 权限元数据取不到不该让整个插件运行时加载失败 —— 那会把一个
 * "标签显示不完整"的问题升级成"插件全部不可用"。失败时也不清空已有的注册表，
 * 于是沿用上一次成功的结果；若从未成功过，注册表为空，查询走失败安全分支
 * （见 `getPermissionDescriptor`）。
 *
 * 这里不需要额外的"是否已加载"布尔量：注册表为空与未加载是同一个状态。
 */
export async function loadPermissionRegistry(): Promise<void> {
  try {
    const list = await invoke<PermissionDescriptor[]>('list_plugin_permissions');
    registry.clear();
    for (const item of list) {
      registry.set(item.id, item);
    }
  } catch (err) {
    console.warn('[permissions] 拉取权限元数据失败，未知权限将按最高等级处理', err);
  }
}

/**
 * 查询单项权限的描述。
 *
 * 未知权限一律按 **high** 处理。理由：未知标识符既可能是拼写错误，也可能来自
 * 更新版宿主的、当前宿主尚未理解的权限。两种情况下都不应该给出"低风险"这一
 * 安慰性判断 —— 失败方向必须是保守的。
 *
 * 注意这与 Rust 侧的行为不同：Rust 会**拒绝安装**含未知权限的清单，因此这个
 * 分支主要服务于市场页（展示尚未安装的插件，其索引可能来自更新的宿主）。
 */
export function getPermissionDescriptor(id: string): PermissionDescriptor {
  const found = registry.get(id);
  if (found) return found;

  return {
    id,
    label: id,
    description: '宿主未提供该权限的元数据',
    // 与 high 保持一致：作用域按最广、后果按不可撤销描述
    effect: 'none',
    scope: 'system',
    reversible: false,
    enforcement: 'none',
    risk: 'high',
    riskReason: '未知权限一律按最高等级处理：它既可能是拼写错误，也可能来自更新版宿主',
  };
}
