// src/modules/plugins/PluginIcon.tsx
// 插件图标：支持内联 SVG、图标文件（.svg）、lucide 图标名，最后回退到首字母方块

import React, { memo, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Package } from 'lucide-react';
import * as Icons from '../../generated/iconMap';
import type { PluginManifest } from '../../services/pluginRuntime';

type IconSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<IconSize, string> = {
  sm: 'w-9 h-9 rounded-lg',
  md: 'w-12 h-12 rounded-xl',
  lg: 'w-16 h-16 rounded-2xl',
};

const GLYPH_CLASS: Record<IconSize, string> = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
};

interface PluginIconProps {
  pluginId: string;
  manifest: PluginManifest;
  size?: IconSize;
}

/** 稳定的色板，按插件 ID 取色，避免每次渲染变色 */
const GRADIENTS = [
  'from-indigo-500 to-purple-600',
  'from-sky-500 to-blue-600',
  'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-600',
  'from-rose-500 to-pink-600',
  'from-violet-500 to-fuchsia-600',
];

function gradientFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

function isSvgMarkup(value: string): boolean {
  return value.trim().startsWith('<svg');
}

const PluginIcon: React.FC<PluginIconProps> = memo(({ pluginId, manifest, size = 'md' }) => {
  const icon = manifest.icon ?? '';
  const iconSvg = manifest.iconSvg ?? '';
  const svgFile = icon.toLowerCase().endsWith('.svg') ? icon : null;

  const [fileSvg, setFileSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!svgFile) {
      setFileSvg(null);
      return;
    }
    let cancelled = false;
    invoke<string>('read_plugin_asset', { id: pluginId, rel: svgFile })
      .then((content) => {
        if (!cancelled) setFileSvg(content);
      })
      .catch(() => {
        if (!cancelled) setFileSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, svgFile]);

  const inlineSvg = useMemo(() => {
    if (iconSvg && isSvgMarkup(iconSvg)) return iconSvg;
    if (fileSvg && isSvgMarkup(fileSvg)) return fileSvg;
    if (icon && isSvgMarkup(icon)) return icon;
    return null;
  }, [icon, iconSvg, fileSvg]);

  const LucideIcon = useMemo(() => {
    if (!icon || inlineSvg || svgFile) return null;
    const candidate = (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[
      icon
    ];
    return candidate ?? null;
  }, [icon, inlineSvg, svgFile]);

  // 1) 内联/文件 SVG：直接渲染
  if (inlineSvg) {
    return (
      <div
        className={`${SIZE_CLASS[size]} bg-white border border-gray-200 flex items-center justify-center overflow-hidden shrink-0 [&>svg]:w-3/5 [&>svg]:h-3/5`}
        dangerouslySetInnerHTML={{ __html: inlineSvg }}
      />
    );
  }

  // 2) lucide 图标名
  if (LucideIcon) {
    return (
      <div
        className={`${SIZE_CLASS[size]} bg-linear-to-br ${gradientFor(pluginId)} flex items-center justify-center shrink-0 shadow-sm`}
      >
        <LucideIcon className={`${GLYPH_CLASS[size]} text-white`} />
      </div>
    );
  }

  // 3) 回退：首字母 / 通用图标
  const letter = (manifest.displayName || manifest.name || '?').trim().charAt(0).toUpperCase();
  return (
    <div
      className={`${SIZE_CLASS[size]} bg-linear-to-br ${gradientFor(pluginId)} flex items-center justify-center shrink-0 shadow-sm`}
    >
      {letter ? (
        <span className="text-white font-semibold" style={{ fontSize: size === 'lg' ? 22 : size === 'md' ? 17 : 13 }}>
          {letter}
        </span>
      ) : (
        <Package className={`${GLYPH_CLASS[size]} text-white`} />
      )}
    </div>
  );
});

PluginIcon.displayName = 'PluginIcon';

export default PluginIcon;
