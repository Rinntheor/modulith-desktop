// src/services/globalErrorHandlers.ts
//
// 全局错误兜底。
//
// 为什么需要它 —— React 错误边界有明确的盲区：
// 它只捕获**渲染、生命周期、构造函数**里同步抛出的错误。
// 下面这些统统漏在边界之外，而它们恰好是插件最容易踩的地方：
//
//   * 事件处理器里的同步抛错（插件按钮的 onClick 里抛错）
//   * setTimeout / setInterval 回调
//   * 未被 await 的 Promise（unhandledrejection）
//   * 非 React 代码里的运行时错误（window.onerror）
//
// 这里不试图「修复」任何东西 —— 那不可能。目标只有两个：
//   1. 让这类错误留下可查的记录，而不是悄悄消失在控制台深处；
//   2. 把它们标记为「可诊断」，方便用户/开发者判断是否由插件引起。
//
// 注意：这个模块**不弹窗、不阻塞界面**。事件处理器里的错误不该让整个
// 应用弹出一个错误页 —— 那比错误本身更糟糕。

/** 判定一条错误是否可能来自插件（用于日志标注与用户提示） */
function guessPluginOrigin(stack: string | undefined): string | null {
  if (!stack) return null;
  // 插件 bundle 是通过 <script data-plugin-id="..."> 注入的，
  // 其堆栈里通常带不上该属性；但注入的 sourceURL 与宿主 chunk 路径差异明显。
  const match = stack.match(/plugin[:\-]([a-zA-Z0-9._-]+)/i);
  return match ? match[1] : null;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 安装全局监听。返回卸载函数。
 *
 * 幂等：重复调用不会重复注册（应用重载或 HMR 时可能被调用多次）。
 */
let installed = false;
let uninstall: (() => void) | null = null;

export function installGlobalErrorHandlers(): () => void {
  if (installed && uninstall) return uninstall;
  installed = true;

  const onError = (event: ErrorEvent) => {
    const pluginId = guessPluginOrigin(event.error?.stack);
    console.error(
      `[global] 未捕获的运行时错误${pluginId ? `（疑似来自插件 ${pluginId}）` : ''}:`,
      event.error ?? event.message
    );
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const error = event.reason;
    const pluginId = guessPluginOrigin(error instanceof Error ? error.stack : undefined);
    console.error(
      `[global] 未处理的 Promise 拒绝${pluginId ? `（疑似来自插件 ${pluginId}）` : ''}:`,
      describe(error)
    );
    // 刻意**不**调用 event.preventDefault()：
    // 那样会抑制浏览器/WebView 自带的原始报错（含可展开的堆栈与源码定位），
    // 而那份输出对排查插件问题比这里的单行日志有用得多。
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  uninstall = () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    installed = false;
    uninstall = null;
  };

  return uninstall;
}
