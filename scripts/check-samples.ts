// scripts/check-samples.ts
//
// 检查 samples/ 下的示例插件是否「清单与代码一致」。
//
// 为什么需要这个检查：权限现在真的会被强制，因此**清单少写一项**
// 不会在构建期报错，只会在用户点到那个功能时失败 —— 而写这个插件的人
// 早就忘了自己用了哪几个 ctx.*。反过来，**多写一项**会让用户在插件详情里
// 看到一条并不存在的能力，属于误导。
//
// 两种都算失败，命令以非零退出码结束。
//
// 检查两项：
//   1. 代码里用到的每个 ctx.<服务>，其所需权限都已在清单中声明；
//   2. 清单里声明的每一项权限，代码里都确实用到了。
//   3. 窗口级监听（window.addEventListener）必须配合 useModuleActive() 使用，
//      否则会在其它模块里也生效。
//
// 用法：node scripts/check-samples.ts

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  printTitle,
  printSuccess,
  printError,
  printWarning,
  printKeyValue,
} from './colors.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SAMPLES_DIR = join(PROJECT_ROOT, 'samples');

/**
 * `ctx.<服务>` 各自需要哪项权限。
 *
 * 新宿主服务出现时要在这里补一行 —— 漏掉的话，用到它的插件会被报成
 * 「未知服务」，那是个响亮的失败，比静默放行好。
 */
const SERVICE_PERMISSION: Record<string, string | null> = {
  storage: 'storage',
  http: 'network',
  launcher: 'process-spawn',
  icons: 'filesystem-read',
  shell: 'filesystem-read',
  fileDrop: 'filesystem-read',
  audio: 'filesystem-read',
  notifications: 'notification',
  events: 'plugin-communicate',
  logger: null,
};

interface Finding {
  plugin: string;
  message: string;
}

function main(): void {
  printTitle('Modulith Desktop · Sample Plugin Check');

  if (!existsSync(SAMPLES_DIR)) {
    printError('找不到 samples 目录', SAMPLES_DIR);
    process.exit(1);
  }

  const plugins = readdirSync(SAMPLES_DIR).filter((name) =>
    existsSync(join(SAMPLES_DIR, name, 'manifest.json'))
  );

  if (plugins.length === 0) {
    printError('samples/ 下没有找到任何插件', '至少应当有一个示例');
    process.exit(1);
  }

  const findings: Finding[] = [];

  for (const plugin of plugins) {
    const dir = join(SAMPLES_DIR, plugin);
    const code = readFileSync(join(dir, 'index.js'), 'utf-8');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as {
      permissions?: string[];
    };
    const declared = new Set(manifest.permissions ?? []);

    // ---- 1. 代码用到的服务 → 需要的权限 ----
    const required = new Set<string>();
    let unknown: string | null = null;

    for (const match of code.matchAll(/\bctx\.([a-zA-Z]+)\b/g)) {
      const service = match[1];
      if (!(service in SERVICE_PERMISSION)) {
        unknown = service;
        continue;
      }
      const permission = SERVICE_PERMISSION[service];
      if (permission) required.add(permission);
    }

    if (unknown) {
      findings.push({
        plugin,
        message: `代码里出现了未知的上下文成员 ctx.${unknown} —— 若这是新加的服务，请在 SERVICE_PERMISSION 里补一行`,
      });
    }

    const missing = [...required].filter((p) => !declared.has(p)).sort();
    const unused = [...declared].filter((p) => !required.has(p)).sort();

    if (missing.length > 0) {
      findings.push({
        plugin,
        message: `代码用到了 ${missing.join('、')}，但清单没有声明 —— 该功能会在运行时被拒绝`,
      });
    }
    if (unused.length > 0) {
      findings.push({
        plugin,
        message: `清单声明了 ${unused.join('、')}，但代码里没有用到 —— 会让用户看到一条并不存在的能力`,
      });
    }

    // ---- 2. 窗口级监听必须判断模块可见性 ----
    const hasWindowListener = /window\.addEventListener\(/.test(code);
    if (hasWindowListener && !/useModuleActive\(\)/.test(code)) {
      findings.push({
        plugin,
        message:
          '使用了 window.addEventListener 但没有 useModuleActive() 判断 —— 窗口级监听会在其它模块里也生效（抢快捷键或抢拖放）',
      });
    }

    const detail = [...required].sort().join(', ') || '（不需要权限）';
    printKeyValue(plugin, detail);
  }

  console.log('');

  if (findings.length === 0) {
    printSuccess('检查通过', `${plugins.length} 个示例插件的清单与代码一致`);
    return;
  }

  for (const finding of findings) {
    printWarning(finding.plugin, finding.message);
  }

  console.log('');
  printError('检查未通过', `${findings.length} 处不一致，详见上方`);
  process.exit(1);
}

main();
