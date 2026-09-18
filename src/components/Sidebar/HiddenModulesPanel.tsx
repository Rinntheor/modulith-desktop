// src/components/Sidebar/HiddenModulesPanel.tsx

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, X } from 'lucide-react';
import type { ModuleDescriptor } from '../../types/module';

interface HiddenModulesPanelProps {
  hiddenModules: ModuleDescriptor[];
  onShowModule: (moduleId: string) => void;
  onClose: () => void;
}

const HiddenModulesPanel: React.FC<HiddenModulesPanelProps> = ({
  hiddenModules,
  onShowModule,
  onClose,
}) => {
  const handleShow = async (moduleId: string) => {
    await onShowModule(moduleId);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-start justify-center pt-20"
        onClick={onClose}
      >
        {/* 遮罩层 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        />

        {/* 面板内容 */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => e.stopPropagation()}
          className="relative bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-200/50 w-[320px] max-h-100 overflow-hidden"
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center space-x-2">
              <Eye className="w-4 h-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900">Hidden Modules</h3>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>

          {/* 列表 */}
          <div className="overflow-y-auto max-h-75 p-2">
            {hiddenModules.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-gray-400">No hidden modules</p>
              </div>
            ) : (
              hiddenModules.map((mod) => (
                <motion.button
                  key={mod.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  whileHover={{ x: 4 }}
                  onClick={() => handleShow(mod.id)}
                  className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl hover:bg-gray-50 transition-colors group"
                >
                  <span className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center group-hover:bg-indigo-100 transition-colors">
                    <Eye className="w-4 h-4 text-gray-400 group-hover:text-indigo-600 transition-colors" />
                  </span>
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium text-gray-700">{mod.name}</p>
                    <p className="text-xs text-gray-400 truncate">{mod.description}</p>
                  </div>
                </motion.button>
              ))
            )}
          </div>

          {/* 底部提示 */}
          {hiddenModules.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100">
              <p className="text-xs text-gray-400 text-center">
                Click a module to restore it to the sidebar
              </p>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default HiddenModulesPanel;