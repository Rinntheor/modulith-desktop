// src/services/contextMenuBridge.ts
//
// 「在某个坐标弹出外壳右键菜单」的请求通道。
//
// ============================================================
// 为什么需要它（而不是让 SandboxSurface 直接拿 Home 的 state）
// ============================================================
//
// 发起方是 `SandboxSurface`（它持有那块 iframe，也只有它能把插件文档里的坐标
// 换算成宿主坐标），接收方是 `Home`（`menuPos` 是它唯一的事实来源）。
// 两者在 React 树里隔了好几层，而这块界面的挂载点由**标签面板**决定 ——
// 为了一个 `{x, y}` 去穿四五层 prop，会让每一层都多一个只往下递的接口。
//
// 与 `searchFocus.ts` / `sidebarBridge.ts` 同一取向：挂在 window 上的、
// 或者深在树里的东西，用一个导出的事件名 + 一个带类型的包装函数搭桥，
// 而不是让一方持有另一方的 ref 或 context。
//
// ============================================================
// 为什么载荷是 `{x, y}` 而不是"哪个插件"
// ============================================================
//
// 菜单的内容与调用者无关：它是**外壳**的菜单（前进后退、刷新、设置、通知中心、
// 分屏、全屏，加上插件贡献的条目），对所有调用点都一样。把插件 id 传过来只会
// 让接收方误以为它可以按插件改变菜单 —— 那不是这个菜单的语义。
//
// 因此这里**只有坐标**。一个插件在它的界面里右键，与用户在宿主空白处右键，
// 得到的是同一个菜单、同样的位置规则。

/** 事件名。带 `modulith:` 前缀与既有那几个桥接事件同一格式。 */
export const GLOBAL_CONTEXT_MENU_EVENT = 'modulith:global-context-menu';

/**
 * 一次弹出请求的坐标（宿主文档的 CSS 像素，与 `MouseEvent.clientX/Y` 同义）。
 *
 * 页面里那份事件载荷是 `GlobalContextMenuRequest | null`，而 `null` 表示**关掉**。
 * 见 `subscribeGlobalContextMenu` 上"为什么开与关走同一条通道"。
 */
export interface GlobalContextMenuRequest {
  x: number;
  y: number;
}

/**
 * 请求在给定坐标弹出外壳右键菜单。
 *
 * **坐标必须已经是宿主文档的视口坐标。** 插件文档给的是它自己的视口坐标，
 * 调用方负责加上那块 iframe 的矩形偏移（见 `SandboxSurface`）。
 * 这里不做任何换算，也不做钳制 —— 钳制是菜单自己的职责
 * （`GlobalContextMenu` 知道自己的尺寸，这里不知道）。
 *
 * 非有限数一律**丢弃**：一个 `NaN` 会让菜单渲染在 `left: NaN` 上，
 * 表现是"右键之后什么都没出现"，而原因（坐标算错了）在那时已经看不出来。
 */
export function requestGlobalContextMenu(x: number, y: number): void {
  if (typeof window === 'undefined') return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  window.dispatchEvent(
    new CustomEvent<GlobalContextMenuRequest | null>(GLOBAL_CONTEXT_MENU_EVENT, {
      detail: { x, y },
    })
  );
}

/**
 * 请求关掉外壳右键菜单。**菜单没开着时是无操作。**
 *
 * 与 `requestGlobalContextMenu` 走**同一条**事件与同一个订阅者，而不是另开一条
 * "关闭"事件。这不是省事，是这个缺陷的教训：
 *
 * > 菜单的"开"由一条通道负责、"关"由另一条通道负责时，只要有一方漏了或者两边
 * > 判据不一致，结果就是**一个关不掉的菜单** —— 而那正是这一轮用户报的现象
 * > （菜单能弹出来，点空白处却收不回去）。
 *
 * 让"开"与"关"是同一条通道上的两种取值之后，"谁负责关"这个问题在类型上就不存在了：
 * 只有一处会写菜单的位置，而写 `null` 就是关闭。
 */
export function dismissGlobalContextMenu(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<GlobalContextMenuRequest | null>(GLOBAL_CONTEXT_MENU_EVENT, {
      detail: null,
    })
  );
}

/**
 * 订阅菜单的打开 / 关闭请求。返回值用于退订。
 *
 * `listener` 收到 `null` 表示"关掉"。
 *
 * ============================================================
 * 为什么两者是同一个回调，而不是两个订阅
 * ============================================================
 *
 * 打开与关闭是两个**互斥**的状态，而非两件独立的事。分开订阅时，接收方要自己
 * 保证"关"那一支的逻辑与"开"那一支配对（例如关闭时也要清掉别的关联状态），
 * 而漏掉其中一半的表现就是菜单关不掉 —— 一个用户会立刻遇到、但代码评审很难看出
 * 的缺陷。合成一个取值之后，接收方只有一处状态可写，配不配对这件事不会写错。
 *
 * 非有限数与形状不对的载荷一律丢弃，`null` 除外。
 */
export function subscribeGlobalContextMenu(
  listener: (request: GlobalContextMenuRequest | null) => void
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;

    // `null` 是合法载荷：关掉。
    if (detail === null) {
      listener(null);
      return;
    }

    if (!detail || typeof detail !== 'object') return;

    const { x, y } = detail as Partial<GlobalContextMenuRequest>;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    listener({ x, y });
  };

  window.addEventListener(GLOBAL_CONTEXT_MENU_EVENT, handler);
  return () => window.removeEventListener(GLOBAL_CONTEXT_MENU_EVENT, handler);
}
