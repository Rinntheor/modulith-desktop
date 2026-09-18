// src/router/Router.tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import DynamicRouter from './dynamicRouter';
import ModuleRenderer from '../components/ModuleRenderer';
import Home from '../pages/Home';

/**
 * 动态路由配置
 * 根据模块注册表自动生成路由
 */
function Router() {
  // 获取动态生成的路由
  const routes = DynamicRouter.getRoutes();

  return (
    <BrowserRouter>
      <Routes>
        {/* 默认首页 */}
        <Route path="/" element={<Navigate to="/home" replace />} />
        
        {/* 首页路由 */}
        <Route path="/home" element={<Home />} />
        
        {/* 动态模块路由 */}
        {routes.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<ModuleRenderer moduleId={route.meta?.moduleId || ''} />}
          />
        ))}
        
        {/* 404 路由 */}
        <Route
          path="*"
          element={
            <div className="flex flex-col items-center justify-center min-h-[60vh]">
              <h1 className="text-4xl font-bold text-gray-900 mb-4">404</h1>
              <p className="text-gray-500 mb-6">Page not found</p>
              <button
                onClick={() => window.history.back()}
                className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors"
              >
                Go Back
              </button>
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default Router;
