// src/components/icons/BrandIcon.tsx
//
// 品牌图标的矢量字形。
//
// 为什么不用 lucide-react：lucide 1.x 已经移除了全部品牌图标
// （`Github` 等导出不存在，见 `node_modules/lucide-react/dist/lucide-react.d.ts`），
// 因此「关于」页只能用通用图标代替，用户认不出是哪个平台。
//
// 所有图标都是单色 `currentColor`：颜色由外层文字色控制，
// 因此深色模式与悬停态都不需要额外处理。

import React from 'react';

interface BrandIconProps {
  /** 图标尺寸，同时用于 width/height 与 viewBox 缩放 */
  className?: string;
}

/** GitHub 标准字形（官方 mark，16×16 视口） */
const GitHubMark: React.FC<BrandIconProps> = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    className={className}
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

/**
 * 哔哩哔哩「小电视」字形。
 *
 * ---------------------------------------------------------------------------
 * **这是照参考图还原的字形，不是官方矢量文件。**
 *
 * 绘制依据是哔哩哔哩官方标识的可见构成：圆角电视机身 + 左上/右上两根天线
 * + 两只微眯的眼 + ω 形嘴。各部件坐标由手工推算，因此**比例与官方文件
 * 存在细微差异**。
 *
 * 这对当前用途（关于页里 18px 的单色图标，旁边始终有「哔哩哔哩」文字）
 * 是够用的：目标是让用户一眼认出是哪个平台，而不是复制官方素材。
 * 但若将来要在**品牌宣传、应用图标、商店素材**等场合使用，请改用官方
 * 矢量文件 —— 那时的准确性与授权合规都更重要。
 *
 * 替换方式：把官方 SVG 的 `<path d="…"/>` 中 `d` 的值填入
 * `BILIBILI_OFFICIAL_PATH`，下面的组件会优先使用它，无需改动其它文件。
 * ---------------------------------------------------------------------------
 */
const BILIBILI_OFFICIAL_PATH = '';

const BilibiliMark: React.FC<BrandIconProps> = ({ className }) => {
  // 官方路径一旦填入，优先使用（可实现逐像素还原）
  if (BILIBILI_OFFICIAL_PATH) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        className={className}
      >
        <path d={BILIBILI_OFFICIAL_PATH} />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {/* 电视机身（圆角矩形轮廓，屏幕内部留空） */}
      <rect x="3.1" y="7.4" width="17.8" height="12.6" rx="3.1" />

      {/* 两根天线：自机身上沿向左上 / 右上伸出 */}
      <path d="M8 7.4 5.6 4.9" />
      <path d="M16 7.4 18.4 4.9" />

      {/* 双眼：外侧略低、内侧略高，形成微眯的表情 */}
      <path d="M8.2 12.9 10.3 12.2" strokeWidth="1.6" />
      <path d="M15.8 12.9 13.7 12.2" strokeWidth="1.6" />

      {/* 嘴：ω 形（两个小弧），中心对齐机身中轴 x=12 */}
      <path
        d="M8.7 15.1c0 1.05.85 1.9 1.9 1.9.55 0 1.05-.25 1.4-.65.35.4.85.65 1.4.65 1.05 0 1.9-.85 1.9-1.9"
        strokeWidth="1.5"
      />
    </svg>
  );
};

/** 图标标识 → 组件。键与 `src/config/appInfo.ts` 的 `SocialLink.icon` 对应。 */
export const BRAND_ICONS: Record<string, React.FC<BrandIconProps>> = {
  github: GitHubMark,
  bilibili: BilibiliMark,
};

export { GitHubMark, BilibiliMark };
