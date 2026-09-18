// src/components/AppErrorBoundary.tsx
//
// 最后一道防线：应用根级错误边界。
//
// 已有的两层防护与它互补，不能替代：
//   * ModuleRenderer 的 ModuleErrorBoundary —— 只包住「当前打开的模块组件」，
//     能拦住插件界面崩溃；但它拦不到模块之外的东西（Titlebar、Sidebar、
//     SettingsDialog、Context Provider），那里一旦抛错整个应用就会白屏。
//   * pluginRuntime 的加载期错误捕获 —— 只管插件 bundle 执行阶段。
//
// 因此这里再加一层：任何未被上面的边界接住的渲染错误，都会落到这里，
// 显示可读的报错与「重新加载界面」按钮，而不是留下一片空白。
//
// 一个必须诚实说明的局限：React 的错误边界**只捕获渲染/生命周期/构造
// 期间同步抛出的错误**，不捕获事件处理器、setTimeout、Promise 里的错误。
// 那些由 services/globalErrorHandlers.ts 的全局监听兜底。

import React from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  /** 发生错误的组件栈（开发期定位用；生产构建里可能为空） */
  componentStack: string | null;
}

class AppErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ componentStack: errorInfo.componentStack ?? null });
    console.error('[AppErrorBoundary] 未捕获的渲染错误:', error, errorInfo);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleRetry = (): void => {
    // 先尝试就地恢复：清掉错误状态重新渲染子树。
    // 若错误是确定性的（每次都抛），会立刻再次落到这里并显示同一个界面，
    // 此时用户还可以选「重新加载界面」做完整重载。
    this.setState({ error: null, componentStack: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="fixed inset-0 z-100 flex items-center justify-center bg-gray-50 p-6 overflow-y-auto">
        <div className="w-full max-w-lg">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-red-100 flex items-center justify-center">
              <AlertOctagon className="w-5 h-5 text-red-600" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-gray-900">界面发生错误</h1>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                应用的某一部分渲染失败，已被错误边界接住。你的数据与设置不受影响。
                <br />
                若是安装插件后出现的，可在重新加载后从「设置 → 插件」中禁用它。
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-red-200 bg-red-50 p-4 mb-4">
            <p className="text-[11px] font-semibold text-red-700 mb-1">错误信息</p>
            <p className="text-xs text-red-700 font-mono break-all leading-relaxed">
              {error.message || String(error)}
            </p>
            {this.state.componentStack && (
              <details className="mt-3">
                <summary className="text-[11px] text-red-600 cursor-pointer select-none">
                  组件调用栈
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto text-[10px] text-red-700/80 font-mono whitespace-pre-wrap">
                  {this.state.componentStack}
                </pre>
              </details>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={this.handleRetry}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-white border border-gray-200 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              重试渲染
            </button>
            <button
              onClick={this.handleReload}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              重新加载界面
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;
