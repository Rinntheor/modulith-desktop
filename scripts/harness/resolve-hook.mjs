// scripts/harness/resolve-hook.mjs
//
// 给省略了扩展名的相对 / `@/` 说明符补上 `.ts` / `.tsx` / `.js`，
// 并让 Vite 会处理成 URL 的资源 import 在 Node 里也能求值。
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

/**
 * Vite 会把资源 import 变成一个地址字符串，而 Node 对 `.mp3` 这类扩展名直接抛
 * `ERR_UNKNOWN_FILE_EXTENSION`。
 *
 * 这件事在 1.3.2 真的发生过一次，而它的表现极具误导性：`src/services/sound.ts`
 * 加了一行 `import bundledSoundUrl from '../assets/notification.mp3'`（内置默认
 * 提示音），于是**整条 `pluginRuntime` 依赖图在夹具里都加载不了** ——
 * `check-plugin-runtime` 与 `check-net-guard` 双双失败，报的却是一个与插件运行时
 * 毫无关系的文件扩展名错误。
 *
 * 这里把它变成一个占位地址。**不读取文件内容**：夹具断言的是宿主行为，
 * 不是音频字节，也没有任何地方会真的播放它。
 */
const ASSET_EXTENSIONS = [
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.webm',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
];

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

export async function load(url, context, nextLoad) {
  const pathname = url.startsWith('file:') ? new URL(url).pathname.toLowerCase() : '';
  if (ASSET_EXTENSIONS.some((extension) => pathname.endsWith(extension))) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(pathname)};`,
    };
  }
  return nextLoad(url, context);
}
