// src/components/Sidebar/animations.ts
import type { Variants } from 'framer-motion';

// 共享的过渡配置，避免重复创建对象
const springTransition = {
  type: 'spring' as const,
  stiffness: 350,     // 从 300 提升，更快响应
  damping: 30,
  mass: 0.8,         // 减小质量，动画更轻快
};

const sidebarTransition = {
  type: 'spring' as const,
  stiffness: 350,
  damping: 30,
  mass: 0.8,
  staggerChildren: 0.02,    // 从 0.05 优化到 0.02
  delayChildren: 0.05,      // 从 0.1 优化到 0.05
};

export const sidebarVariants: Variants = {
  hidden: {
    x: -320,
    opacity: 0,
    transition: {
      ...sidebarTransition,
      staggerChildren: 0,    // 关闭时不需要交错
      delayChildren: 0,
    },
  },
  visible: {
    x: 0,
    opacity: 1,
    transition: sidebarTransition,
  },
};

export const itemVariants: Variants = {
  hidden: { 
    opacity: 0, 
    x: -20,
  },
  visible: {
    opacity: 1,
    x: 0,
    transition: springTransition,
  },
};

export const subMenuVariants: Variants = {
  hidden: {
    opacity: 0,
    height: 0,
    transition: {
      duration: 0.2,
      ease: 'easeInOut',
    },
  },
  visible: {
    opacity: 1,
    height: 'auto',
    transition: {
      duration: 0.2,
      ease: 'easeOut',
      staggerChildren: 0.03,
      delayChildren: 0.05,
    },
  },
};

// 子菜单项动画 - 新增
export const subItemVariants: Variants = {
  hidden: {
    opacity: 0,
    x: -10,
  },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 400,
      damping: 30,
    },
  },
};


// 卡片动画使用更轻量的配置
export const cardVariants: Variants = {
  hidden: { 
    opacity: 0, 
    scale: 0.98,
    y: 10,
  },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      stiffness: 400,    // 更快
      damping: 25,
      mass: 0.7,
    },
  },
  hover: {
    scale: 1.02,
    transition: {
      duration: 0.15,   // 从默认改为具体值
    },
  },
};

// 覆盖层动画
export const overlayVariants: Variants = {
  hidden: {
    opacity: 0,
  },
  visible: {
    opacity: 1,
    transition: {
      duration: 0.15,   // 从 0.2 优化到 0.15
    },
  },
};