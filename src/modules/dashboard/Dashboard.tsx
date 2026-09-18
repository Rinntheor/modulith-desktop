// src/modules/dashboard/Dashboard.tsx

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { useSidebar } from '@/contexts/SidebarContext';
import { moduleManager } from '../../services/moduleManager';
import { getCatalogModules } from '../../services/moduleCatalog';
import type { ModuleDescriptor } from '../../types/module';
import ModuleIcon from '../../components/ModuleIcon';
import {
  Star,
  Clock,
  Eye,
  EyeOff,
  Hash,
  Search,
  Grid3X3,
  List,
  Layers,
  Zap,
  Bookmark,
  ArrowUpRight,
  SlidersHorizontal,
} from 'lucide-react';

// ==================== 类型 ====================

type ViewMode = 'grid' | 'list';
type SortMode = 'default' | 'name' | 'recent';

// ==================== 动画变体 ====================

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.03, delayChildren: 0.05 },
  },
};

const gridCardVariants = {
  hidden: { opacity: 0, y: 15, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring' as const, stiffness: 250, damping: 22 },
  },
};

const statVariants = {
  hidden: { opacity: 0, scale: 0.9, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { delay: 0.15 + i * 0.06, type: 'spring' as const, stiffness: 200, damping: 20 },
  }),
};

// ==================== 子组件 ====================

/** 统计卡片 */
const StatCard: React.FC<{
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  gradient: string;
  iconBg: string;
  index: number;
}> = ({ label, value, icon: Icon, gradient, iconBg, index }) => (
  <motion.div
    custom={index}
    variants={statVariants}
    initial="hidden"
    animate="visible"
    className="relative overflow-hidden rounded-2xl p-5 bg-white border border-gray-100 shadow-sm hover:shadow-md transition-shadow duration-300"
  >
    <div className={`absolute -top-4 -right-4 w-20 h-20 rounded-full opacity-10 ${gradient}`} />
    <div className="flex items-start justify-between relative z-10">
      <div>
        <motion.p
          className="text-3xl font-bold text-gray-900"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 + index * 0.06 }}
        >
          {value}
        </motion.p>
        <p className="text-sm text-gray-500 mt-1 font-medium">{label}</p>
      </div>
      <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center`}>
        <Icon className="w-5 h-5" />
      </div>
    </div>
  </motion.div>
);

/** 模块卡片（网格模式） */
const ModuleGridCard: React.FC<{
  module: ModuleDescriptor;
  isFavorited: boolean;
  isHidden: boolean;
  isRecent: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onToggleVisibility: () => void;
}> = ({ module, isFavorited, isHidden, isRecent, onOpen, onToggleFavorite, onToggleVisibility }) => {
  const childCount = module.children?.length || 0;

  return (
    <motion.div
      variants={gridCardVariants}
      whileHover={{ y: -4, scale: 1.01, transition: { type: 'spring' as const, stiffness: 400, damping: 15 } }}
      whileTap={{ scale: 0.98, transition: { duration: 0.1 } }}
      onClick={module.disabled ? undefined : onOpen}
      className={`group relative bg-white rounded-2xl border p-5 cursor-pointer transition-shadow duration-300 ${
        module.disabled
          ? 'border-gray-100 opacity-50 cursor-not-allowed'
          : isHidden
          ? 'border-amber-200/60 bg-amber-50/20 hover:shadow-xl hover:shadow-amber-100/50 hover:border-amber-300'
          : 'border-gray-100 hover:shadow-xl hover:shadow-indigo-100/50 hover:border-indigo-200'
      }`}
    >
      {/* 顶部行 */}
      <div className="flex items-start justify-between mb-4">
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center transition-colors duration-300 ${
            module.disabled ? 'bg-gray-100' : isHidden ? 'bg-amber-100' : 'bg-indigo-50 group-hover:bg-indigo-100'
          }`}
        >
          <ModuleIcon
            icon={module.icon}
            iconSvg={module.iconSvg}
            name={module.name}
            className={`w-5 h-5 ${module.disabled ? 'text-gray-400' : isHidden ? 'text-amber-600' : 'text-indigo-600'}`}
          />
        </div>

        <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            className={`p-1.5 rounded-lg transition-all duration-200 ${
              isFavorited ? 'bg-amber-100 text-amber-500 hover:bg-amber-200' : 'hover:bg-gray-100 text-gray-400 hover:text-amber-500'
            }`}
            title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Star className={`w-3.5 h-3.5 ${isFavorited ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
            title={isHidden ? 'Show in sidebar' : 'Hide from sidebar'}
          >
            {isHidden ? <Eye className="w-3.5 h-3.5 text-amber-500" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-1 group-hover:text-indigo-600 transition-colors">{module.name}</h3>
        <p className="text-xs text-gray-500 line-clamp-2 leading-relaxed">{module.description}</p>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          {isRecent && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-indigo-100 text-indigo-600 rounded-full flex items-center space-x-1">
              <Clock className="w-2.5 h-2.5" /><span>Recent</span>
            </span>
          )}
          {module.badge && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-600 rounded-full">{module.badge}</span>
          )}
          {module.disabled && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 rounded-full">Disabled</span>
          )}
          {isFavorited && (
            <span className="px-2 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-600 rounded-full flex items-center space-x-1">
              <Star className="w-2.5 h-2.5 fill-current" /><span>Fav</span>
            </span>
          )}
        </div>
        {childCount > 0 && (
          <div className="flex items-center space-x-1 text-[10px] text-gray-400">
            <Hash className="w-3 h-3" /><span>{childCount}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
};

/** 模块列表项（列表模式 — 无入场动画，瞬间显示） */
const ModuleListItem: React.FC<{
  module: ModuleDescriptor;
  isFavorited: boolean;
  isHidden: boolean;
  isRecent: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onToggleVisibility: () => void;
}> = ({ module, isFavorited, isHidden, isRecent, onOpen, onToggleFavorite, onToggleVisibility }) => {
  const childCount = module.children?.length || 0;

  return (
    <motion.div
      whileHover={{ x: 3, transition: { duration: 0.15 } }}
      onClick={module.disabled ? undefined : onOpen}
      className={`group flex items-center px-4 py-3 rounded-xl border cursor-pointer transition-all duration-150 ${
        module.disabled
          ? 'bg-gray-50 border-gray-100 opacity-50 cursor-not-allowed'
          : isHidden
          ? 'bg-amber-50/30 border-amber-200/60 hover:bg-amber-50 hover:border-amber-300'
          : 'bg-white border-gray-100 hover:bg-gray-50/50 hover:border-gray-200'
      }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
        module.disabled ? 'bg-gray-100' : isHidden ? 'bg-amber-100' : 'bg-indigo-50'
      }`}>
        <ModuleIcon
          icon={module.icon}
          iconSvg={module.iconSvg}
          name={module.name}
          className={`w-4 h-4 ${module.disabled ? 'text-gray-400' : isHidden ? 'text-amber-600' : 'text-indigo-600'}`}
        />
      </div>

      <div className="ml-3 flex-1 min-w-0">
        <div className="flex items-center space-x-2">
          <h3 className="text-sm font-medium text-gray-900 truncate">{module.name}</h3>
          {isFavorited && <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />}
        </div>
        <p className="text-xs text-gray-500 truncate mt-0.5">{module.description}</p>
      </div>

      <div className="flex items-center space-x-2 ml-4 shrink-0">
        {isRecent && <span className="px-2 py-0.5 text-[10px] font-medium bg-indigo-100 text-indigo-600 rounded-full">Recent</span>}
        {module.badge && <span className="px-2 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-600 rounded-full">{module.badge}</span>}
        {childCount > 0 && (
          <span className="text-xs text-gray-400 flex items-center space-x-0.5"><Hash className="w-3 h-3" /><span>{childCount}</span></span>
        )}

        <div className="flex items-center space-x-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            className={`p-1 rounded-md transition-colors ${isFavorited ? 'text-amber-500 hover:bg-amber-100' : 'text-gray-400 hover:bg-gray-100'}`}
          >
            <Star className={`w-3.5 h-3.5 ${isFavorited ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onToggleVisibility(); }}
            className="p-1 rounded-md text-gray-400 hover:bg-gray-100 transition-colors"
          >
            {isHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
        </div>
        <ArrowUpRight className="w-3.5 h-3.5 text-gray-300 group-hover:text-indigo-400 transition-colors ml-2" />
      </div>
    </motion.div>
  );
};

/** 空状态 */
const EmptyState: React.FC<{ query: string }> = ({ query }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    className="flex flex-col items-center justify-center py-20"
  >
    <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mb-4">
      <Search className="w-6 h-6 text-gray-400" />
    </div>
    <h3 className="text-base font-semibold text-gray-700 mb-1">No modules found</h3>
    <p className="text-sm text-gray-400">{query ? `No results for "${query}"` : 'All modules are currently hidden'}</p>
  </motion.div>
);

// ==================== 主组件 ====================

const Dashboard: React.FC = () => {
  const { setActiveModule } = useSidebar();

  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [isLoaded, setIsLoaded] = useState(false);

  // 目录版本号：插件安装/启用/禁用/卸载后递增，用于让模块列表与统计重新计算
  const [catalogVersion, setCatalogVersion] = useState(0);

  const allModules = useMemo(
    () => getCatalogModules().filter((m) => m.visible !== false),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalogVersion]
  );

  // 加载数据
  useEffect(() => {
    const load = async () => {
      try {
        const [recentRaw, favRaw, prefs] = await Promise.all([
          invoke<string[]>('get_recent_modules'),
          invoke<string[]>('get_favorite_modules'),
          invoke<{ hidden_modules: string[] }>('get_module_preferences'),
        ]);
        setRecentIds(recentRaw);
        setFavoriteIds(new Set(favRaw));
        setHiddenIds(new Set(prefs.hidden_modules));
      } catch (e) {
        console.warn('Dashboard load error:', e);
      } finally {
        setIsLoaded(true);
      }
    };
    load();
  }, []);

  // 订阅 moduleManager 变更通知（Sidebar 操作 / 插件增删后同步刷新 Dashboard）
  useEffect(() => {
    const unsubscribe = moduleManager.subscribe(() => {
      // 模块目录可能因插件安装、启用、禁用、卸载而变化
      setCatalogVersion((v) => v + 1);

      const sync = async () => {
        try {
          const [recentRaw, favRaw, prefs] = await Promise.all([
            invoke<string[]>('get_recent_modules'),
            invoke<string[]>('get_favorite_modules'),
            invoke<{ hidden_modules: string[] }>('get_module_preferences'),
          ]);
          setRecentIds(recentRaw);
          setFavoriteIds(new Set(favRaw));
          setHiddenIds(new Set(prefs.hidden_modules));
        } catch (e) {
          console.warn('Dashboard sync error:', e);
        }
      };
      sync();
    });
    return unsubscribe;
  }, []);

  // 最近使用的模块描述符
  const recentModules = useMemo(
    () => {
      const map = new Map(allModules.map((m) => [m.id, m]));
      return recentIds.map((id) => map.get(id)).filter(Boolean) as ModuleDescriptor[];
    },
    [allModules, recentIds]
  );

  // 排序和过滤
  const processedModules = useMemo(() => {
    let list = [...allModules];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)
      );
    }

    if (sortMode === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'recent') {
      const rank = new Map(recentIds.map((id, i) => [id, i]));
      list.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    } else {
      list.sort((a, b) => {
        const aFav = favoriteIds.has(a.id) ? 1 : 0;
        const bFav = favoriteIds.has(b.id) ? 1 : 0;
        return bFav - aFav || a.priority - b.priority;
      });
    }

    return list;
  }, [allModules, searchQuery, sortMode, recentIds, favoriteIds]);

  // 统计
  const stats = useMemo(() => {
    const total = allModules.length;
    const disabled = allModules.filter((m) => m.disabled).length;
    const hidden = hiddenIds.size;
    const active = total - disabled - hidden;
    const favorited = favoriteIds.size;
    return { total, active, hidden, disabled, favorited };
  }, [allModules, hiddenIds, favoriteIds]);

  // 操作
  const handleOpen = useCallback(
    async (moduleId: string) => {
      setActiveModule(moduleId);
      try {
        await invoke('record_module_open', { moduleId });
        setRecentIds((prev) => {
          const next = [moduleId, ...prev.filter((id) => id !== moduleId)].slice(0, 10);
          return next;
        });
      } catch (e) {
        console.warn(e);
      }
    },
    [setActiveModule]
  );

  const handleToggleFavorite = useCallback(
    async (moduleId: string) => {
      const isFav = favoriteIds.has(moduleId);
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        isFav ? next.delete(moduleId) : next.add(moduleId);
        return next;
      });
      try {
        await invoke('toggle_favorite_module', { moduleId, favorite: !isFav });
      } catch (e) {
        console.warn(e);
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          isFav ? next.add(moduleId) : next.delete(moduleId);
          return next;
        });
      }
    },
    [favoriteIds]
  );

  const handleToggleVisibility = useCallback(
    async (moduleId: string) => {
      const isHidden = hiddenIds.has(moduleId);
      setHiddenIds((prev) => {
        const next = new Set(prev);
        isHidden ? next.delete(moduleId) : next.add(moduleId);
        return next;
      });
      try {
        isHidden ? await moduleManager.showModule(moduleId) : await moduleManager.hideModule(moduleId);
      } catch (e) {
        console.warn(e);
        setHiddenIds((prev) => {
          const next = new Set(prev);
          isHidden ? next.add(moduleId) : next.delete(moduleId);
          return next;
        });
      }
    },
    [hiddenIds]
  );

  // 加载动画
  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
          className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full"
        />
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-7xl mx-auto px-2">
      {/* 头部 */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
        <div className="flex items-center space-x-3 mb-2">
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        </div>
        <p className="text-sm text-gray-500">Discover, organize, and launch your modules</p>
      </motion.div>

      {/* 统计卡片 */}
      <motion.div variants={containerVariants} initial="hidden" animate="visible" className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard label="Total Modules" value={stats.total} icon={Layers} gradient="bg-indigo-500" iconBg="bg-indigo-50 text-indigo-600" index={0} />
        <StatCard label="Active" value={stats.active} icon={Zap} gradient="bg-emerald-500" iconBg="bg-emerald-50 text-emerald-600" index={1} />
        <StatCard label="Favorites" value={stats.favorited} icon={Star} gradient="bg-amber-500" iconBg="bg-amber-50 text-amber-600" index={2} />
        <StatCard label="Hidden" value={stats.hidden} icon={EyeOff} gradient="bg-orange-500" iconBg="bg-orange-50 text-orange-600" index={3} />
        <StatCard label="Disabled" value={stats.disabled} icon={SlidersHorizontal} gradient="bg-gray-500" iconBg="bg-gray-50 text-gray-600" index={4} />
      </motion.div>

      {/* 最近使用 */}
      {recentModules.length > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center space-x-2 mb-4">
            <div className="w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
              <Clock className="w-3.5 h-3.5 text-indigo-600" />
            </div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Recently Used</h2>
            <span className="text-xs text-gray-400">· {recentModules.length} modules</span>
          </div>
          <div className="flex items-center space-x-3 overflow-x-auto pb-1">
            {recentModules.map((mod) => (
              <motion.button
                key={mod.id}
                // whileHover={{ scale: 1.03, y: -2 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => handleOpen(mod.id)}
                disabled={mod.disabled}
                className={`flex items-center space-x-2.5 px-4 py-2.5 rounded-xl border transition-all duration-200 shrink-0 ${
                  mod.disabled
                    ? 'bg-gray-50 border-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-white border-gray-100 hover:border-indigo-200 hover:bg-indigo-50/30 text-gray-700'
                }`}
              >
                <ModuleIcon icon={mod.icon} iconSvg={mod.iconSvg} name={mod.name} className="w-4 h-4" />
                <span className="text-sm font-medium">{mod.name}</span>
                <ArrowUpRight className="w-3 h-3 text-gray-400" />
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}

      {/* 收藏区域 */}
      {favoriteIds.size > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center space-x-2 mb-4">
            <div className="w-6 h-6 bg-amber-100 rounded-lg flex items-center justify-center">
              <Bookmark className="w-3.5 h-3.5 text-amber-600" />
            </div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Favorites</h2>
            <span className="text-xs text-gray-400">· {favoriteIds.size} modules</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {allModules
              .filter((m) => favoriteIds.has(m.id))
              .map((mod) => (
                <motion.div
                  key={mod.id}
                  whileHover={{ y: -3, scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleOpen(mod.id)}
                  className="group flex items-center space-x-3 bg-white border border-amber-200/60 rounded-xl p-3 cursor-pointer hover:shadow-lg hover:shadow-amber-100/50 hover:border-amber-300 transition-all duration-200"
                >
                  <div className="w-9 h-9 bg-amber-50 rounded-lg flex items-center justify-center shrink-0">
                    <ModuleIcon
                      icon={mod.icon}
                      iconSvg={mod.iconSvg}
                      name={mod.name}
                      className="w-4 h-4 text-amber-600"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{mod.name}</p>
                    <p className="text-xs text-gray-500 truncate">{mod.description}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleFavorite(mod.id); }}
                    className="p-1 rounded-md text-amber-400 hover:bg-amber-100 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Star className="w-3.5 h-3.5 fill-current" />
                  </button>
                </motion.div>
              ))}
          </div>
        </motion.div>
      )}

      {/* 工具栏 */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search modules..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>

        <div className="flex items-center space-x-2">
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="px-3 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-600 focus:outline-none focus:border-indigo-300 cursor-pointer"
          >
            <option value="default">Default</option>
            <option value="name">Name</option>
            <option value="recent">Recently Used</option>
          </select>

          <div className="flex bg-gray-100 rounded-xl p-1">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-2 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Grid3X3 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-2 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* 所有模块 */}
      <motion.div variants={containerVariants} initial="hidden" animate="visible">
        <div className="flex items-center space-x-2 mb-4">
          <div className="w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
            <Grid3X3 className="w-3.5 h-3.5 text-indigo-600" />
          </div>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">All Modules</h2>
          <span className="text-xs text-gray-400">· {processedModules.length} modules</span>
        </div>

        {processedModules.length === 0 ? (
          <EmptyState query={searchQuery} />
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {processedModules.map((mod) => (
              <ModuleGridCard
                key={mod.id}
                module={mod}
                isFavorited={favoriteIds.has(mod.id)}
                isHidden={hiddenIds.has(mod.id)}
                isRecent={recentIds.includes(mod.id)}
                onOpen={() => handleOpen(mod.id)}
                onToggleFavorite={() => handleToggleFavorite(mod.id)}
                onToggleVisibility={() => handleToggleVisibility(mod.id)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {processedModules.map((mod) => (
              <ModuleListItem
                key={mod.id}
                module={mod}
                isFavorited={favoriteIds.has(mod.id)}
                isHidden={hiddenIds.has(mod.id)}
                isRecent={recentIds.includes(mod.id)}
                onOpen={() => handleOpen(mod.id)}
                onToggleFavorite={() => handleToggleFavorite(mod.id)}
                onToggleVisibility={() => handleToggleVisibility(mod.id)}
              />
            ))}
          </div>
        )}
      </motion.div>

      <div className="h-12" />
    </motion.div>
  );
};

export default Dashboard;
