// src/components/icons/IconPlate.tsx
//
// 「黑色圆角底板 + 白色图标」的容器。
//
// 这是应用内**非标识类**图标块的统一做法：插件页的页头、空状态、
// 侧边栏的模块徽标等都使用它。
//
// 为什么抽成组件：
//   此前这些位置各自内联 `bg-linear-to-br from-indigo-500 to-purple-600`
//   之类的紫色渐变，同一套东西散落在多处，改配色要逐个找。现在统一到这里，
//   配色只需改 `PLATE_CLASS`。
//
// 配色规则（与 AppLogo 的 withSurface 保持一致）：
//   · 底板近黑、图标纯白 —— 深色/浅色背景下都成立；
//   · 底板带一圈低透明度白描边 —— 否则近黑底板与深色背景融为一体时，
//     形状信息会完全丢失（实测对比度 1.04:1，见 AppLogo 内的说明）。
//     这里用 ring（内描边）而不是 border，因为 ring 不占布局尺寸，
//     不会让不同尺寸的底板出现像素级错位。
//
// 如果将来主题配色做成可切换（当前尚未实现），这个常量会改为读取主题变量；
// 届时调用方无需改动。

import React from 'react';

/** 底板配色：近黑 + 低透明度白描边 */
const PLATE_CLASS =
  'bg-[#18181b] ring-1 ring-inset ring-white/20 flex items-center justify-center shrink-0';

interface IconPlateProps {
  /** 图标组件（lucide 图标或其它接受 className 的组件） */
  icon: React.ComponentType<{ className?: string }>;
  /** 尺寸档位，决定底板与图标的尺寸 */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 圆角档位，默认随尺寸 */
  radius?: string;
  className?: string;
}

const SIZE_MAP = {
  sm: { plate: 'w-8 h-8', icon: 'w-4 h-4', radius: 'rounded-lg' },
  md: { plate: 'w-9 h-9', icon: 'w-4 h-4', radius: 'rounded-lg' },
  lg: { plate: 'w-10 h-10', icon: 'w-5 h-5', radius: 'rounded-xl' },
  xl: { plate: 'w-14 h-14', icon: 'w-6 h-6', radius: 'rounded-2xl' },
} as const;

const IconPlate: React.FC<IconPlateProps> = ({
  icon: Icon,
  size = 'md',
  radius,
  className = '',
}) => {
  const s = SIZE_MAP[size];
  return (
    <div className={`${s.plate} ${radius ?? s.radius} ${PLATE_CLASS} ${className}`}>
      <Icon className={`${s.icon} text-white`} />
    </div>
  );
};

export default IconPlate;
export { PLATE_CLASS };
