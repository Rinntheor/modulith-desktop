// src/config/appInfo.ts
//
// 应用身份信息（名称、作者、外链、许可）的唯一来源。
//
// 放在 config 而不是散落在「关于」页面里，是为了让 README、关于页、
// 打包元数据（Cargo.toml / tauri.conf.json）能引用同一份事实，
// 避免出现「文档写一个主页、界面写另一个」。
//
// 这里的链接会通过 Tauri 的 opener 插件交给系统浏览器打开，
// 不会在 WebView 内导航（WebView 内导航会离开应用本体）。

export interface SocialLink {
  /** 展示名称 */
  label: string;
  /** 完整 URL */
  url: string;
  /** 展示用的账号/路径片段 */
  handle: string;
  /**
   * 图标标识。取值由「关于」页面映射到 `src/components/icons/BrandIcon.tsx`
   * 中的具体组件 —— 这样本文件不需要 import 任何 React 依赖，
   * 可以被脚本与单元测试安全引用。
   */
  icon: 'github' | 'bilibili';
  /**
   * 品牌主色（Tailwind 工具类组合）。
   *
   * 用于悬停时把图标底色点亮成该平台的识别色，让"点哪个平台"在视觉上
   * 有区分度。GitHub 用近黑的深灰（其标识本身是单色），
   * 哔哩哔哩用其标识的粉色。
   */
  accent: {
    /** 图标悬停时的文字色（用于 currentColor 图标） */
    iconHover: string;
    /** 图标容器悬停时的底色 */
    chipHover: string;
    /** 卡片边框悬停色 */
    borderHover: string;
  };
}

export const APP_INFO = {
  /**
   * 应用显示名。
   *
   * 必须与 `version.toml` 的 `app.name` 和 `tauri.conf.json` 的 `productName`
   * 一致 —— 三者不同步会让窗口标题、关于页与打包产物名不一致。
   * `pnpm ver check` 会校验 productName。
   */
  name: 'Modulith Desktop',
  /** 简称，用于空间受限处（侧边栏 logo 区、启动界面标记） */
  shortName: 'Modulith',
  /**
   * 内部包名（与 Cargo.toml / package.json 一致）。
   *
   * 注意这与 `tauri.conf.json` 的 `identifier` 是两件事：
   * identifier 决定用户数据目录路径（不可随意变动），包名只影响构建产物。
   */
  packageName: 'modulith-desktop',
  /** 一句话定位 */
  tagline: '高自由度的模块化桌面框架',
  /** 作者 / 团队 */
  author: '环理论',
  /** 许可证（与仓库根目录 LICENSE 一致：GNU GPL v3） */
  license: 'GPL-3.0',
  /** 项目主页（GitHub 用户名已于 2026 年由 MetaZeroDev 更名为 Rinntheor） */
  homepage: 'https://github.com/Rinntheor',
  /** 版权年份起点 */
  copyrightFrom: 2025,
} as const;

/** 作者与项目的外链 */
export const APP_LINKS: SocialLink[] = [
  {
    label: 'GitHub',
    url: 'https://github.com/Rinntheor',
    handle: 'Rinntheor',
    icon: 'github',
    accent: {
      iconHover: 'group-hover:text-gray-900',
      chipHover: 'group-hover:bg-gray-900/10',
      borderHover: 'hover:border-gray-400',
    },
  },
  {
    label: '哔哩哔哩',
    url: 'https://space.bilibili.com/3546759747865450',
    handle: 'space.bilibili.com/3546759747865450',
    icon: 'bilibili',
    accent: {
      iconHover: 'group-hover:text-[#fb7299]',
      chipHover: 'group-hover:bg-[#fb7299]/15',
      borderHover: 'hover:border-[#fb7299]/60',
    },
  },
];
