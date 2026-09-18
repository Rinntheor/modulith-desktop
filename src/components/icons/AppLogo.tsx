// src/components/icons/AppLogo.tsx
//
// 应用标识。**唯一实现** —— 侧边栏、启动界面、授权界面、关于页都渲染这个组件。
//
// 形态：三枚方块 + 右下角空位（源文件见 public/modulith.svg）。
//   · 三枚方块 = 已装入的 module
//   · 空位     = 还没装的那个插槽（"需要什么功能就加什么模块"）
//
// ---------------------------------------------------------------------------
// 两种呈现方式
//
// 1) **裸标记**（默认，`withSurface` 不传）
//    只有方块，颜色由 `currentColor` 决定：
//      · 深色背景 → 白色方块（调用处给 `text-white`）
//      · 浅色背景 → 黑色方块（调用处给 `text-gray-900`）
//    用于界面内（侧边栏、关于页）。一份资源适配两种主题。
//
// 2) **带底板**（`withSurface`）
//    黑底 + 白方块。用于应用图标，以及启动/授权界面的主视觉。
//
// ---------------------------------------------------------------------------
// 关于底板为什么是黑色而不是品牌紫，以及为什么必须有描边
//
// 曾用过 indigo→violet 渐变底板，视觉上"像个按钮"，与产品气质不符，故改为黑色。
//
// 但**近黑底板在深色环境里会与背景融为一体**，这一点已实测：
//
//     #18181b 底板 vs 启动界面背景 #101322   → 对比度 1.04:1（几乎看不见）
//     #18181b 底板 vs Windows 深色任务栏 #202020 → 对比度 1.09:1（同上）
//     #18181b 底板 vs 浅色壁纸 #f0f0f0         → 对比度 15.55:1（很清楚）
//
// 也就是说：不加处理时，图标在深色背景上会变成"三个悬空的白方块"，
// 底板的形状信息完全丢失。因此底板带一圈**浅色细描边**（`SURFACE_STROKE`），
// 让它在任何背景上都有明确边界。描边取白但低透明度，因此在浅色背景上
// 几乎不可见、在深色背景上提供轮廓 —— 两头都不突兀。
// ---------------------------------------------------------------------------

import React from 'react';

/** 底板颜色：近黑（锌灰最深档）。比纯黑柔和，圆角不会显得生硬。 */
const SURFACE_FILL = '#18181b';
/**
 * 底板描边：白色低透明度。
 * 作用见文件头——它在深色背景上给出轮廓，在浅色背景上几乎看不见。
 */
const SURFACE_STROKE = 'rgba(255, 255, 255, 0.22)';

interface AppLogoProps {
  /**
   * Tailwind 尺寸类，例如 `w-8 h-8`、`w-16 h-16`。
   * 裸标记模式下颜色也在这里给（`text-white` / `text-gray-900`）。
   */
  className?: string;
  /**
   * 是否带黑色底板。
   *
   * 默认 false —— 界面内使用时应为裸标记，由所在位置的主题决定方块颜色。
   * 应用图标与启动/授权界面的主视觉传 true。
   */
  withSurface?: boolean;
  /** 是否带投影（只在 withSurface 时有意义） */
  shadow?: boolean;
}

const AppLogo: React.FC<AppLogoProps> = ({
  className = 'w-8 h-8',
  withSurface = false,
  shadow = false,
}) => {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="Modulith Desktop"
      className={`${className} ${withSurface && shadow ? 'drop-shadow-lg' : ''}`}
    >
      {/* 底板：仅应用图标与主视觉使用 */}
      {withSurface && (
        <rect
          x="0.6"
          y="0.6"
          width="30.8"
          height="30.8"
          rx="6.9"
          fill={SURFACE_FILL}
          stroke={SURFACE_STROKE}
          strokeWidth="1.2"
        />
      )}

      {/*
        三枚方块。withSurface 时用纯白（叠在黑底上）；
        否则用 currentColor（跟随所在位置的主题色）。
        坐标与 public/modulith.svg 保持一致。
      */}
      <g fill={withSurface ? '#ffffff' : 'currentColor'}>
        <rect x="4" y="4" width="10" height="10" rx="2.6" />
        <rect x="4" y="18" width="10" height="10" rx="2.6" />
        <rect x="18" y="18" width="10" height="10" rx="2.6" />
      </g>
    </svg>
  );
};

export default AppLogo;
