// scripts/generate-latest-json.ts
// 生成应用更新清单 latest.json
//
//   pnpm release:manifest
//   pnpm release:manifest --notes-file release/notes.md
//   pnpm release:manifest --notes "修好了启动崩溃"
//   pnpm release:manifest --bundle-dir <目录> --out <文件>   # 测试用
//
// 输入：
//   - `version.toml` 的 `[app] version`（版本的唯一事实来源）
//   - `<bundle-dir>/msi/*.msi` 与 `<bundle-dir>/nsis/*.exe`，以及各自旁边的 `.sig`
//
// 输出：`release/latest.json`（默认，被 .gitignore 忽略 —— 它是发布产物，不是源码）
//
// 更新说明依次尝试：`--notes` > `--notes-file` > `CHANGELOG.md` 里该版本的段落。
//
// 所有决策（挑哪个安装包、写哪些 target 键、URL 怎么编码）都在 `release-manifest.ts`，
// 与 `pnpm release` 共用同一份实现 —— 两条命令生成的清单必须完全一致。
// 完整的取舍理由见那个文件的头部注释。
//
// 只想一条命令走完「构建 + 清单」，用 `pnpm release`。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { c } from './colors.ts';
import {
  ROOT,
  buildManifest,
  defaultBundleDir,
  defaultOutPath,
  readAppVersion,
  resolveNotes,
  writeManifest,
} from './release-manifest.ts';

interface Args {
  baseUrl: string | null;
  out: string;
  bundleDir: string;
  notes: string | null;
  notesFile: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };

  return {
    baseUrl: get('--base-url'),
    out: get('--out') ?? defaultOutPath(),
    bundleDir: get('--bundle-dir') ?? defaultBundleDir(),
    notes: get('--notes'),
    notesFile: get('--notes-file'),
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(join(ROOT, 'version.toml'))) {
    console.error('找不到 version.toml，请从仓库根目录运行本脚本。');
    return 1;
  }

  try {
    const version = readAppVersion();
    const notes = resolveNotes({
      version,
      notes: args.notes,
      notesFile: args.notesFile,
    });

    const built = buildManifest({
      bundleDir: args.bundleDir,
      version,
      notes: notes.text,
      baseUrl: args.baseUrl ?? undefined,
    });

    writeManifest(args.out, built.manifest);

    console.log(`版本 ${version}（tag ${built.tag}）`);
    console.log('已包含的安装包：');
    for (const installer of built.installers) {
      console.log(`  ${installer.target}`);
      console.log(`    ${installer.file}`);
      console.log(`    ${built.manifest.platforms[installer.target].url}`);
      if (installer.ignored.length > 0) {
        console.log(
          `    ${c.dim(`（同目录还有 ${installer.ignored.length} 个旧版本产物，已忽略）`)}`,
        );
      }
    }

    if (notes.source === 'none') {
      console.log('\n注意：没有发布说明。界面上的更新卡片会显示空白 —— 需要的话用');
      console.log('      --notes "<文字>" 或 --notes-file <文件> 传入。');
    } else if (notes.source === 'changelog') {
      console.log(`\n发布说明取自 CHANGELOG.md 的 [${version}] 段落。`);
    }

    console.log(`\n已写入 ${args.out}`);
    console.log(`\n下一步：把这个文件与上面两个安装包一起上传到 GitHub Release，tag 用 ${built.tag}。`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exit(main());
