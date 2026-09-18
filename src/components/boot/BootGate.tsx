// src/components/boot/BootGate.tsx
//
// 启动门禁：应用的最外层。渲染顺序完全由初始化状态机决定——
//
//   初始化中 / 失败  → 启动加载界面（真实进度，失败可重试）
//   等待解锁         → 授权界面（初始化在此处**暂停**，解锁后从断点继续）
//   就绪             → 应用本体
//
// 以前这里是两个各自独立的加载指示器（AuthGate 的 spinner + Home 的 spinner），
// 而且 Home 的初始化如果抛错就会永远停在转圈上。现在只有一个状态机，
// 关键步骤失败会明确报错并可重试。

import React, { useEffect, useState } from 'react';
import BootScreen from '../../features/boot/BootScreen';
import BootChrome from '../../features/boot/BootChrome';
import AuthScreen from '../../features/auth/AuthScreen';
import { bootManager, subscribeBoot, type BootState } from '../../services/boot';

interface BootGateProps {
  children: React.ReactNode;
}

const BootGate: React.FC<BootGateProps> = ({ children }) => {
  const [state, setState] = useState<BootState>(() => bootManager.getState());

  useEffect(() => {
    const unsubscribe = subscribeBoot(() => setState(bootManager.getState()));
    // start() 是幂等的：StrictMode 下重复调用返回同一个 Promise
    void bootManager.start();
    return unsubscribe;
  }, []);

  // 应用本体自带 Titlebar（含拖拽区域与窗口按钮）
  if (state.phase === 'ready') {
    return <>{children}</>;
  }

  // 启动阶段应用本体尚未挂载，必须自己提供窗口边框，
  // 否则窗口无边框（decorations: false）就没有任何可拖动的地方。
  return (
    <>
      <BootChrome />
      {state.phase === 'awaiting-auth' ? <AuthScreen /> : <BootScreen />}
    </>
  );
};

export default BootGate;
