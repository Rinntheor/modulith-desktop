// scripts/release-manifest.ts
// 应用更新清单（latest.json）的构建逻辑 —— 被两个入口共用
//
//   scripts/generate-latest-json.ts   只生成清单（pnpm release:manifest）
//   scripts/release.ts                构建 + 生成清单（pnpm release）
//
// 为什么单独成模块：两个入口必须写出**逐字节一致**的清单。若把逻辑留在任一 CLI 里，
// 另一处就只能复制一份 —— 而复制品迟早与原件不一致，表现为「两条命令生成的更新清单不同」。
// 这种差异不会在本地暴露，只在真机更新时以「下不动 / 验签失败」的形式出现。
//
// 本模块不打印、不 process.exit、不解析命令行：它只做决策并抛错，由调用方决定怎么报告。
//
// 五件必须说清的事：
//
// 1. **签名文件从哪来。** 只有当 `tauri.conf.json` 的 `bundle.createUpdaterArtifacts`
//    为 true（默认是 false）且构建时设置了 `TAURI_SIGNING_PRIVATE_KEY` 与
//    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，tauri 才会在安装包旁边写出 `<安装包>.sig`。
//    缺任何一项，构建照样成功、安装包照样产出，只是没有 `.sig` —— 所以这里坚持直接失败，
//    而不是生成一份装不上的清单。
//
//    注意变量名：`TAURI_SIGNING_PRIVATE_KEY` 的值**可以是密钥文件的路径**，tauri 自己
//    判断「这是路径还是内容」。而 `TAURI_SIGNING_PRIVATE_KEY_PATH` 是 `tauri signer sign`
//    和 `tauri plugin init` 用的，**构建链路完全不读** —— 设了它只会得到
//    「A public key has been found, but no private key」。
//
// 2. **只写具体的 target 键，不写 `windows-x86_64` 兜底键。**
//    tauri 在构建时把安装包类型以**二进制补丁**写进可执行文件（`__TAURI_BUNDLE_TYPE`），
//    因此真实安装的应用一定知道自己是被 MSI 还是 NSIS 装的，`windows-x86_64-msi` /
//    `-nsis` 必然匹配得上。兜底键一旦被用到，说明类型未知（开发构建）——那时按兜底键
//    装上另一种安装器，会让用户机器上留下两份安装记录，比直接报错更糟。
//
// 3. **按版本号挑安装包，而不是按时间挑。** `tauri build` 从不清空 `bundle/`，
//    它跨版本累积产物：1.0.0 到 1.1.1 的安装包会同时躺在那里。「取最新的一个」
//    在构建时间被复制、还原或调整系统时间时会静默发布错包，而这里只认文件名里的
//    `_<版本>_`，对不上就报错。
//
// 4. **资源名必须百分号编码。** `productName` 里带空格，GitHub 的资源下载地址要把空格
//    写成 `%20`，否则 404。这是最容易被忽略、又只在真机上才暴露的一处。
//
// 5. **`pub_date` 用当前时间。** 它是给界面显示的元信息，不是可复现构建的一部分；
//    每发布一次生成一次，重复生成产生差异是正常的。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readVersionFile } from './version-manager.ts';

/** 仓库根目录 */
export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 发布资源的基地址。
 *
 * 与 `tauri.conf.json` 里 `plugins.updater.endpoints` 指向的 `latest.json` 是同一个
 * release：`releases/latest/download/latest.json` 永远指向最新一次发布，而安装包在
 * 那一次发布的 `releases/download/<tag>/` 下。
 */
export const DEFAULT_BASE_URL = 'https://github.com/Rinntheor/modulith-desktop/releases/download';

/** 安装包类型 → bundle 子目录、扩展名、以及 latest.json 里的 target 键 */
export const INSTALLERS = [
  { dir: 'msi', suffix: '.msi', target: 'windows-x86_64-msi' },
  { dir: 'nsis', suffix: '.exe', target: 'windows-x86_64-nsis' },
] as const;

export type InstallerSpec = (typeof INSTALLERS)[number];

export interface PackagedInstaller {
  target: string;
  file: string;
  signature: string;
  /** 同目录里被忽略的其他安装包（旧版本遗留），由调用方决定是否提示 */
  ignored: string[];
}

/** 默认的构建产物目录 */
export function defaultBundleDir(): string {
  return join(ROOT, 'src-tauri', 'target', 'release', 'bundle');
}

/** 默认的清单输出路径 */
export function defaultOutPath(): string {
  return join(ROOT, 'release', 'latest.json');
}

/**
 * 读取当前版本号。
 *
 * 走 `version.toml` 而不是读 `package.json` / `tauri.conf.json`：后者是同步的**结果**，
 * 三者不一致时以 `version.toml` 为准才是唯一说得通的解释。
 */
export function readAppVersion(): string {
  return readVersionFile().app.version;
}

/** 安装包文件名里标识版本的片段 */
function versionMarker(version: string): string {
  return `_${version}_`;
}

/** 列出目录里符合该安装器类型的候选文件（`.sig` 不匹配这些后缀，不会被算进来） */
function listCandidates(dir: string, suffix: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(suffix))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

/**
 * 在 bundle 目录里找到该类型、该版本的安装包，并读取它旁边的签名。
 *
 * 多个候选时的取舍见文件头第 3 条：只认文件名里带当前版本号的。
 */
export function collectInstaller(
  bundleDir: string,
  spec: InstallerSpec,
  version: string,
): PackagedInstaller {
  const dir = join(bundleDir, spec.dir);
  if (!existsSync(dir)) {
    throw new Error(
      `找不到 ${spec.dir} 产物目录：${dir}\n` +
        '先执行带签名环境变量的构建：pnpm release（或 pnpm tauri build）。',
    );
  }

  const all = listCandidates(dir, spec.suffix);
  if (all.length === 0) {
    throw new Error(`${dir} 里没有 ${spec.suffix} 文件。`);
  }

  const marker = versionMarker(version);
  const mine = all.filter((path) => basename(path).includes(marker));
  const ignored = all.filter((path) => !mine.includes(path));

  if (mine.length === 0) {
    throw new Error(
      `${dir} 里有 ${all.length} 个 ${spec.suffix} 文件，但没有一个是 ${version} 的：\n` +
        all.map((path) => `  ${basename(path)}`).join('\n') +
        `\n文件名里应当含 ${marker}。先构建 ${version}，或清理该目录里的旧版本产物。`,
    );
  }
  if (mine.length > 1) {
    // 同一版本出现多个安装包才是真正可疑的（构建中断、手工改名、多个架构并存），
    // 这时猜一个是最坏的做法 —— 猜错会把错误的包写进更新清单。
    throw new Error(
      `${dir} 里有多个 ${version} 的 ${spec.suffix} 文件，无法确定发布哪一个：\n` +
        mine.map((path) => `  ${basename(path)}`).join('\n') +
        '\n请清理该目录后重新构建。',
    );
  }

  const file = mine[0];
  const sigPath = `${file}.sig`;
  if (!existsSync(sigPath)) {
    throw new Error(
      `缺少签名文件：${basename(sigPath)}\n` +
        '它由带签名的构建产出，需要同时满足三个条件：\n' +
        '  1. tauri.conf.json 的 bundle.createUpdaterArtifacts 为 true；\n' +
        '  2. 设置了 TAURI_SIGNING_PRIVATE_KEY（值可以是密钥文件路径）；\n' +
        '  3. 设置了 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。\n' +
        '没有签名的更新包会被客户端拒绝安装，因此这里直接失败。',
    );
  }

  return {
    target: spec.target,
    file: basename(file),
    // .sig 文件的内容本身就是 base64，直接放进清单，不要解码 ——
    // 客户端会先对它做 base64 解码再交给 minisign 验签。
    signature: readFileSync(sigPath, 'utf8').trim(),
    ignored: ignored.map((path) => basename(path)),
  };
}

/**
 * 列出 bundle 目录里不属于当前版本的安装包与签名。
 *
 * 这些是 `tauri build` 攒下的旧版本产物。它们不影响正确性（`collectInstaller` 会按
 * 版本号过滤），但会让目录一年后变成几十个 G，也让「发布的是哪个包」更难用眼看出来，
 * 所以 `pnpm release` 在构建前顺手删掉它们。
 */
export function findStaleInstallers(bundleDir: string, version: string): string[] {
  const marker = versionMarker(version);
  const stale: string[] = [];

  for (const spec of INSTALLERS) {
    const dir = join(bundleDir, spec.dir);
    if (!existsSync(dir)) continue;

    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      if (name.includes(marker)) continue;
      // 只碰安装包与它们的签名，别的一概不动
      if (!/\.(msi|exe)(\.sig)?$/i.test(name)) continue;
      stale.push(path);
    }
  }

  return stale;
}

/**
 * 从 `CHANGELOG.md` 里取出该版本的段落，作为更新说明。
 *
 * `pnpm ver bump` 已经按提交写好了这一段。让更新说明来自它，是为了避免
 * 「CHANGELOG 里写了、更新弹窗里却是空白」这种两处各说各话的情况。
 */
export function readNotesFromChangelog(version: string, changelogPath = join(ROOT, 'CHANGELOG.md')): string | null {
  if (!existsSync(changelogPath)) return null;

  const text = readFileSync(changelogPath, 'utf8');
  const heading = `## [${version}]`;
  const start = text.indexOf(heading);
  if (start === -1) return null;

  const rest = text.slice(start);
  const next = rest.indexOf('\n## [', heading.length);
  const section = next === -1 ? rest : rest.slice(0, next);
  const body = section.slice(section.indexOf('\n')).trim();

  return body || null;
}

export interface NotesOptions {
  version: string;
  notes?: string | null;
  notesFile?: string | null;
  changelogPath?: string;
}

export interface ResolvedNotes {
  text: string;
  source: 'inline' | 'file' | 'changelog' | 'none';
}

/** 决定更新说明正文：`--notes` > `--notes-file` > CHANGELOG.md 的该版本段落 */
export function resolveNotes(options: NotesOptions): ResolvedNotes {
  if (options.notes) return { text: options.notes.trim(), source: 'inline' };

  if (options.notesFile) {
    if (!existsSync(options.notesFile)) {
      throw new Error(`找不到发布说明文件：${options.notesFile}`);
    }
    const text = readFileSync(options.notesFile, 'utf8').trim();
    if (!text) throw new Error(`发布说明文件是空的：${options.notesFile}`);
    return { text, source: 'file' };
  }

  const fromChangelog = readNotesFromChangelog(options.version, options.changelogPath);
  if (fromChangelog) return { text: fromChangelog, source: 'changelog' };

  return { text: '', source: 'none' };
}

export interface ManifestPlatform {
  url: string;
  signature: string;
}

export interface Manifest {
  version: string;
  notes?: string;
  pub_date: string;
  platforms: Record<string, ManifestPlatform>;
}

export interface ManifestOptions {
  bundleDir: string;
  version: string;
  notes?: string;
  baseUrl?: string;
}

export interface BuiltManifest {
  version: string;
  tag: string;
  installers: PackagedInstaller[];
  manifest: Manifest;
}

/** 组装更新清单。找不到安装包或缺签名时抛错，不会返回半成品。 */
export function buildManifest(options: ManifestOptions): BuiltManifest {
  const { bundleDir, version } = options;
  const notes = options.notes ?? '';
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const tag = `v${version}`;

  const installers = INSTALLERS.map((spec) => collectInstaller(bundleDir, spec, version));

  const platforms: Record<string, ManifestPlatform> = {};
  for (const installer of installers) {
    platforms[installer.target] = {
      // encodeURIComponent 把文件名里的空格写成 %20 —— GitHub 的资源地址必须这样写
      url: `${baseUrl}/${tag}/${encodeURIComponent(installer.file)}`,
      signature: installer.signature,
    };
  }

  return {
    version,
    tag,
    installers,
    manifest: {
      version,
      ...(notes ? { notes } : {}),
      pub_date: new Date().toISOString(),
      platforms,
    },
  };
}

/** 写出清单；父目录不存在时创建 */
export function writeManifest(out: string, manifest: Manifest): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** 删除旧版本的安装包与签名，返回被删掉的文件名 */
export function removeStaleInstallers(bundleDir: string, version: string): string[] {
  const stale = findStaleInstallers(bundleDir, version);
  for (const path of stale) {
    rmSync(path, { force: true });
  }
  return stale;
}
