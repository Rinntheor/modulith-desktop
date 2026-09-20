// scripts/harness/resolve-hook.mjs
//
// 给省略了扩展名的相对 / `@/` 说明符补上 `.ts` / `.tsx` / `.js`。
//
// 只在**默认解析失败之后**才介入：带扩展名的说明符、以及 node_modules 里的包
// 全部走 Node 自己的解析，因此这个钩子不会改变任何既有行为，只多兜住那一种情况。

import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolvePath(here, '..', '..');

/** 与 tsconfig 的 `paths` 保持一致；目前运行时依赖图里用不到，但留着更安全 */
const ALIAS_PREFIX = '@/';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const isAlias = specifier.startsWith(ALIAS_PREFIX);
    if (!specifier.startsWith('.') && !isAlias) throw error;

    const base = isAlias
      ? pathToFileURL(resolvePath(projectRoot, 'src', specifier.slice(ALIAS_PREFIX.length))).href
      : specifier;

    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(base + extension, context);
      } catch {
        // 试下一个扩展名
      }
    }

    throw error;
  }
}
