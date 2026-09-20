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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Puzzle, RotateCcw } from 'lucide-react';
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
import { showToast } from '../../services/toast';
import type { SettingContribution } from '../../types/plugin';

interface PluginSettingsSectionProps {
  /** 跳到「插件」分页（空状态与不可用时用） */
  onOpenPlugins?: () => void;
}

const PluginSettingsSection: React.FC<PluginSettingsSectionProps> = ({ onOpenPlugins }) => {
  // 两个订阅缺一不可：插件列表变了要重建分组（装了/卸了/启用了），
  // 设置值变了要刷新控件（可能是插件自己写的）。
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    const unsubscribePlugins = subscribePlugins(bump);
    const unsubscribeSettings = subscribePluginSettings(bump);
    return () => {
      unsubscribePlugins();
      unsubscribeSettings();
    };
  }, []);

  const groups = useMemo(() => {
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
          items: getPluginSettingContributions(pluginId),
        };
      })
      // 只列仍然安装着的插件：pluginSettings 的清理是异步跟随插件列表的，
      // 中间那一帧不该让用户看到一个已经卸载的插件。
      .filter((group) => group.items.length > 0 && byId.has(group.pluginId))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [version]);

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

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">插件设置</h3>
        <p className="mt-1 text-xs text-gray-500 leading-relaxed">
          每个插件的设置值存在它自己的存储里，与插件数据一起被备份、一起被卸载。
        </p>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5">
          <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
          <p className="text-xs text-red-700 leading-relaxed">{error}</p>
        </div>
      ) : null}

      {groups.map((group) => (
        <div
          key={group.pluginId}
          className="rounded-xl border border-gray-200/70 bg-white/60 overflow-hidden"
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">{group.displayName}</p>
              <p className="text-[11px] text-gray-400 truncate">
                {group.pluginId}
                {group.version ? ` · v${group.version}` : ''}
                {group.enabled ? '' : ' · 已禁用'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleReset(group.pluginId, group.items)}
              disabled={!group.available}
              title="把所有设置恢复到清单里声明的缺省值"
              className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              恢复默认
            </button>
          </div>

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

          <div className="divide-y divide-gray-50">
            {group.items.map((item) => (
              <SettingRow
                key={item.id}
                pluginId={group.pluginId}
                setting={item}
                disabled={!group.available}
                onChange={handleChange}
              />
            ))}
          </div>
        </div>
      ))}
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
