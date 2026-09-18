// scripts/release.ts
// 一条命令走完发布准备：预检 → 清理旧产物 → 签名构建 → 生成更新清单 → 打印后续步骤
//
//   pnpm release                  完整流程（构建要几分钟）
//   pnpm release --dry-run        只做预检并打印将要执行的动作，不构建、不写文件
//   pnpm release --skip-build     复用 bundle 目录里已有的安装包，只重新生成清单
//   pnpm release --allow-dirty    工作区不干净时也继续（仅用于自测）
//   pnpm release --no-password    私钥没有口令时（本项目的不属于这种）
//   pnpm release --notes "<文字>" / --notes-file <文件>
//
// 它**不做**三件事，以及为什么：
//
// 1. 不改版本号。版本变更是一次独立的、需要提交和打 tag 的改动（`pnpm ver bump`），
//    把它混进构建里，会让「这个安装包对应哪个提交」说不清。
// 2. 不提交、不打 tag。提交什么内容要人来决定。
// 3. 不上传。上传发生在 GitHub 上，这里没有网络凭据；脚本只打印上传清单与地址。
//
// 顺序上有一处硬性约束：**清单必须在构建之后生成**，因为签名只有构建时才产出；
// 而**构建必须有私钥**，否则产物是「装得上但更新不了」的哑弹。所以三类检查
// （版本一致、私钥在手、工作区干净）全部前置到构建之前 —— 构建要几分钟，
// 在最后一步才发现忘了设环境变量是最亏的失败方式。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  c,
  printDim,
  printError,
  printInfo,
  printPath,
  printStep,
  printSuccess,
  printTitle,
  printWarning,
} from './colors.ts';
import {
  INSTALLERS,
  ROOT,
  buildManifest,
  defaultBundleDir,
  defaultOutPath,
  findStaleInstallers,
  readAppVersion,
  removeStaleInstallers,
  resolveNotes,
  writeManifest,
} from './release-manifest.ts';
import { checkVersion } from './version-manager.ts';

const RELEASES_NEW_URL = 'https://github.com/Rinntheor/modulith-desktop/releases/new';
const MANIFEST_ENDPOINT =
  'https://github.com/Rinntheor/modulith-desktop/releases/latest/download/latest.json';

// ==================== 参数 ====================

interface Args {
  dryRun: boolean;
  skipBuild: boolean;
  allowDirty: boolean;
  noPassword: boolean;
  help: boolean;
  notes: string | null;
  notesFile: string | null;
  baseUrl: string | null;
  bundleDir: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
  };

  return {
    dryRun: argv.includes('--dry-run'),
    skipBuild: argv.includes('--skip-build'),
    allowDirty: argv.includes('--allow-dirty'),
    noPassword: argv.includes('--no-password'),
    help: argv.includes('--help') || argv.includes('-h'),
    notes: get('--notes'),
    notesFile: get('--notes-file'),
    baseUrl: get('--base-url'),
    bundleDir: get('--bundle-dir') ?? defaultBundleDir(),
    out: get('--out') ?? defaultOutPath(),
  };
}

function printUsage(): void {
  console.log('用法：pnpm release [选项]');
  console.log();
  console.log('  --dry-run            只做预检，不构建、不写文件');
  console.log('  --skip-build         复用已有安装包，只重新生成清单');
  console.log('  --allow-dirty        工作区不干净时也继续');
  console.log('  --no-password        私钥没有口令');
  console.log('  --notes <文字>       更新说明正文');
  console.log('  --notes-file <文件>  从文件读更新说明');
  console.log('  --base-url <前缀>    资源地址前缀（默认指向本项目 GitHub release）');
  console.log('  --bundle-dir <目录>  构建产物目录（测试用）');
  console.log('  --out <文件>         清单输出路径（默认 release/latest.json）');
}

// ==================== git 访问 ====================

/** 执行 git 命令并返回 stdout；失败时返回空串而不抛异常 */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/** 判断 git 是否真的可用（工作目录缺 .git 与被沙箱挡住是两回事） */
function gitWorks(): boolean {
  return git(['rev-parse', '--is-inside-work-tree']) === 'true';
}

// ==================== 预检 ====================

/**
 * 检查签名环境变量。
 *
 * 这一项值得单独前置：缺少私钥时 `tauri build` **照样成功**，安装包照样产出，
 * 只是旁边没有 `.sig`。等到生成清单时才失败，用户已经白等了一次完整构建。
 *
 * 这里的判断依据是实测结论，不是文档印象：
 *
 * - `tauri build` / `tauri bundle` 只读 `TAURI_SIGNING_PRIVATE_KEY`；
 * - 该变量的值**可以是密钥文件的路径**，tauri 会自己判断「这是路径还是内容」；
 * - `TAURI_SIGNING_PRIVATE_KEY_PATH` 是 `tauri signer sign` 与 `tauri plugin init` 用的，
 *   **构建链路完全不读它**。
 *
 * 实测方式（前提是已有构建产物，`tauri bundle` 不会重新编译）：
 *
 *   只设 TAURI_SIGNING_PRIVATE_KEY = <密钥路径>   → 产出 .sig，成功
 *   只设 TAURI_SIGNING_PRIVATE_KEY_PATH = <密钥路径> → Error: A public key has been found,
 *                                                    but no private key.
 */
function checkSigningEnv(noPassword: boolean): string[] {
  const problems: string[] = [];
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
  const keyPathOnly = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim();

  if (!key) {
    if (keyPathOnly) {
      // 这是最容易踩、也最耗时的一个：变量名看起来更"正确"，构建却当它不存在
      problems.push(
        '只设置了 TAURI_SIGNING_PRIVATE_KEY_PATH —— tauri build 不读这个变量。\n' +
          '    改设 TAURI_SIGNING_PRIVATE_KEY，值填密钥文件的路径即可。',
      );
    } else {
      problems.push(
        '没有设置 TAURI_SIGNING_PRIVATE_KEY。\n' +
          '    构建会成功，但不会生成 .sig，更新清单随即无从生成。',
      );
    }
  } else if (!existsSync(key) && !key.includes('untrusted comment')) {
    // 值既不是已存在的文件，也不像密钥内容。只报长度 —— 不要把可能是密钥的字符串写进日志
    problems.push(
      `TAURI_SIGNING_PRIVATE_KEY 既不是存在的文件路径，也不像密钥内容（长度 ${key.length}）。\n` +
        '    把它设成密钥文件的路径，或该文件的完整内容（含 untrusted comment 那一行）。',
    );
  }

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && !noPassword) {
    problems.push(
      '没有设置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。\n' +
        '    私钥是加密的，缺口令签名会失败 —— 而失败发生在构建的最后。',
    );
  }

  return problems;
}

/** 打印一段多行文本，每行都缩进成说明格式。走 stderr —— 调用方只在报错时用它。 */
function printIndented(text: string): void {
  for (const line of text.split('\n')) console.error(`    ${c.dim(line.trim())}`);
}

// ==================== 主流程 ====================

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return 0;
  }

  if (!existsSync(join(ROOT, 'version.toml'))) {
    printError('找不到 version.toml', '请从仓库根目录运行本脚本');
    return 1;
  }

  const version = readAppVersion();
  const tag = `v${version}`;

  printTitle('Modulith Desktop 发布', tag);
  console.log();

  // ---- 1. 版本一致性：四处配置必须都等于 version.toml ----
  printStep('版本一致性');
  // version-manager 里的检查是权威实现：不一致时它会打印逐项报告并退出
  checkVersion();

  // ---- 2. 签名环境 ----
  printStep('签名环境');
  const signingProblems = checkSigningEnv(args.noPassword);
  if (signingProblems.length > 0) {
    for (const problem of signingProblems) {
      printError('无法签名', problem.split('\n')[0]);
      printIndented(problem.split('\n').slice(1).join('\n'));
    }
    console.log();
    printDim('设置方式（PowerShell）：');
    printDim('  $env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\\.tauri\\modulith.key"');
    printDim('  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<口令>"');
    printDim('注意第一个变量名里没有 _PATH —— 值填路径，但变量就叫 TAURI_SIGNING_PRIVATE_KEY。');
    return 1;
  }
  const key = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim();
  printSuccess('私钥与口令就绪', existsSync(key) ? `文件 ${key}` : '内联内容');

  // ---- 3. 工作区状态 ----
  const gitAvailable = gitWorks();
  if (!gitAvailable && existsSync(join(ROOT, '.git'))) {
    printWarning('git 不可用', '已跳过工作区与 tag 检查');
  } else if (gitAvailable) {
    const dirty = git(['status', '--porcelain']);
    if (dirty) {
      const lines = dirty.split('\n').filter(Boolean);
      if (args.allowDirty) {
        printWarning('工作区不干净', `${lines.length} 个文件（--allow-dirty 已放行）`);
      } else {
        printError('工作区不干净', '先提交再发布');
        for (const line of lines) console.log(`    ${c.dim(line)}`);
        printDim('装出来的包必须对应某个提交；提交后重跑，或加 --allow-dirty 跳过本检查。');
        return 1;
      }
    } else {
      printSuccess('工作区干净');
    }

    const tags = git(['tag', '--list']).split('\n').filter(Boolean);
    if (!tags.includes(tag)) {
      printInfo(`tag ${tag} 还不存在`, '在 GitHub 上发布 Release 时会自动创建');
    } else {
      const atTag = git(['rev-list', '-n', '1', tag]);
      const head = git(['rev-parse', 'HEAD']);
      if (atTag && head && atTag !== head) {
        printWarning(`tag ${tag} 不在当前 HEAD`, `指向 ${atTag.slice(0, 7)}，HEAD 是 ${head.slice(0, 7)}`);
        printDim('GitHub 的 Release 会建在 tag 所指的提交上。若那正是发布提交，属正常。');
      } else {
        printSuccess(`tag ${tag}`, '已在当前 HEAD');
      }
    }
  }
  console.log();

  // ---- 4. 清理旧版本产物 ----
  const stale = findStaleInstallers(args.bundleDir, version);
  if (stale.length > 0) {
    printStep(`清理旧版本产物（${stale.length} 个）`);
    for (const path of stale) printPath('删除', basename(path));
    if (args.dryRun) {
      printDim('（--dry-run：未真的删除）');
    } else {
      removeStaleInstallers(args.bundleDir, version);
    }
    console.log();
  }

  if (args.dryRun) {
    printStep('预览结束（--dry-run）');
    printDim('将要执行：带签名构建 → 生成更新清单 → 打印 GitHub 上传步骤');
    printDim('未构建、未写文件。');
    return 0;
  }

  // ---- 5. 构建 ----
  printStep('构建');
  if (args.skipBuild) {
    printInfo('已跳过（--skip-build）', '复用 bundle 目录里已有的安装包');
  } else {
    const tauriJs = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
    if (!existsSync(tauriJs)) {
      printError('找不到 tauri CLI', tauriJs);
      printDim('先执行 pnpm install。');
      return 1;
    }

    printDim('调用 node node_modules/@tauri-apps/cli/tauri.js build，日志如下：');
    console.log();
    try {
      execFileSync(process.execPath, [tauriJs, 'build'], { cwd: ROOT, stdio: 'inherit' });
    } catch {
      console.log();
      printError('构建失败', '上面的日志末尾有原因；清单未生成。');
      return 1;
    }
    console.log();
    printSuccess('构建完成');
  }
  console.log();

  // ---- 6. 生成更新清单 ----
  printStep('生成更新清单');
  let built;
  let notesSource: string;
  try {
    const notes = resolveNotes({ version, notes: args.notes, notesFile: args.notesFile });
    notesSource = {
      inline: '--notes 参数',
      file: `--notes-file ${args.notesFile}`,
      changelog: 'CHANGELOG.md 里该版本的段落',
      none: '无（更新卡片会显示空白）',
    }[notes.source];

    built = buildManifest({
      bundleDir: args.bundleDir,
      version,
      notes: notes.text,
      baseUrl: args.baseUrl ?? undefined,
    });
    writeManifest(args.out, built.manifest);
  } catch (err) {
    printError('生成清单失败', err instanceof Error ? err.message.split('\n')[0] : String(err));
    if (err instanceof Error) printIndented(err.message.split('\n').slice(1).join('\n'));
    return 1;
  }

  printSuccess('版本', version);
  printSuccess('更新说明来源', notesSource);
  for (const installer of built.installers) {
    printSuccess(installer.target, installer.file);
  }
  printPath('已写入', args.out);
  console.log();

  // ---- 7. 后续步骤 ----
  const dirOfTarget = new Map<string, string>(INSTALLERS.map((spec) => [spec.target, spec.dir]));
  const uploads = [
    ...built.installers.map((installer) =>
      join(args.bundleDir, dirOfTarget.get(installer.target) ?? '', installer.file),
    ),
    args.out,
  ];

  printStep('后续步骤（在 GitHub 上手工完成）');
  console.log(`  ${c.number('1.')} 打开 ${c.path(`${RELEASES_NEW_URL}?tag=${tag}`)}`);
  console.log(`  ${c.number('2.')} Release title 填 ${c.number(tag)}；`);
  console.log(`     ${c.dim('不要勾 "Set as a pre-release" —— releases/latest 会跳过预发布。')}`);
  console.log(`  ${c.number('3.')} 把这三个文件拖进附件框：`);
  for (const path of uploads) console.log(`       ${c.path(path)}`);
  console.log(`  ${c.number('4.')} Publish release`);
  console.log();
  printDim('发布后：客户端「设置 → 关于 → 检查更新」应当看到新版本；');
  printDim('或直接打开下面这个地址，应当返回 JSON：');
  console.log(`  ${c.path(MANIFEST_ENDPOINT)}`);

  return 0;
}

process.exit(main());
