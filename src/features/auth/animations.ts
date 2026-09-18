// src/features/auth/animations.ts
// 授权界面的动效变体（迁移自 hive_atelier/src/components/auth/animations.ts）
//
// 配色统一为 Modulith 的 indigo/violet，不再是 hive_atelier 的 blue/purple。

import type { Variants } from 'framer-motion';

/** 容器：整体淡入，子元素依次入场 */
export const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.5, when: 'beforeChildren', staggerChildren: 0.08 },
  },
};

/** 标记：缩放 + 旋转入场 */
export const logoVariants: Variants = {
  hidden: { scale: 0, rotate: -180, opacity: 0 },
  visible: {
    scale: 1,
    rotate: 0,
    opacity: 1,
    transition: { type: 'spring', stiffness: 260, damping: 20 },
  },
  hover: {
    scale: 1.05,
    rotate: [0, -5, 5, 0],
    transition: { duration: 0.6, ease: 'easeInOut' },
  },
};

/** 标题：自下而上淡入 */
export const titleVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};

/** 表单：上浮入场 */
export const formVariants: Variants = {
  hidden: { opacity: 0, y: 30, scale: 0.96 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 300, damping: 25, delay: 0.15 },
  },
};

/** 提交按钮 */
export const buttonVariants: Variants = {
  rest: { scale: 1 },
  hover: { scale: 1.02 },
  tap: { scale: 0.98 },
  loading: { scale: 1 },
};

/** 错误提示的展开 / 收起 */
export const errorVariants: Variants = {
  hidden: { opacity: 0, y: -10, height: 0 },
  visible: {
    opacity: 1,
    y: 0,
    height: 'auto',
    transition: { type: 'spring', stiffness: 500, damping: 30 },
  },
  exit: { opacity: 0, y: -10, height: 0, transition: { duration: 0.2 } },
};
