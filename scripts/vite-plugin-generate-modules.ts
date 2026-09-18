// scripts/vite-plugin-generate-modules.ts
//
// Vite 插件：在开发/构建过程中自动维护前端模块注册表。
//
//   - 启动时生成一次
//   - 开发模式下监听 src/modules 内的 module.toml 与组件文件
//   - 通过「内容指纹」判断是否真的有变化，避免无谓的重复生成与整页刷新
//
// 之前的问题：监听范围只有 module.toml，组件文件的新增/删除不会触发重新生成；
// 同时每次 buildStart 都会无条件重新生成。这里改为对文件集合计算指纹。

import type { Plugin } from 'vite';
import { generateModules } from './generate-modules.ts';
import {
  c,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printStep,
} from './colors.ts';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MODULES_SUBDIR = ['src', 'modules'];
const WATCH_EXTS = ['.toml', '.tsx', '.ts', '.css'];

/** 上次生成时模块目录的内容指纹 */
let lastFingerprint = '';
let hasGenerated = false;

/**
 * 递归计算 src/modules 下相关文件的内容指纹。
 * 使用「大小 + mtime」而非文件内容，成本低且足以发现改动。
 */
function computeFingerprint(): string {
  const modulesDir = join(process.cwd(), ...MODULES_SUBDIR);
  if (!existsSync(modulesDir)) return '';

  const parts: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else if (WATCH_EXTS.some((ext) => entry.endsWith(ext))) {
        const rel = relative(modulesDir, full).split(sep).join('/');
        parts.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };

  walk(modulesDir);
  parts.sort();
  return parts.join('|');
}

/** 仅当模块目录确实变化时才重新生成 */
function regenerateIfChanged(reason: string): boolean {
  const fingerprint = computeFingerprint();

  if (fingerprint === lastFingerprint) {
    return false;
  }

  printStep(`Modules ${reason}`, 'regenerating registry');
  try {
    generateModules();
    lastFingerprint = computeFingerprint();
    printSuccess('Module registry regenerated');
    return true;
  } catch (err) {
    printError('Failed to regenerate module registry', String(err));
    return false;
  }
}

export function vitePluginGenerateModules(): Plugin {
  return {
    name: 'vite-plugin-generate-modules',
    // 需要在其它插件读取 src/generated 之前完成生成
    enforce: 'pre',

    buildStart() {
      if (hasGenerated) {
        // watch 模式下后续构建：只有变化时才重新生成
        regenerateIfChanged('changed');
        return;
      }

      printStep('Generating module registry', '(initial build)');
      try {
        generateModules();
        lastFingerprint = computeFingerprint();
        hasGenerated = true;
        printSuccess('Module registry generated');
      } catch (err) {
        // 生成失败必须让构建失败，否则会带着陈旧的注册表继续打包
        printError('Failed to generate module registry', String(err));
        throw err;
      }
    },

    configureServer(devServer) {
      import('chokidar')
        .then(({ default: chokidar }) => {
          const watcher = chokidar.watch(`src/modules/**/*.{toml,tsx,ts,css}`, {
            ignored: /node_modules/,
            persistent: true,
            ignoreInitial: true,
          });

          let timer: NodeJS.Timeout | null = null;

          const schedule = (filePath: string, event: string): void => {
            if (timer) clearTimeout(timer);

            // 防抖：编辑器保存常触发多次事件
            timer = setTimeout(() => {
              timer = null;
              const rel = relative(process.cwd(), filePath).split(sep).join('/');
              printInfo(`Module ${event}`, rel);

              if (regenerateIfChanged(event)) {
                devServer.ws.send({ type: 'full-reload' });
                printInfo('Reloading browser');
              } else {
                printInfo('No registry-relevant change, skipping reload');
              }
            }, 120);
          };

          watcher.on('change', (p: string) => schedule(p, 'changed'));
          watcher.on('add', (p: string) => schedule(p, 'added'));
          watcher.on('unlink', (p: string) => schedule(p, 'removed'));

          devServer.httpServer?.on('close', () => {
            if (timer) clearTimeout(timer);
            watcher.close();
          });
        })
        .catch((err: Error) => {
          printWarning('chokidar not available', 'module hot-reload disabled');
          console.log(`  ${c.dim(err.message)}`);
        });
    },
  };
}
