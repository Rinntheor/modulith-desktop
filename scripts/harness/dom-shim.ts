// scripts/harness/dom-shim.ts
//
// 一套**够用的**浏览器环境垫片，用来在 Node 里孵化真实的 `pluginRuntime`。
//
// 为什么是手写而不是 jsdom：本项目的依赖里没有 jsdom / happy-dom，
// 而夹具的价值恰恰在于它能在一个**没有任何网络与安装动作**的环境里跑起来。
// 手写的代价要如实说清楚：**它测的是「运行时在这套垫片上的行为」，不是「在真实
// 浏览器里的行为」。** 因此垫片只实现被真正用到的那部分 API，并且刻意照着浏览器的
// 语义实现（见 executeScript 里那条 error 事件的说明）—— 语义走样比 API 缺失更危险，
// 因为前者会让人对测试结果产生错误信心。
//
// 这里是整套夹具的关键：**`<script>` 的 textContent 会被真正执行**，
// 因此「插件代码到底跑没跑」是可以被断言的，而不是靠读代码推断。

import vm from 'node:vm';

type AnyFn = (...args: unknown[]) => void;

export interface ExecutedScript {
  pluginId: string;
  bytes: number;
}

export interface DomShim {
  window: Record<string, unknown>;
  document: Record<string, unknown>;
  /** 按顺序记录每一次被执行的插件 bundle —— 用来断言「未激活时一行代码都没跑」 */
  executedScripts: ExecutedScript[];
  /** 注入到文档的 `<style>` 文本（按注入顺序） */
  injectedStyles: string[];
  /** 注册在 window 上的 error 监听器收到的异常（浏览器语义，见 executeScript） */
  windowErrors: unknown[];
  /** 清空观测记录（不动 DOM 本身） */
  resetObservations(): void;
}

function createEventTarget(): {
  addEventListener: AnyFn;
  removeEventListener: AnyFn;
  dispatch: (type: string, event: unknown) => void;
} {
  const listeners = new Map<string, Set<AnyFn>>();

  return {
    addEventListener: ((type: string, fn: AnyFn) => {
      if (typeof fn !== 'function') return;
      const set = listeners.get(type) ?? new Set<AnyFn>();
      set.add(fn);
      listeners.set(type, set);
    }) as unknown as AnyFn,

    removeEventListener: ((type: string, fn: AnyFn) => {
      listeners.get(type)?.delete(fn);
    }) as unknown as AnyFn,

    dispatch(type: string, event: unknown) {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        try {
          fn(event);
        } catch (error) {
          console.error(`[dom-shim] "${type}" 监听器自身抛错:`, error);
        }
      }
    },
  };
}

export function installDomShim(): DomShim {
  const executedScripts: ExecutedScript[] = [];
  const injectedStyles: string[] = [];
  const windowErrors: unknown[] = [];

  const windowTarget = createEventTarget();
  const documentTarget = createEventTarget();

  const createStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() {
        return map.size;
      },
    };
  };

  /**
   * 元素工厂。只实现被用到的那部分。
   *
   * `appendChild` 对 SCRIPT 会真的执行 textContent —— 见文件头的说明。
   */
  const createElement = (tagName: string) => {
    const tag = String(tagName).toUpperCase();
    const element: Record<string, unknown> = {
      tagName: tag,
      nodeName: tag,
      dataset: {} as Record<string, string>,
      style: {},
      textContent: '',
      innerHTML: '',
      children: [] as unknown[],
      parentNode: null,
      isConnected: false,
      classList: {
        add: () => {},
        remove: () => {},
        toggle: () => {},
        contains: () => false,
      },
      setAttribute(name: string, value: unknown) {
        (element as Record<string, unknown>)[name] = value;
      },
      getAttribute: (name: string) => (element as Record<string, unknown>)[name] ?? null,
      removeAttribute: () => {},
      appendChild(child: Record<string, unknown>) {
        child.parentNode = element;
        child.isConnected = true;
        (element.children as unknown[]).push(child);

        // 判据取的是**被追加的子元素**的标签，不是宿主元素的 ——
        // 插件脚本被追加到 head 上，而 head 自己当然不是 SCRIPT。
        const childTag = String(child.tagName ?? '').toUpperCase();
        if (childTag === 'SCRIPT') {
          executeScript(child as { textContent: string; dataset: Record<string, string> });
        } else if (childTag === 'STYLE') {
          injectedStyles.push(String(child.textContent ?? ''));
        }
        return child;
      },
      removeChild(child: Record<string, unknown>) {
        const index = (element.children as unknown[]).indexOf(child);
        if (index !== -1) (element.children as unknown[]).splice(index, 1);
        child.parentNode = null;
        child.isConnected = false;
        return child;
      },
      remove() {
        const parent = element.parentNode as Record<string, unknown> | null;
        parent?.removeChild?.(element);
        element.isConnected = false;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => false,
      closest: () => null,
      focus: () => {},
      blur: () => {},
      click: () => {},
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    };
    return element;
  };

  const head = createElement('head');
  const body = createElement('body');

  const document = {
    ...documentTarget,
    createElement,
    createElementNS: (_ns: string, tag: string) => createElement(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    createDocumentFragment: () => createElement('fragment'),
    head,
    body,
    documentElement: createElement('html'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    title: '',
    visibilityState: 'visible',
    hidden: false,
  } as unknown as Record<string, unknown>;

  const window = {
    ...windowTarget,
    document,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    matchMedia: () => ({
      matches: false,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (cb: (time: number) => void) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    setTimeout,
    clearTimeout,
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:' },
    history: { back: () => {}, forward: () => {}, pushState: () => {} },
    // 未实现但会被探测的观察者：给出空实现而不是 undefined，
    // 因为插件（与夹具）会用它们来制造"需要收尾的资源"
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    // Tauri v2 的 invoke 从这里取
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        throw new Error(`[dom-shim] 未打桩的后端命令：${command}`);
      },
      transformCallback: (cb: unknown) => cb,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    },
  } as unknown as Record<string, unknown>;

  /**
   * 执行一段插件 bundle。
   *
   * **这里必须照抄浏览器的一条语义：`<script>` 里的异常不会从 `appendChild` 抛出，
   * 而是走 `window` 的 error 事件。** 插件运行时正是靠这条路径把"插件坏了"反映到
   * 界面上的（它在注入前挂了 error 监听）。若垫片让异常直接从 appendChild 冒出来，
   * 那条路径就永远测不到，而这恰恰是它存在的唯一理由。
   */
  function executeScript(script: { textContent: string; dataset: Record<string, string> }): void {
    const code = String(script.textContent ?? '');
    const pluginId = script.dataset.pluginId ?? 'unknown';
    executedScripts.push({ pluginId, bytes: code.length });

    try {
      // runInThisContext：与浏览器一样的全局作用域，因此 fixture 里的
      // `window.Modulith.registerModule(...)` 能解析到宿主注入的那个对象
      vm.runInThisContext(code, { filename: `plugin-bundle:${pluginId}` });
    } catch (error) {
      windowErrors.push(error);
      windowTarget.dispatch('error', {
        type: 'error',
        error,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const global = globalThis as unknown as Record<string, unknown>;
  global.window = window;
  global.document = document;
  // globalThis.navigator 在 Node 24 里是只读的 getter，不能也不需要覆盖
  global.localStorage = window.localStorage;
  global.sessionStorage = window.sessionStorage;
  global.requestAnimationFrame = window.requestAnimationFrame;
  global.cancelAnimationFrame = window.cancelAnimationFrame;
  global.matchMedia = window.matchMedia;
  global.getComputedStyle = window.getComputedStyle;
  global.MutationObserver = window.MutationObserver;
  global.ResizeObserver = window.ResizeObserver;
  global.IntersectionObserver = window.IntersectionObserver;

  return {
    window,
    document,
    executedScripts,
    injectedStyles,
    windowErrors,
    resetObservations() {
      executedScripts.length = 0;
      injectedStyles.length = 0;
      windowErrors.length = 0;
    },
  };
}
