// src/services/pluginSettingsFocus.ts
//
// 一个极小的**一次性意图**通道：从任意位置请求"打开设置并定位到某个插件的设置"。
//
// ============================================================
// 为什么需要它
// ============================================================
//
// 插件详情抽屉（插件模块里）与设置对话框（外壳里）之间**没有共同祖先**，而
// 「抽屉里的设置按钮」恰恰是最自然的入口 —— 尤其对**无界面插件**：它没有侧边栏
// 项、没有标签页，"设置 → 插件设置"是它唯一露脸的地方，而"插件列表"是用户找到
// 它的地方。用户是在哪里找到这个插件的，就该在同一个地方找到它的设置。
//
// ============================================================
// 为什么是"意图"而不是"共享状态"
// ============================================================
//
// 共享状态（一个 `focusedPluginId` 变量）会让对话框**每次打开**都定位到上次那个
// 插件 —— 用户从标题栏齿轮进来时会莫名其妙地落在某个插件的设置页上，而那不是
// 他刚才做的事。
//
// 因此这里的值**取走即清空**：它表达的是一次"请带我去那里"，不是一个"当前选中项"。
//
// 而"打开对话框"那一半需要**粘住**：外壳要先打开对话框，插件设置页才有机会消费
// 那个焦点。两者因此是两个独立信号 —— 打开那一半是可反复触发的通知，
// 焦点那一半是一次性的值。

/** 一次"带我去某个插件的设置"的请求 */
export interface PluginSettingsFocus {
  pluginId: string;
}

let pending: PluginSettingsFocus | null = null;

const openListeners = new Set<() => void>();

/**
 * 请求：打开设置到「插件设置」分页，并定位到 `pluginId`。
 *
 * 通知**先发**、值**后取**：外壳收到通知去打开对话框（一次 React 状态更新），
 * 插件设置页在它自己的 effect 里取走焦点。反过来的话，外壳会在值已被取走之后
 * 才去打开，于是对话框开了、却没定位。
 */
export function requestPluginSettings(pluginId: string): void {
  if (!pluginId) return;

  pending = { pluginId };
  for (const listener of [...openListeners]) listener();
}

/**
 * 取走焦点。**取走即清空** —— 同一个意图不会作用于第二次打开。
 *
 * 返回 `null` 表示这次打开不是"带我去某个插件"，按普通入口对待。
 */
export function consumePluginSettingsFocus(): string | null {
  const value = pending;
  pending = null;
  return value ? value.pluginId : null;
}

/** 订阅"有人请求打开插件设置"。外壳用它来打开对话框。 */
export function subscribePluginSettingsRequest(listener: () => void): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}
