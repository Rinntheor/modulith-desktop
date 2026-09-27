// src/services/fileDrop.ts
//
// 把 Tauri 的**窗口级**文件拖放事件变成一个前端可订阅的服务。
//
// 为什么必须有这一层：Tauri 2 的 `dragDropEnabled` 默认为 true，此时系统拖放
// 被 Tauri 拦截，HTML5 的 `dragover` / `drop` 不会触发；而 `withGlobalTauri`
// 未开启，插件（IIFE、不能用 import）拿不到 `window.__TAURI__`。两者相加的结果
// 是：**插件自己无法接收拖入的文件路径**，只能由宿主代收再转发。
//
// 这里刻意做成「宿主订阅一次、向多个订阅者扇出」，理由有两条：
//   1. 每个订阅者各自调用 `onDragDropEvent` 会让同一次拖放触发多轮回调；
//   2. Tauri 的事件监听是异步建立的，集中在一处更容易发现失败并如实上报。

import { getCurrentWebview } from '@tauri-apps/api/webview';

export interface FileDropEvent {
  type: 'enter' | 'over' | 'drop' | 'leave';
  /** 拖入的文件或目录的绝对路径；非 `drop` 阶段可能是空数组 */
  paths: string[];
  /**
   * 指针位置，**物理像素**、相对窗口客户区左上角。
   *
   * `leave` 没有这一项（拖放已经离开窗口了）。
   *
   * 它为什么在这里：沙箱插件界面是宿主页面里的一块 iframe，而拖放是**窗口级**
   * 事件 —— 宿主必须自己判断"指针底下是哪一块界面"，才能只把它转给那一块。
   * 少了这个坐标就只能广播，而广播会让后台标签页里的插件也收到本该属于别人的
   * 拖放。见 `SandboxSurface.tsx`。
   */
  position?: { x: number; y: number };
}

type Handler = (event: FileDropEvent) => void;

const handlers = new Set<Handler>();

/** 监听已经建立过就不再重复建立 —— 窗口的拖放只有一份 */
let started = false;
/** 建立监听时的失败原因；非 null 表示拖放不可用 */
let startError: string | null = null;

function normalize(payload: unknown): FileDropEvent {
  const raw = (payload ?? {}) as {
    type?: string;
    paths?: string[];
    position?: { x?: number; y?: number };
  };
  const type = (raw.type ?? 'over') as FileDropEvent['type'];

  // 位置只在两个分量都是有限数时才带上。Tauri 在 `leave` 上不给位置，某些版本
  // 也可能给一个 `{x: null, y: null}` —— 那种值传给命中测试会算出 NaN，
  // 而 NaN 的比较**永远为假**，症状是"拖放静默失效"。
  const position =
    raw.position &&
    typeof raw.position.x === 'number' &&
    typeof raw.position.y === 'number' &&
    Number.isFinite(raw.position.x) &&
    Number.isFinite(raw.position.y)
      ? { x: raw.position.x, y: raw.position.y }
      : undefined;

  return {
    type,
    paths: Array.isArray(raw.paths) ? raw.paths : [],
    ...(position ? { position } : {}),
  };
}

/**
 * 订阅文件拖放。返回取消订阅函数。
 *
 * 订阅者抛出的异常会被逐个隔离：一个插件出错不应该让其它订阅者收不到事件。
 */
export function subscribeFileDrop(handler: Handler): () => void {
  handlers.add(handler);

  if (!started) {
    started = true;
    // 监听随窗口存在而存在，应用生命周期内不解除，因此这里不保留 unlisten。
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const normalized = normalize(event.payload);
        for (const current of Array.from(handlers)) {
          try {
            current(normalized);
          } catch (e) {
            console.error('[fileDrop] 订阅者抛出异常，已隔离:', e);
          }
        }
      })
      .catch((e) => {
        startError = String(e);
        console.error('[fileDrop] 无法监听拖放事件，文件拖入将不可用:', e);
      });
  }

  return () => {
    handlers.delete(handler);
  };
}

/**
 * 拖放当前是否可用。
 *
 * 建立监听是异步的，因此在 `.catch` 落地之前这里会返回 true —— 这个窗口期里
 * 订阅仍然能注册成功，只是事件要等监听就绪后才会到达，不影响正确性。
 */
export function isFileDropAvailable(): boolean {
  return startError === null;
}
