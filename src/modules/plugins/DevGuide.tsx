// src/modules/plugins/DevGuide.tsx
// 「插件开发指南」弹窗：说明 .lcp 包结构、清单格式与 bundle 约定

import React, { memo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, Package, FileJson, FileCode, FolderTree } from 'lucide-react';

interface DevGuideProps {
  open: boolean;
  onClose: () => void;
}

const MANIFEST_EXAMPLE = `{
  "name": "com.example.notes",
  "displayName": "速记",
  "version": "1.0.0",
  "description": "一个最简的 Modulith 插件示例",
  "author": { "name": "你的名字", "email": "you@example.com" },
  "license": "MIT",
  "homepage": "https://example.com/notes",
  "categories": ["productivity"],
  "keywords": ["notes", "markdown"],
  "engines": { "loopcore": ">=1.0.0" },
  "main": "dist/index.js",
  "style": "dist/index.css",
  "icon": "FileText",
  "permissions": ["storage"],
  "sandboxLevel": 1
}`;

const BUNDLE_EXAMPLE = `// dist/index.js —— 由打包器输出为 IIFE，react 等必须是 external
(function () {
  var React = window.Modulith.React;
  var registerModule = window.Modulith.registerModule;
  var ctx = window.Modulith.createContext();   // 绑定到当前插件

  function Notes() {
    var s = React.useState('');
    var text = s[0], setText = s[1];

    React.useEffect(function () {
      ctx.storage.get('draft').then(function (v) { if (v) setText(v); });
    }, []);

    return React.createElement(
      'div',
      { style: { padding: 24 } },
      React.createElement('h1', null, '速记'),
      React.createElement('textarea', {
        value: text,
        onChange: function (e) {
          setText(e.target.value);
          ctx.storage.set('draft', e.target.value);
        },
      })
    );
  }

  registerModule({
    id: 'notes',
    name: '速记',
    description: '本地草稿',
    icon: 'FileText',
    priority: 30,
    component: Notes,
  });
})();`;

const VITE_SNIPPET = `// vite.config.ts（插件项目）
export default {
  build: {
    lib: { entry: 'src/index.tsx', formats: ['iife'], name: 'ModulithPlugin', fileName: () => 'index.js' },
    rollupOptions: {
      // 插件不打包 React，改用宿主注入的实例
      external: ['react', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'Modulith.React',
          // jsx / jsxs / Fragment 直接挂在 Modulith 上，因此映射到 Modulith 本身
          'react/jsx-runtime': 'Modulith',
        },
      },
    },
  },
};`;

const CodeBlock: React.FC<{ title: string; code: string; icon: React.ComponentType<{ className?: string }> }> = ({
  title,
  code,
  icon: Icon,
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
        <span className="flex items-center gap-2 text-xs font-medium text-gray-600">
          <Icon className="w-3.5 h-3.5" />
          {title}
        </span>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => setCopied(false)
            );
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1 px-2 py-1 text-[11px] rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="text-[11px] leading-relaxed text-gray-700 bg-white p-3 overflow-x-auto max-h-72 overflow-y-auto custom-scrollbar">
        {code}
      </pre>
    </div>
  );
};

const DevGuide: React.FC<DevGuideProps> = memo(({ open, onClose }) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          className="fixed inset-0 bg-gray-900/40 backdrop-blur-[2px] z-50"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 10 }}
          transition={{ type: 'spring', stiffness: 400, damping: 36 }}
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-3xl max-h-[86vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-linear-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                <Package className="w-4 h-4 text-white" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">插件开发指南</h2>
                <p className="text-xs text-gray-500">Modulith 的模块就是插件，按需扩展</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar">
            <section>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-2">
                <FolderTree className="w-4 h-4 text-gray-400" />
                插件包结构（.lcp 就是一个 zip）
              </h3>
              <pre className="text-[11px] leading-relaxed text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-3">
{`my-plugin.lcp
├── manifest.json        清单（必需）
├── dist/
│   ├── index.js         预构建的 IIFE bundle（必需）
│   └── index.css        可选样式
├── icon.svg             可选图标
└── README.md            可选，会显示在插件详情里`}
              </pre>
            </section>

            <section className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                <FileJson className="w-4 h-4 text-gray-400" />
                manifest.json
              </h3>
              <CodeBlock title="manifest.json" code={MANIFEST_EXAMPLE} icon={FileJson} />
              <p className="text-xs text-gray-500 leading-relaxed">
                只有 <code className="font-mono">name</code> 与{' '}
                <code className="font-mono">version</code> 是必填的；
                <code className="font-mono">displayName</code> 缺省时用 name，
                <code className="font-mono">main</code> 缺省为{' '}
                <code className="font-mono">dist/index.js</code>。
                <code className="font-mono">name</code> 需匹配{' '}
                <code className="font-mono">^[a-zA-Z0-9][a-zA-Z0-9._-]{'{0,63}'}$</code>。
                <code className="font-mono">engines.loopcore</code> 用于声明兼容的 Modulith
                版本范围。建议使用只带下界的写法（如{' '}
                <code className="font-mono">&gt;=1.0.0</code>）；范围语法非法会被拒绝安装，
                但语法正确而版本不匹配只会显示一条提示，不影响安装与加载。
              </p>
            </section>

            <section className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                <FileCode className="w-4 h-4 text-gray-400" />
                插件 bundle
              </h3>
              <p className="text-xs text-gray-500 leading-relaxed">
                加载插件前，宿主会注入 <code className="font-mono">window.Modulith</code>：
                包含 <code className="font-mono">React</code>、
                <code className="font-mono">jsx/jsxs/Fragment</code>、
                <code className="font-mono">registerModule()</code>、
                <code className="font-mono">createContext()</code>。
                插件必须与宿主共用同一份 React，因此{' '}
                <code className="font-mono">react</code> 与{' '}
                <code className="font-mono">react/jsx-runtime</code> 必须打成 external。
                插件不需要 <code className="font-mono">react-dom</code>：由宿主负责挂载，
                插件只需通过 <code className="font-mono">registerModule()</code> 交出组件。
              </p>
              <CodeBlock title="dist/index.js" code={BUNDLE_EXAMPLE} icon={FileCode} />
              <CodeBlock title="vite.config.ts（打包插件时）" code={VITE_SNIPPET} icon={FileCode} />
            </section>

            <section>
              <h3 className="text-sm font-semibold text-gray-800 mb-2">运行时 API</h3>
              <div className="rounded-xl border border-gray-100 overflow-hidden">
                {[
                  ['ctx.storage.get/set/delete/keys/all', '插件独立的键值存储，落盘在应用数据目录'],
                  ['ctx.http.get/post/put/delete/fetch', '需要 network 权限；访问外部域名还需要 network-external'],
                  ['ctx.notifications.info/warn/error/success', '应用内通知：右下角浮层 + 通知中心的未读记录，需要 notification 权限'],
                  ['ctx.events.publish/subscribe', '跨模块事件总线，需要 plugin-communicate 权限'],
                  ['ctx.logger.debug/info/warn/error', '带插件前缀的日志'],
                  ['ctx.manifest / ctx.pluginId / ctx.version', '当前插件信息与宿主版本'],
                  ['registerModule({ id, name, icon, component, priority })', '注册一个模块，它会出现在侧边栏与仪表盘'],
                  ['registerCommand({ id, title, run })', '把一个动作注册进标题栏的全局搜索（Ctrl+K）'],
                  ['useModuleActive()', '返回当前模块是否真的对用户可见；标签页会保活，切走不卸载，后台工作应据此暂停'],
                ].map(([api, desc]) => (
                  <div
                    key={api}
                    className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 px-3 py-2 border-b border-gray-50 last:border-0"
                  >
                    <code className="text-[11px] font-mono text-indigo-600 sm:w-72 shrink-0">
                      {api}
                    </code>
                    <span className="text-[11px] text-gray-500">{desc}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl bg-amber-50 border border-amber-200 p-3">
              <p className="text-xs text-amber-800 leading-relaxed">
                <strong>安全提示：</strong>插件 bundle 在与应用同一个 WebView
                中执行，与宿主共享同一个 JavaScript 上下文。当前真正被校验的只有四项权限：
                <code className="font-mono">network</code> /{' '}
                <code className="font-mono">network-external</code>（网络）与{' '}
                <code className="font-mono">notification</code> /{' '}
                <code className="font-mono">plugin-communicate</code>（应用内通知与跨模块通信），
                其余声明尚未强制执行。这不是进程级沙箱 —— 插件可以直接访问{' '}
                <code className="font-mono">window</code>、读取会话令牌，也可以用常规 Web 手段
                绕过 <code className="font-mono">ctx.http</code> 发起请求。只安装你信任来源的插件。
              </p>
            </section>
          </div>
        </motion.div>
      </>
    )}
  </AnimatePresence>
));

DevGuide.displayName = 'DevGuide';

export default DevGuide;
