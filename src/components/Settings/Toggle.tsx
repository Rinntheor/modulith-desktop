// src/components/Settings/Toggle.tsx
//
// 设置页的开关。
//
// 从 SettingsDialog.tsx 里抽出来，是因为更新卡片（UpdateChecker）也要用它。
// 留在 SettingsDialog 里会让 UpdateChecker 反向 import 那个文件，而
// SettingsDialog 正是 import UpdateChecker 的那一方 —— 那是一个循环依赖。
// 开关本身也不含任何设置页特有的东西，抽出来是自然的。
//
// 用 `role="switch"` + `aria-checked` 而不是 `<input type="checkbox">`：
// 外观完全由样式控制，但要保留"这是一个可切换的二元状态"这个语义给读屏软件。

import React from 'react';
import { motion } from 'framer-motion';

const Toggle: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}> = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 ${
      checked ? 'bg-indigo-600' : 'bg-gray-300'
    }`}
  >
    <motion.span
      initial={false}
      animate={{ x: checked ? 16 : 2 }}
      transition={{ type: 'spring', stiffness: 600, damping: 35 }}
      className="inline-block h-4 w-4 rounded-full bg-white shadow"
    />
  </button>
);

export default Toggle;
