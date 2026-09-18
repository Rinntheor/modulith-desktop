// scripts/generate-latest-json.ts
// 生成应用更新清单 latest.json
//
//   node scripts/generate-latest-json.ts
//   node scripts/generate-latest-json.ts --notes-file ./release/notes.md
//   node scripts/generate-latest-json.ts --bundle-dir <目录> --out <文件>   # 测试用
//
// 输入：
//   - `version.toml` 的 `[app] version`（版本的唯一事实来源）
//   - `<bundle-dir>/msi/*.msi` 与 `<bundle-dir>/nsis/*.exe`，以及各自旁边的 `.sig`
//
// 输出：`release/latest.json`（默认，被 .gitignore 忽略 —— 它是发布产物，不是源码）
//
// 四件必须说清的事：
//
// 1. **签名文件从哪来。** 带 `TAURI_SIGNING_PRIVATE_KEY`（与
//    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）构建时，tauri 会在安装包旁边写出
//    `<安装包>.sig`。没有签名就没有可用的更新清单 —— 签名是"这个更新包确实由我们签发"
//    的唯一依据，缺了它客户端验签必然失败。
//
// 2. **只写具体的 target 键，不写 `windows-x86_64` 兜底键。**
//    tauri 在构建时把安装包类型以**二进制补丁**写进可执行文件（`__TAURI_BUNDLE_TYPE`），
//    因此真实安装的应用一定知道自己是被 MSI 还是 NSIS 装的，`windows-x86_64-msi` /
//    `-nsis` 必然匹配得上。兜底键一旦被用到，说明类型未知（开发构建）——那时按兜底键
//    装上另一种安装器，会让用户机器上留下两份安装记录，比直接报错更糟。
//
// 3. **资源名必须百分号编码。** `productName` 里带空格，GitHub 的资源下载地址要把空格
//    写成 `%20`，否则 404。这是最容易被忽略、又只在真机上才暴露的一处。
//
// 4. **`pub_date` 用当前时间。** 它是给界面显示的元信息，不是可复现构建的一部分；
//    每发布一次生成一次，重复生成产生差异是正常的。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * 发布资源的基地址。
 *
 * 与 `tauri.conf.json` 里 `plugins.updater.endpoints` 指向的 `latest.json` 是同一个
 * release：`releases/latest/download/latest.json` 永远指向最新一次发布，而安装包在
 * 那一次发布的 `releases/download/<tag>/` 下。
 */
const DEFAULT_BASE_URL = 'https://github.com/Rinntheor/modulith-desktop/releases/download';

/** 安装包类型 → bundle 子目录、扩展名、以及 latest.json 里的 target 键 */
const INSTALLERS = [
  { dir: 'msi', suffix: '.msi', target: 'windows-x86_64-msi' },
  { dir: 'nsis', suffix: '.exe', target: 'windows-x86_64-nsis' },
] as const;

interface Args {
  baseUrl: string;
  out: string;
  bundleDir: string;
  notesFile: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };

  return {
    baseUrl: get('--base-url') ?? DEFAULT_BASE_URL,
    out: get('--out') ?? join(ROOT, 'release', 'latest.json'),
    bundleDir: get('--bundle-dir') ?? join(ROOT, 'src-tauri', 'target', 'release', 'bundle'),
    notesFile: get('--notes-file'),
  };
}

/**
 * 读取 `version.toml` 的 `[app] version`。
 *
 * 只在 `[app]` 段里找：`[build]` 段还有一个 `full_version`，用宽松的正则会随文件格式
 * 变化而匹配到错误的值。
 */
function readAppVersion(): string {
  const text = readFileSync(join(ROOT, 'version.toml'), 'utf8');
  const appBlock = text.split(/^\[/m).find((block) => block.startsWith('app]'));
  const match = appBlock ? /^\s*version\s*=\s*"([^"]+)"/m.exec(appBlock) : null;
  if (!match) throw new Error('version.toml 里找不到 [app] 段的 version');
  return match[1];
}

interface PackagedInstaller {
  target: string;
  file: string;
  signature: string;
}

/** 在 bundle 目录里找到该类型的安装包，并读取它旁边的签名 */
function collectInstaller(bundleDir: string, spec: (typeof INSTALLERS)[number]): PackagedInstaller {
  const dir = join(bundleDir, spec.dir);
  if (!existsSync(dir)) {
    throw new Error(
      `找不到 ${spec.dir} 产物目录：${dir}\n先执行 pnpm tauri build（并设置签名环境变量）。`
    );
  }

  const candidates = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(spec.suffix))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());

  if (candidates.length === 0) {
    throw new Error(`${dir} 里没有 ${spec.suffix} 文件`);
  }
  if (candidates.length > 1) {
    // 多个候选说明目录里混着旧版本的产物。这时猜一个是最坏的做法 ——
    // 猜错会把上一个版本的包写进更新清单。
    throw new Error(
      `${dir} 里有多个 ${spec.suffix} 文件，无法确定发布哪一个：\n` +
        candidates.map((path) => `  ${basename(path)}`).join('\n') +
        '\n请清理该目录后重新构建。'
    );
  }

  const file = candidates[0];
  const sigPath = `${file}.sig`;
  if (!existsSync(sigPath)) {
    throw new Error(
      `缺少签名文件：${basename(sigPath)}\n` +
        '构建时未设置 TAURI_SIGNING_PRIVATE_KEY。没有签名的更新包会被客户端拒绝安装，' +
        '因此这里直接失败，而不是生成一份装不上的清单。'
    );
  }

  return {
    target: spec.target,
    file: basename(file),
    // .sig 文件的内容本身就是 base64，直接放进清单，不要解码 ——
    // 客户端会先对它做 base64 解码再交给 minisign 验签。
    signature: readFileSync(sigPath, 'utf8').trim(),
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(join(ROOT, 'version.toml'))) {
    console.error('找不到 version.toml，请从仓库根目录运行本脚本。');
    return 1;
  }

  const version = readAppVersion();
  const tag = `v${version}`;

  let installers: PackagedInstaller[];
  try {
    installers = INSTALLERS.map((spec) => collectInstaller(args.bundleDir, spec));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let notes = '';
  if (args.notesFile) {
    if (!existsSync(args.notesFile)) {
      console.error(`找不到发布说明文件：${args.notesFile}`);
      return 1;
    }
    notes = readFileSync(args.notesFile, 'utf8').trim();
  }

  const platforms: Record<string, { url: string; signature: string }> = {};
  for (const installer of installers) {
    platforms[installer.target] = {
      // encodeURIComponent 把文件名里的空格写成 %20 —— GitHub 的资源地址必须这样写
      url: `${args.baseUrl}/${tag}/${encodeURIComponent(installer.file)}`,
      signature: installer.signature,
    };
  }

  const manifest = {
    version,
    ...(notes ? { notes } : {}),
    pub_date: new Date().toISOString(),
    platforms,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`版本 ${version}（tag ${tag}）`);
  console.log('已包含的安装包：');
  for (const installer of installers) {
    console.log(`  ${installer.target}`);
    console.log(`    ${installer.file}`);
    console.log(`    ${platforms[installer.target].url}`);
  }
  if (!notes) {
    console.log('\n注意：没有发布说明。界面上的更新卡片会显示空白 —— 需要的话用');
    console.log('      --notes-file <文件> 传入。');
  }
  console.log(`\n已写入 ${args.out}`);
  console.log('\n下一步：把这个文件与上面两个安装包一起上传到 GitHub Release，tag 用 ' + tag + '。');
  return 0;
}

process.exit(main());
