// src/components/Settings/PluginSettingsSection.tsx
//
// 插件贡献的设置项（`contributes.settings`）。
//
// 这个界面的存在理由，与「插件」分页不同：那一个管理插件本身（安装、启用、权限），
// 这一个管理**插件自己的行为**。把后者塞进前者的列表里会让「我要关掉某个插件的
// 某个行为」变成「先在一堆插件卡片里找到它，再展开」。
//
// 界面的全部内容来自**清单声明**，没有执行任何插件代码 —— 一个已经安装了 200 个
// 插件、其中 30 个带了设置项的用户，打开这一页不会触发那 30 个插件的 bundle。
// 这不是优化，是前提：设置界面是用户最常来的地方之一，它不该成为"顺带把所有插件
// 跑一遍"的入口。
//
// 值的读写走 pluginSettings（后端 `plugin_storage_*`，需要插件声明 `storage`
// 权限）。没声明时控件会禁用并说明原因 —— 一个能点但改了不生效的开关更糟。
//
// ============================================================
// 为什么是**两级**：先列插件，再进某一个
// ============================================================
//
// 从前这一页把**所有**插件的**所有**设置项一次铺开。插件少的时候没问题，而
// 功能性（无界面）插件一多就不成立了 —— 它们没有侧边栏项、没有标签页，
// 这一页是它们唯一露脸的地方，于是"一屏里挤着十几个插件的设置"会让人**找不到**
// 某一个，而这不是难看的问题，是找不到的问题。
//
// 两级之后：
//   · 第一级是**插件清单**（名字 + 类别标记 + "N 项设置"），可以搜索；
//   · 第二级才是那一个插件的设置，带返回。
//
// ============================================================
// 为什么标出「后台 / 界面」而不按市场分类分组
// ============================================================
//
// 这是两类含义不同的插件，而用户需要的那句话不一样：
//   · **界面**插件的设置往往能就地试出效果（改完切回标签页就能看见）；
//   · **后台**插件**没有界面** —— 它的设置就是它的全部交互，改完不会有任何
//     即时反馈，只能等它下一次被唤醒。
//
// 不标出来的话，用户会以为某一条点下去"什么都没发生"是坏了。
//
// 而按清单里的 `categories`（示例/效率/开发）分组是**不做**的：那是市场分类，
// 用来做导航会让人在两个目录之间猜。**按"用户怎么找到它"分，不按"作者怎么描述它"分。**

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, Puzzle, RotateCcw, Search, Timer } from 'lucide-react';
import Toggle from './Toggle';
import {
  getInstalledPlugins,
  subscribePlugins,
} from '../../services/pluginRuntime';
import {
  getPluginSetting,
  getPluginSettingContributions,
  isPluginSettingsAvailable,
  listPluginsWithSettings,
  setPluginSetting,
  subscribePluginSettings,
} from '../../services/pluginSettings';
import {
  consumePluginSettingsFocus,
  subscribePluginSettingsRequest,
} from '../../services/pluginSettingsFocus';
import { showToast } from '../../services/toast';
import type { SettingContribution } from '../../types/plugin';

/**
 * 这个插件是不是**无界面**插件（声明了 `contributes.background`）。
 *
 * 只判"有没有那一块"，不解释入口路径合不合法 —— 那一件事由 Rust 侧在
 * **放行目录**之前判（`background_manifest.rs`），是安全判定，不该在这里有第二份。
 * 这一处只用它画一个角标。
 */
function hasBackgroundContribution(contributes: unknown): boolean {
  if (!contributes || typeof contributes !== 'object') return false;
  const background = (contributes as Record<string, unknown>).background;
  return Boolean(background && typeof background === 'object');
}

interface PluginSettingsSectionProps {
  /** 跳到「插件」分页（空状态与不可用时用） */
  onOpenPlugins?: () => void;
}

interface PluginGroup {
  pluginId: string;
  displayName: string;
  version: string;
  enabled: boolean;
  available: boolean;
  /** 是不是**无界面**插件（声明了 `contributes.background`） */
  headless: boolean;
  items: SettingContribution[];
}

const PluginSettingsSection: React.FC<PluginSettingsSectionProps> = ({ onOpenPlugins }) => {
  // 两个订阅缺一不可：插件列表变了要重建分组（装了/卸了/启用了），
  // 设置值变了要刷新控件（可能是插件自己写的）。
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  /** 当前正在看哪个插件的设置。`null` = 第一级（插件清单） */
  const [openedPluginId, setOpenedPluginId] = useState<string | null>(null);

  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    const unsubscribePlugins = subscribePlugins(bump);
    const unsubscribeSettings = subscribePluginSettings(bump);
    return () => {
      unsubscribePlugins();
      unsubscribeSettings();
    };
  }, []);

  // 一次性意图：从插件详情页的「设置」按钮过来时，直接进到那一个插件。
  //
  // 挂在组件上而不是由父组件传 prop：请求方（插件模块里的抽屉）与设置对话框
  // **没有共同祖先**，为了一个字符串去穿三层 prop 只会多三处需要维护的接口。
  useEffect(() => {
    const apply = () => {
      const focused = consumePluginSettingsFocus();
      if (focused) setOpenedPluginId(focused);
    };
    // 挂载时先看一次（对话框可能是被这次请求打开的），之后订阅。
    apply();
    return subscribePluginSettingsRequest(apply);
  }, []);

  const groups = useMemo<PluginGroup[]>(() => {
    void version;
    const byId = new Map(getInstalledPlugins().map((plugin) => [plugin.id, plugin]));

    return listPluginsWithSettings()
      .map((pluginId) => {
        const plugin = byId.get(pluginId);
        return {
          pluginId,
          displayName: plugin?.manifest.displayName || pluginId,
          version: plugin?.version ?? '',
          enabled: plugin?.enabled ?? false,
          available: isPluginSettingsAvailable(pluginId),
          // 有 `contributes.background` 就是无界面插件 —— 界面上要标出来，
          // 因为"改完没有即时反馈"对这类插件是正常的，对界面插件才是可疑的。
          //
          // 这里读**清单**而不是走宿主的 `plugin_background_contribution`：那个是
          // 异步的（它还要挡入口路径越界），而这一处只需要一个"有没有"的布尔。
          // 为一个角标引入一次异步往返，会让分组在首帧光秃秃、下一帧才补上，
          // 而"入口路径合法不合法"这件事在这一页根本用不到。
          headless: plugin ? hasBackgroundContribution(plugin.manifest.contributes) : false,
          items: getPluginSettingContributions(pluginId),
        };
      })
      // 只列仍然安装着的插件：pluginSettings 的清理是异步跟随插件列表的，
      // 中间那一帧不该让用户看到一个已经卸载的插件。
      .filter((group) => group.items.length > 0 && byId.has(group.pluginId))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [version]);

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;

    // 搜索同时匹配**名字**与**插件 id**：前者是用户记得的，后者是在清单、
    // 日志、市场地址里到处出现的那个。只匹配其中一个都会让一部分人搜不到。
    return groups.filter(
      (group) =>
        group.displayName.toLowerCase().includes(needle) ||
        group.pluginId.toLowerCase().includes(needle)
    );
  }, [groups, query]);

  const opened = openedPluginId
    ? (groups.find((group) => group.pluginId === openedPluginId) ?? null)
    : null;

  const handleChange = useCallback(
    async (pluginId: string, setting: SettingContribution, value: unknown) => {
      setError(null);
      try {
        await setPluginSetting(pluginId, setting.id, value);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`「${setting.label}」保存失败：${message}`);
        showToast({ title: '插件设置保存失败', body: `${setting.label}：${message}`, level: 'error' });
      }
    },
    []
  );

  const handleReset = useCallback(
    async (pluginId: string, items: SettingContribution[]) => {
      setError(null);
      try {
        for (const item of items) {
          if (item.default === undefined) continue;
          await setPluginSetting(pluginId, item.id, item.default);
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`恢复默认值失败：${message}`);
      }
    },
    []
  );

  if (groups.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900">插件设置</h3>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            这里显示已安装插件通过清单里的 <code className="px-1 py-0.5 bg-gray-100 rounded">contributes.settings</code>{' '}
            声明的设置项。当前没有任何插件声明设置。
          </p>
        </div>
        <div className="flex flex-col items-center justify-center py-12 rounded-xl border border-dashed border-gray-200">
          <Puzzle className="w-8 h-8 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">还没有可配置的插件设置</p>
          <p className="mt-1 text-[11px] text-gray-400 text-center max-w-xs leading-relaxed">
            插件的设置由它的清单决定，不需要执行插件代码 —— 因此即使装了上百个插件，
            打开这一页也不会因此变慢。
          </p>
          {onOpenPlugins ? (
            <button
              type="button"
              onClick={onOpenPlugins}
              className="mt-4 px-3.5 py-1.5 text-xs rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
            >
              去插件页
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // ---- 第二级：某一个插件的设置 ----
  if (opened) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpenedPluginId(null)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            全部插件
          </button>
        </div>

        <div>
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            {opened.displayName}
            {opened.headless ? <HeadlessBadge /> : null}
          </h3>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            {opened.pluginId}
            {opened.version ? ` · v${opened.version}` : ''}
            {opened.enabled ? '' : ' · 已禁用'}
          </p>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            设置值存在这个插件自己的存储里，与它的数据一起被备份、一起被卸载。
          </p>
        </div>

        {error ? <ErrorBanner message={error} /> : null}

        <PluginCard
          group={opened}
          onReset={handleReset}
          onChange={handleChange}
          onOpen={() => {}}
          showSettingsButton={false}
        />
      </div>
    );
  }

  // ---- 第一级：插件清单 ----
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">插件设置</h3>
        <p className="mt-1 text-xs text-gray-500 leading-relaxed">
          每个插件的设置值存在它自己的存储里，与插件数据一起被备份、一起被卸载。
          点一个插件进去改它。
        </p>
      </div>

      {groups.length > 4 ? (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按插件名或 id 过滤…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white/80 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {visibleGroups.length === 0 ? (
        <p className="py-8 text-center text-xs text-gray-400">
          没有匹配「{query}」的插件。
        </p>
      ) : (
        <div className="space-y-2">
          {visibleGroups.map((group) => (
            <PluginCard
              key={group.pluginId}
              group={group}
              onOpen={() => setOpenedPluginId(group.pluginId)}
              onReset={handleReset}
              onChange={handleChange}
              showSettingsButton
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** 无界面插件的标记。 */
const HeadlessBadge: React.FC = () => (
  <span
    title="这个插件没有界面，它的代码跑在一个独立的 Node 进程里"
    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 font-normal"
  >
    <Timer className="w-3 h-3" />
    后台
  </span>
);

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
    <p className="text-xs text-red-700 leading-relaxed">{message}</p>
  </div>
);

interface PluginCardProps {
  group: PluginGroup;
  /** 第一级：进入这个插件的设置。第二级时为空操作 */
  onOpen: () => void;
  /** `true` = 第一级（只显示摘要并可点进去）；`false` = 第二级（展开控件） */
  showSettingsButton: boolean;
  onReset: (pluginId: string, items: SettingContribution[]) => void;
  onChange: (pluginId: string, setting: SettingContribution, value: unknown) => void;
}

const PluginCard: React.FC<PluginCardProps> = ({
  group,
  onOpen,
  showSettingsButton,
  onReset,
  onChange,
}) => {
  const header = (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5">
          {group.displayName}
          {group.headless ? <HeadlessBadge /> : null}
        </p>
        <p className="text-[11px] text-gray-400 truncate">
          {group.pluginId}
          {group.version ? ` · v${group.version}` : ''}
          {group.enabled ? '' : ' · 已禁用'}
          {showSettingsButton ? ` · ${group.items.length} 项设置` : ''}
        </p>
      </div>

      {showSettingsButton ? (
        <span className="shrink-0 text-[11px] text-gray-400">修改 →</span>
      ) : (
        <button
          type="button"
          onClick={() => onReset(group.pluginId, group.items)}
          disabled={!group.available}
          title="把所有设置恢复到清单里声明的缺省值"
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          恢复默认
        </button>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200/70 bg-white/60 overflow-hidden">
      {showSettingsButton ? (
        // 整块可点：目标区域越大越好点，而"点进去看"是这个层级唯一要做的事。
        <button type="button" onClick={onOpen} className="w-full text-left hover:bg-gray-50/60 transition-colors">
          {header}
        </button>
      ) : (
        header
      )}

      {showSettingsButton ? null : (
        <>
          {!group.available ? (
            <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-50/70 border-b border-amber-100">
              <AlertCircle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-800 leading-relaxed">
                这个插件的设置读不到，通常是因为它的清单里没有声明{' '}
                <code className="px-1 bg-amber-100 rounded">storage</code> 权限。
                设置值存在插件自己的存储里，没有该权限就无法读写。
              </p>
            </div>
          ) : null}

          {group.headless ? (
            <div className="px-4 py-2.5 bg-gray-50/60 border-b border-gray-100">
              <p className="text-[11px] text-gray-600 leading-relaxed">
                它<strong className="font-medium">没有界面</strong>：这份设置就是它的全部交互。
                改完不会有即时反馈 —— 它要等下一次被唤醒才会按新值行事。
              </p>
            </div>
          ) : null}

          <div className="divide-y divide-gray-50">
            {group.items.map((item) => (
              <SettingRow
                key={item.id}
                pluginId={group.pluginId}
                setting={item}
                disabled={!group.available}
                onChange={onChange}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
};

interface SettingRowProps {
  pluginId: string;
  setting: SettingContribution;
  disabled: boolean;
  onChange: (pluginId: string, setting: SettingContribution, value: unknown) => void;
}

const SettingRow: React.FC<SettingRowProps> = ({ pluginId, setting, disabled, onChange }) => {
  // 值直接从 pluginSettings 同步读，不在组件里再放一份 `useState`。
  //
  // 理由：「设置」的真值只有一个（存储层）。把它镜像进组件状态就需要一套同步逻辑，
  // 而同步逻辑正是本项目反复踩坑的地方（见 useModuleList 的注释）。
  // 重渲染由父组件的 `subscribePluginSettings` 驱动，因此这里读到的总是最新值。
  const value = getPluginSetting(pluginId, setting.id);

  const control = (() => {
    switch (setting.type) {
      case 'boolean':
        return (
          <Toggle
            checked={value === true}
            disabled={disabled}
            onChange={(next) => onChange(pluginId, setting, next)}
          />
        );
      case 'number':
        return (
          <input
            type="number"
            disabled={disabled}
            min={setting.min}
            max={setting.max}
            step={setting.step}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(pluginId, setting, raw === '' ? undefined : Number(raw));
            }}
            className="w-32 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white/80 text-gray-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        );
      case 'select':
        return (
          <select
            disabled={disabled}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(event) => onChange(pluginId, setting, event.target.value)}
            className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white/80 text-gray-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          >
            {(setting.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        );
      default:
        return (
          <input
            type="text"
            disabled={disabled}
            placeholder={setting.placeholder}
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(event) => onChange(pluginId, setting, event.target.value)}
            className="w-56 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 bg-white/80 text-gray-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        );
    }
  })();

  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <label className="text-sm text-gray-800">{setting.label}</label>
        {setting.description ? (
          <p className="mt-0.5 text-[11px] text-gray-400 leading-relaxed">{setting.description}</p>
        ) : null}
        <p className="mt-0.5 text-[10px] text-gray-300 font-mono">{setting.id}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
};

export default PluginSettingsSection;
