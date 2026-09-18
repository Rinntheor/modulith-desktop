// scripts/version-manager.ts
//
// 统一版本管理器：以 version.toml 为唯一事实来源，同步到各处配置与源码。
//
// 【与旧版的关键差异 —— 安全修复】
// 旧版会把整个项目里的裸字面量 '0.2.0' / '1' / 'dev' 做全局 replaceAll，
// 其中 BUILD_NUMBER 的标记是 '1'、RELEASE_TYPE 的标记是 'dev'。
// 实测本项目 82 个源文件中有 62 个包含字符 '1'，还有 dev-tools 分类、
// dev-1 测试夹具等大量合法 'dev'。一旦执行 sync，这些内容会被静默改写。
// 另外旧版的 MARKERS 是硬编码常量，bump 之后标记字符串即失效，
// 于是「同步」会去改写无辜的 0.2.0 文本。
//
// 新版改为显式的标记语法，只有写成 {{version}} 这样带双花括号的占位符
// 才会被替换，普通代码与文档中的裸版本号永不触碰。

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';
import {
  c,
  symbols,
  printTitle,
  printStep,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printKeyValue,
  printDivider,
  printDim,
} from './colors.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '..');
const VERSION_FILE = join(PROJECT_ROOT, 'version.toml');

// ==================== 配置文件路径 ====================

const CONFIG_FILES = {
  cargo: join(PROJECT_ROOT, 'src-tauri', 'Cargo.toml'),
  package: join(PROJECT_ROOT, 'package.json'),
  tauri: join(PROJECT_ROOT, 'src-tauri', 'tauri.conf.json'),
} as const;

// ==================== 类型定义 ====================

type ReleaseType = 'dev' | 'beta' | 'rc' | 'stable';

interface VersionConfig {
  app: {
    name: string;
    version: string;
    author: string;
    description: string;
  };
  build: {
    release_type: ReleaseType;
    build_number: number;
    full_version: string;
  };
}

// ==================== 常量 ====================

const RELEASE_TYPES: ReleaseType[] = ['dev', 'beta', 'rc', 'stable'];
const BUMP_TYPES = ['major', 'minor', 'patch', 'beta', 'rc', 'stable'] as const;
type BumpType = (typeof BUMP_TYPES)[number];

/** 扫描源码时跳过的目录 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.next',
  '.baseline',
  '.vite',
  'gen',
]);

/**
 * 允许替换标记的文件扩展名。
 *
 * 刻意不包含 `.md`：文档需要原样展示 `{{version}}` 这类标记的语法，
 * 若把文档纳入替换范围，不仅会改写示例、让文档自相矛盾，
 * 还会让 `ver check` 把文档里的语法示例误报为「未解析标记」。
 * 文档中若需要显示当前版本，请改为引用后端 `get_app_info`。
 */
const MARKER_FILE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.html', '.css', '.json', '.rs', '.toml',
]);

// ==================== 版本文件读写 ====================

const DEFAULT_CONFIG: VersionConfig = {
  app: {
    name: 'Modulith Desktop',
    version: '0.1.0',
    author: 'Modulith Desktop Team',
    description: 'A modular desktop application built with Tauri',
  },
  build: {
    release_type: 'dev',
    build_number: 1,
    full_version: '0.1.0-dev.1',
  },
};

/**
 * 严格 SemVer 2.0.0 校验（不含 build metadata 的宽松形式）。
 *
 * 为什么必须严格：后端插件校验器用 `SemVer::parse(env!("CARGO_PKG_VERSION"))`
 * 解析宿主版本，一旦 Cargo.toml 里的版本号非法，解析失败会以
 * 「本程序版本号非法」的形式**中断插件安装**，而错误现场看起来像插件的问题。
 * 所以非法版本必须在写入配置文件之前就被拦下。
 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function assertValidSemVer(version: string, where: string): void {
  if (!SEMVER_RE.test(version)) {
    printError('Invalid SemVer version', `${where}: "${version}"`);
    printDim('Expected format: MAJOR.MINOR.PATCH (digits only, no leading zeros)');
    process.exit(1);
  }
}

/**
 * 校验插件 `engines.loopcore` 的写法。这里只做提示，不阻断 ——
 * 实际匹配由后端 `VersionRequirement` 负责，且**不匹配也不再阻止安装**。
 *
 * 背景（两条都必须记住，否则会写出误导人的建议）：
 *
 * 1. 后端的 `VersionRequirement::parse` 只接受**单个**前导比较符
 *    （`^ ~ >= <= > < = *`）后跟严格的三段式版本号，不支持 npm 风格的
 *    复合范围（如 `">=0.2.0 <0.4.0"`）。复合范围会让后端解析失败，
 *    而解析失败属于**硬错误**（语法错误），插件会被拒绝安装。
 *
 * 2. `^0.x.y` 在 0.x 阶段锁定到 `0.minor`（与 npm 的 caret 语义一致）：
 *    `^0.2.0` 等价于 `>=0.2.0 <0.3.0`。宿主只要升一个小版本，
 *    该范围就不再匹配。这曾经导致「升级应用后旧插件全部无法安装」，
 *    现在不匹配只会产生一条界面提示，不会阻止安装与加载。
 *    但仍然建议规避：写 `>=0.2.0` 这类只有下界的范围可以少一次提示。
 */
function warnOnRiskyEngineRange(range: string, source: string): void {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return;

  // 复合范围无法被后端解析 —— 这是硬错误，必须改
  if (/\s/.test(trimmed) && !trimmed.includes('||')) {
    printWarning(
      'Unsupported engine range',
      `${source}: "${trimmed}"`,
    );
    printDim('The backend accepts a single comparator only (e.g. ^1.0.0, >=1.0.0, ~1.0.0).');
    printDim('A compound range fails parsing and REJECTS the plugin at install time.');
    return;
  }

  // `^0.x.y` 在 0.x 阶段锁定到 0.minor，minor 升级后就不再匹配。
  //
  // 注意 1.0 之后 caret 语义恢复正常（`^1.0.0` = `>=1.0.0 <2.0.0`，跨次版本
  // 不失配），因此这个告警**只针对 0.x 的 caret**。一旦宿主升到 1.0，
  // 写 `^1.x` 的插件不会再因为次版本变化而失配。
  if (/^\^0\./.test(trimmed)) {
    // `^0.2.0` -> minor 为 2；`^0.` 之后的第一段即 minor
    const minor = trimmed.slice(3).split('.')[0] || 'x';
    printWarning(
      'Narrow engine range',
      `${source}: "${trimmed}" only matches 0.${minor}.x`,
    );
    printDim('Install is still allowed, but users will see a mismatch notice after a minor bump.');
    // 建议值取自**当前 version.toml**，而不是写死一个字面量 ——
    // 写死会在版本升级后变成过时建议（这里就曾长期输出 >=0.2.0）。
    printDim(`Consider ">=${readVersionFile().app.version}" (lower bound only).`);
  }
}

/** 扫描仓库内的插件清单，检查 engines.Modulith 的写法 */
function checkPluginEngineRanges(): number {
  const results: Array<{ source: string; range: string }> = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else if (entry === 'manifest.json') {
        try {
          const json = JSON.parse(readFileSync(full, 'utf-8'));
          const range = json?.engines?.loopcore;
          if (typeof range === 'string' && range.trim()) {
            results.push({
              source: toPosix(relative(PROJECT_ROOT, full)),
              range,
            });
          }
        } catch {
          // 清单不可解析时跳过，安装阶段会给出准确报错
        }
      }
    }
  };

  walk(PROJECT_ROOT);

  for (const { source, range } of results) {
    warnOnRiskyEngineRange(range, source);
  }

  return results.length;
}

/** 路径分隔符统一为 `/`，便于跨平台输出 */
function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function readVersionFile(): VersionConfig {
  if (!existsSync(VERSION_FILE)) {
    printWarning('version.toml not found', 'creating default');
    writeVersionFile(DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(VERSION_FILE, 'utf-8'));
  } catch (err) {
    printError('Failed to parse version.toml', String(err));
    process.exit(1);
  }

  const config = parsed as Partial<VersionConfig>;
  if (!config.app?.version) {
    printError('version.toml is missing [app].version');
    process.exit(1);
  }

  // 版本号一旦非法，写入 Cargo.toml 后会让后端插件校验器解析失败
  assertValidSemVer(String(config.app.version), 'version.toml [app].version');

  const releaseType = config.build?.release_type ?? 'dev';
  if (!RELEASE_TYPES.includes(releaseType)) {
    printError('Invalid release_type', `${releaseType} (expected: ${RELEASE_TYPES.join(', ')})`);
    process.exit(1);
  }

  const version = config.app.version;
  const buildNumber = config.build?.build_number ?? 0;
  const fullVersion = config.build?.full_version ?? generateFullVersion(version, releaseType, buildNumber);

  // 自洽性检查：full_version 必须与 version / release_type / build_number 一致。
  // 字段之间互相矛盾时（例如 release_type=dev 但 full_version=0.2.0），
  // 展示的版本号会与实际构建类型不符，因此这里直接报错而不是静默修正。
  const derived = generateFullVersion(version, releaseType, buildNumber);
  if (fullVersion !== derived) {
    printError('version.toml is inconsistent', 'full_version does not match other fields');
    printDim(`full_version = "${fullVersion}"`);
    printDim(`derived      = "${derived}"  (from version=${version}, release_type=${releaseType}, build_number=${buildNumber})`);
    printDim('Fix by running: pnpm ver sync');
    process.exit(1);
  }

  return {
    app: {
      name: config.app.name ?? DEFAULT_CONFIG.app.name,
      version,
      author: config.app.author ?? DEFAULT_CONFIG.app.author,
      description: config.app.description ?? DEFAULT_CONFIG.app.description,
    },
    build: {
      release_type: releaseType,
      build_number: buildNumber,
      full_version: fullVersion,
    },
  };
}

function writeVersionFile(config: VersionConfig): void {
  const banner = [
    '# ============================================================',
    '# Modulith Desktop 统一版本管理 —— 唯一事实来源',
    '# 由 scripts/version-manager.ts 读写，请勿手工改乱格式',
    '# ============================================================',
    '',
  ].join('\n');

  const body = stringify({
    app: config.app,
    build: {
      release_type: config.build.release_type,
      build_number: config.build.build_number,
      full_version: config.build.full_version,
    },
  } as any);

  writeFileSync(VERSION_FILE, banner + body, 'utf-8');
}

function generateFullVersion(version: string, releaseType: ReleaseType, buildNumber: number): string {
  if (releaseType === 'stable') return version;
  return `${version}-${releaseType}.${buildNumber}`;
}

// ==================== 配置文件同步 ====================

function updateCargoToml(config: VersionConfig): boolean {
  if (!existsSync(CONFIG_FILES.cargo)) {
    printWarning('Cargo.toml not found', 'skipped');
    return false;
  }

  const content = readFileSync(CONFIG_FILES.cargo, 'utf-8');
  // 只替换 [package] 段落中的 version，避免误伤依赖项的 version 字段
  const packageEnd = content.indexOf('\n[', content.indexOf('[package]') + 1);
  const head = packageEnd === -1 ? content : content.slice(0, packageEnd);
  const tail = packageEnd === -1 ? '' : content.slice(packageEnd);

  if (!/^version\s*=\s*".*"$/m.test(head)) {
    printWarning('No version field in [package]', 'Cargo.toml skipped');
    return false;
  }

  const updated = head.replace(/^version\s*=\s*".*"$/m, `version = "${config.app.version}"`) + tail;
  if (updated === content) return false;

  writeFileSync(CONFIG_FILES.cargo, updated, 'utf-8');
  printSuccess('Cargo.toml', `version ${symbols.arrow} ${config.app.version}`);
  return true;
}

function updatePackageJson(config: VersionConfig): boolean {
  if (!existsSync(CONFIG_FILES.package)) {
    printWarning('package.json not found', 'skipped');
    return false;
  }

  const raw = readFileSync(CONFIG_FILES.package, 'utf-8');
  const pkg = JSON.parse(raw);
  if (pkg.version === config.app.version) return false;

  pkg.version = config.app.version;
  writeFileSync(CONFIG_FILES.package, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  printSuccess('package.json', `version ${symbols.arrow} ${config.app.version}`);
  return true;
}

function updateTauriConfig(config: VersionConfig): boolean {
  if (!existsSync(CONFIG_FILES.tauri)) {
    printWarning('tauri.conf.json not found', 'skipped');
    return false;
  }

  const raw = readFileSync(CONFIG_FILES.tauri, 'utf-8');
  const json = JSON.parse(raw);
  const before = JSON.stringify(json);

  json.version = config.app.version;
  json.productName = config.app.name;

  // Tauri 2 的窗口配置位于 app.windows；兼容旧版 tauri.windows
  const windows = json.app?.windows ?? json.tauri?.windows;
  if (Array.isArray(windows) && windows[0]) {
    windows[0].title = config.app.name;
  }

  if (JSON.stringify(json) === before) return false;

  writeFileSync(CONFIG_FILES.tauri, JSON.stringify(json, null, 2) + '\n', 'utf-8');
  printSuccess('tauri.conf.json', `version ${symbols.arrow} ${config.app.version} (${config.app.name})`);
  return true;
}

function updateConfigFiles(config: VersionConfig): number {
  printStep('Syncing config files');
  const results = [updateCargoToml(config), updatePackageJson(config), updateTauriConfig(config)];
  const changed = results.filter(Boolean).length;
  if (changed === 0) printInfo('All config files already in sync');
  return changed;
}

// ==================== 标记替换（安全版） ====================

/**
 * 构建标记映射表。
 * 标记在替换后仍然是「当前值」，因此可以反复执行而不产生漂移。
 */
function buildMarkers(config: VersionConfig): Record<string, string> {
  return {
    '{{version}}': config.app.version,
    '{{fullVersion}}': config.build.full_version,
    '{{appName}}': config.app.name,
    '{{buildNumber}}': String(config.build.build_number),
    '{{releaseType}}': config.build.release_type,
    '{{author}}': config.app.author,
    '{{description}}': config.app.description,
  };
}

interface MarkerHit {
  file: string;
  markers: string[];
}

function collectCandidateFiles(): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);

      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else if (MARKER_FILE_EXTS.has(extname(full))) {
        files.push(full);
      }
    }
  };

  walk(PROJECT_ROOT);
  return files;
}

/**
 * 扫描全项目并替换 {{...}} 标记。
 * dryRun 为 true 时只报告不写入。
 *
 * 标记会被替换为具体值，因此在同一位置重复执行是幂等且无副作用的：
 * 替换后标记消失，下一次读取到的是已解析的值。若某个文件需要
 * 「每次都能重新写入」，应改为从后端读取（见 get_app_info），
 * 而不是依赖标记常驻。
 */
function updateMarkedFiles(config: VersionConfig, dryRun = false): MarkerHit[] {
  const markers = buildMarkers(config);
  const markerKeys = Object.keys(markers);
  const files = collectCandidateFiles();
  const hits: MarkerHit[] = [];

  // 脚本自身使用 '{{version}}' 字面量构建映射，必须排除，否则会被自我改写
  const selfDir = __dirname;

  for (const file of files) {
    if (dirname(file) === selfDir) continue;
    if (file === VERSION_FILE) continue;

    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    if (!content.includes('{{')) continue;

    const found = markerKeys.filter((m) => content.includes(m));
    if (found.length === 0) continue;

    let updated = content;
    for (const marker of found) {
      updated = updated.split(marker).join(markers[marker]);
    }

    const rel = relative(PROJECT_ROOT, file).split('\\').join('/');
    hits.push({ file: rel, markers: found });

    if (!dryRun && updated !== content) {
      writeFileSync(file, updated, 'utf-8');
    }
  }

  return hits;
}

function reportMarkers(hits: MarkerHit[], dryRun: boolean): void {
  printStep(dryRun ? 'Scanning version markers (dry run)' : 'Updating version markers');

  if (hits.length === 0) {
    printInfo('No {{...}} markers found in source files');
    return;
  }

  for (const hit of hits) {
    const label = dryRun ? c.warning('would update') : c.success('updated');
    console.log(`  ${c.dim(symbols.bullet)} ${c.path(hit.file)} ${label} ${c.dim(`(${hit.markers.join(', ')})`)}`);
  }

  const total = hits.length;
  if (dryRun) {
    printInfo(`${total} file(s) contain version markers`);
  } else {
    printSuccess(`${total} file(s) updated`);
  }
}

// ==================== 命令：show ====================

function showVersion(): void {
  const config = readVersionFile();

  printTitle(config.app.name, `v${config.build.full_version}`);
  printKeyValue('Version', config.app.version);
  printKeyValue('Full Version', config.build.full_version);
  printKeyValue('Release Type', config.build.release_type);
  printKeyValue('Build Number', config.build.build_number);
  printKeyValue('Author', config.app.author);
  console.log();
  printDivider();
}

// ==================== 命令：bump ====================

function bumpVersion(type: BumpType): void {
  const config = readVersionFile();
  const parts = config.app.version.split('.').map(Number);

  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    printError('Invalid version format', `${config.app.version} (expected MAJOR.MINOR.PATCH)`);
    process.exit(1);
  }

  // 版本升级会同时改动多个文件，工作区脏时先提醒，便于事后回滚
  warnIfDirty();

  // 必须在打新 tag 之前记录上一个 tag，否则变更区间会算成空
  const previousTag = readLatestTag();

  const before = config.build.full_version;

  switch (type) {
    case 'major':
      parts[0] += 1;
      parts[1] = 0;
      parts[2] = 0;
      config.build.release_type = 'stable';
      config.build.build_number = 0;
      break;
    case 'minor':
      parts[1] += 1;
      parts[2] = 0;
      config.build.release_type = 'stable';
      config.build.build_number = 0;
      break;
    case 'patch':
      parts[2] += 1;
      config.build.release_type = 'stable';
      config.build.build_number = 0;
      break;
    case 'beta':
      config.build.release_type = 'beta';
      config.build.build_number += 1;
      break;
    case 'rc':
      config.build.release_type = 'rc';
      config.build.build_number += 1;
      break;
    case 'stable':
      config.build.release_type = 'stable';
      break;
  }

  config.app.version = parts.join('.');
  config.build.full_version = generateFullVersion(
    config.app.version,
    config.build.release_type,
    config.build.build_number,
  );

  writeVersionFile(config);

  console.log();
  printDivider(symbols.divider);
  console.log(`  ${c.title('Bumping version')}  ${c.number(before)} ${c.dim(symbols.arrow)} ${c.number(config.build.full_version)}`);
  printDivider(symbols.divider);
  console.log();

  updateConfigFiles(config);
  console.log();
  const hits = updateMarkedFiles(config, false);
  reportMarkers(hits, false);
  console.log();

  // git 集成是「尽力而为」：非 git 环境不应阻断版本升级
  if (isGitRepo()) {
    printStep('Updating CHANGELOG');
    generateChangelog(config, previousTag);
    console.log();

    printStep('Creating git tag');
    if (createVersionTag(config.build.full_version)) {
      printSuccess('Tagged', `v${config.build.full_version}`);
      printDim('Push with: git push --follow-tags');
    }
    console.log();
  }
}

// ==================== git 访问层 ====================

/**
 * git 访问抽象。
 *
 * 之所以抽象成一层：分类与渲染逻辑（真正容易出错的部分）可以脱离
 * 真实 git 进程被测试，而 git 调用保持标准实现。
 */
export interface GitAdapter {
  isRepo(): boolean;
  status(): string;
  /** 两个引用之间的提交主题行；from 为 null 时取全部历史 */
  log(from: string | null): string[];
  latestTag(): string | null;
  listTags(): string[];
  createTag(tag: string, message: string): void;
}

/** 基于子进程的默认实现 */
const childProcessGit: GitAdapter = {
  isRepo() {
    return gitOut(['rev-parse', '--is-inside-work-tree']) === 'true';
  },
  status() {
    return gitOut(['status', '--porcelain']);
  },
  log(from) {
    const range = from ? `${from}..HEAD` : 'HEAD';
    const out = gitOut(['log', '--pretty=format:%s', range]);
    return out ? out.split('\n').filter(Boolean) : [];
  },
  latestTag() {
    return gitOut(['describe', '--tags', '--abbrev=0']) || null;
  },
  listTags() {
    const out = gitOut(['tag', '--list']);
    return out ? out.split('\n').filter(Boolean) : [];
  },
  createTag(tag, message) {
    execFileSync('git', ['tag', '-a', tag, '-m', message], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    });
  },
};

/** 执行 git 命令并返回 stdout；失败时返回空串而不抛异常 */
function gitOut(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return '';
  }
}

/** 当前生效的 git 适配器，测试可替换 */
let git: GitAdapter = childProcessGit;

/** 替换 git 适配器（仅供测试使用） */
export function setGitAdapter(adapter: GitAdapter): void {
  git = adapter;
}

// ==================== git 集成 ====================

/** 判断当前是否处于 git 仓库中 */
function isGitRepo(): boolean {
  return git.isRepo();
}

/**
 * 检查工作区是否有未提交改动。
 * 版本升级会修改多个文件，若工作区本来就脏，出问题很难回滚。
 */
function warnIfDirty(): void {
  if (!git.isRepo()) return;

  const out = git.status();
  if (out) {
    const count = out.split('\n').length;
    printWarning('Working tree is not clean', `${count} file(s) changed`);
    printDim('Consider committing first so the version bump is isolated.');
    console.log();
  }
}

/** 为当前版本打 tag；已存在同名 tag 时返回 false 而不是报错 */
function createVersionTag(fullVersion: string): boolean {
  const tag = `v${fullVersion}`;

  try {
    if (git.listTags().includes(tag)) {
      printWarning('Tag already exists', tag);
      return false;
    }

    git.createTag(tag, `Release ${tag}`);
    return true;
  } catch (err) {
    printWarning('Failed to create tag', String(err));
    return false;
  }
}

// ==================== CHANGELOG ====================

const CHANGELOG_FILE = join(PROJECT_ROOT, 'CHANGELOG.md');

/** 把 git 提交归类为 Keep a Changelog 风格的章节 */
function classifyCommit(subject: string): string {
  const s = subject.toLowerCase();
  if (/^(feat|feature)(\(|:|!)/.test(s)) return 'Added';
  if (/^(fix|bugfix)(\(|:|!)/.test(s)) return 'Fixed';
  if (/^(perf)(\(|:|!)/.test(s)) return 'Changed';
  if (/^(refactor|style|chore|build|ci)(\(|:|!)/.test(s)) return 'Changed';
  if (/^(docs?)(\(|:|!)/.test(s)) return 'Documentation';
  if (/^(test|tests)(\(|:|!)/.test(s)) return 'Tests';
  if (/^(remove|revert)(\(|:|!)/.test(s)) return 'Removed';
  return 'Changed';
}

/** 去掉提交信息里的 type 前缀，保留可读描述 */
function cleanSubject(subject: string): string {
  return subject.replace(/^(\w+)(\([^)]*\))?!?:\s*/, '').trim() || subject;
}

/** 读取两个引用之间的提交；无 from 时取全部历史 */
function readCommits(from: string | null): string[] {
  return git.log(from);
}

/** 取最近一个 tag（按版本排序），用于计算变更区间 */
function readLatestTag(): string | null {
  return git.latestTag();
}

/**
 * 生成 / 更新 CHANGELOG.md。
 *
 * 采用「前插」策略：新版本段落插到文件顶部，既有历史保持不变。
 * 同一版本重复执行不会产生重复段落（会先移除旧段落再写入）。
 */
function generateChangelog(config: VersionConfig, fromTag: string | null): boolean {
  if (!isGitRepo()) {
    printWarning('Not a git repository', 'CHANGELOG generation skipped');
    return false;
  }

  const version = config.build.full_version;
  const commits = readCommits(fromTag);

  if (commits.length === 0) {
    printInfo('No commits since last tag', 'CHANGELOG unchanged');
    return false;
  }

  const grouped = new Map<string, string[]>();
  for (const subject of commits) {
    const section = classifyCommit(subject);
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section)!.push(cleanSubject(subject));
  }

  // Keep a Changelog 的推荐章节顺序
  const order = ['Added', 'Changed', 'Fixed', 'Removed', 'Documentation', 'Tests'];
  const date = new Date().toISOString().slice(0, 10);

  const lines: string[] = [`## [${version}] - ${date}`, ''];
  for (const section of order) {
    const items = grouped.get(section);
    if (!items || items.length === 0) continue;
    lines.push(`### ${section}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }

  const newSection = lines.join('\n');

  let existing = existsSync(CHANGELOG_FILE)
    ? readFileSync(CHANGELOG_FILE, 'utf-8')
    : '';

  if (!existing) {
    existing = [
      '# Changelog',
      '',
      '本文件由 `pnpm ver bump` 依据 git 提交自动维护。',
      '格式参考 [Keep a Changelog](https://keepachangelog.com/)。',
      '',
    ].join('\n');
  }

  // 移除同名版本的旧段落，保证可重复执行
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dupRe = new RegExp(`## \\[${escaped}\\][\\s\\S]*?(?=\\n## \\[|$)`, 'g');
  existing = existing.replace(dupRe, '');

  const headerEnd = existing.indexOf('\n## ');
  const updated =
    headerEnd === -1
      ? `${existing.trimEnd()}\n\n${newSection}`
      : `${existing.slice(0, headerEnd).trimEnd()}\n\n${newSection}${existing.slice(headerEnd)}`;

  writeFileSync(CHANGELOG_FILE, updated.replace(/\n{3,}/g, '\n\n'), 'utf-8');

  printSuccess('CHANGELOG.md', `${commits.length} commit(s) for ${version}`);
  return true;
}

// ==================== 命令：sync ====================

function syncAll(dryRun = false): void {
  const config = readVersionFile();

  printTitle('Syncing version', config.build.full_version);
  console.log();

  if (dryRun) {
    printInfo('Dry run: no files will be written');
    console.log();
  }

  if (!dryRun) {
    updateConfigFiles(config);
    console.log();
  } else {
    printStep('Config files that would change');
    const before = readVersionFile();
    printDim(`Cargo.toml / package.json / tauri.conf.json ${symbols.arrow} ${before.app.version}`);
    console.log();
  }

  const hits = updateMarkedFiles(config, dryRun);
  reportMarkers(hits, dryRun);
  console.log();
}

// ==================== 命令：check ====================

/** 校验各配置文件与 version.toml 是否一致（CI 友好，不一致返回非零退出码） */
function checkVersion(): void {
  const config = readVersionFile();
  let failures = 0;

  printTitle('Version consistency check', config.build.full_version);
  console.log();

  const check = (label: string, actual: string | undefined, expected: string) => {
    if (actual === expected) {
      printSuccess(label, expected);
    } else {
      printError(label, `expected ${expected}, found ${actual ?? '(missing)'}`);
      failures++;
    }
  };

  if (existsSync(CONFIG_FILES.cargo)) {
    const content = readFileSync(CONFIG_FILES.cargo, 'utf-8');
    const m = content.match(/^version\s*=\s*"(.*)"$/m);
    check('Cargo.toml', m?.[1], config.app.version);
  } else {
    printWarning('Cargo.toml not found', 'skipped');
  }

  if (existsSync(CONFIG_FILES.package)) {
    const pkg = JSON.parse(readFileSync(CONFIG_FILES.package, 'utf-8'));
    check('package.json', pkg.version, config.app.version);
  } else {
    printWarning('package.json not found', 'skipped');
  }

  if (existsSync(CONFIG_FILES.tauri)) {
    const json = JSON.parse(readFileSync(CONFIG_FILES.tauri, 'utf-8'));
    check('tauri.conf.json (version)', json.version, config.app.version);
    check('tauri.conf.json (productName)', json.productName, config.app.name);
  } else {
    printWarning('tauri.conf.json not found', 'skipped');
  }

  // 版本号必须是合法 SemVer，否则后端插件校验器会解析失败
  if (SEMVER_RE.test(config.app.version)) {
    printSuccess('SemVer format', config.app.version);
  } else {
    printError('SemVer format', `invalid: "${config.app.version}"`);
    failures++;
  }

  // 未替换的 {{...}} 标记说明有人忘了跑 ver sync
  const pending = updateMarkedFiles(config, true);
  if (pending.length === 0) {
    printSuccess('Version markers', 'all resolved');
  } else {
    for (const hit of pending) {
      printError('Unresolved marker', `${hit.file} (${hit.markers.join(', ')})`);
    }
    failures += pending.length;
  }

  // 插件清单的 engines.loopcore 写法。范围过窄或语法后端不支持时只提示，
  // 不计入失败 —— 安装阶段会给出权威判定。
  const manifestCount = checkPluginEngineRanges();
  if (manifestCount > 0) {
    printSuccess('Plugin manifests', `${manifestCount} engine range(s) checked`);
  }

  console.log();
  printDivider();

  if (failures > 0) {
    printError(`${failures} field(s) out of sync`, 'run: pnpm ver sync');
    console.log();
    process.exit(1);
  }

  printSuccess('All version fields are in sync');
  console.log();
}

// ==================== 命令：changelog ====================

/**
 * 依据 git 提交生成 / 更新 CHANGELOG.md。
 *
 * 与 `bump` 的区别：这里不改变版本号，只补写变更记录，
 * 适用于「已经 bump 过、但忘了生成 CHANGELOG」的补救场景。
 */
function changelogOnly(): void {
  const config = readVersionFile();

  if (!isGitRepo()) {
    printError('Not a git repository', 'CHANGELOG requires git history');
    process.exit(1);
  }

  printTitle('Generating CHANGELOG', config.build.full_version);
  console.log();

  const previousTag = readLatestTag();
  if (previousTag) {
    printInfo('Since tag', previousTag);
  } else {
    printInfo('No previous tag', 'including full history');
  }
  console.log();

  const written = generateChangelog(config, previousTag);

  console.log();
  printDivider();
  if (written) {
    printSuccess('CHANGELOG updated');
  } else {
    printInfo('Nothing to write');
  }
  printDivider();
  console.log();
}

// ==================== 帮助 ====================

function printUsage(): void {
  console.log();
  console.log(c.bold('Usage:'));
  console.log(`  ${c.info('pnpm ver show')}                     ${c.dim('Show current version info')}`);
  console.log(`  ${c.info('pnpm ver bump <type>')}              ${c.dim('Bump version (major|minor|patch|beta|rc|stable)')}`);
  console.log(`  ${c.info('pnpm ver sync')}                     ${c.dim('Sync all config files and markers')}`);
  console.log(`  ${c.info('pnpm ver sync --dry-run')}           ${c.dim('Preview changes without writing')}`);
  console.log(`  ${c.info('pnpm ver check')}                    ${c.dim('Verify all files match version.toml')}`);
  console.log(`  ${c.info('pnpm ver changelog')}                ${c.dim('Regenerate CHANGELOG.md from git history')}`);
  console.log();
  console.log(c.bold('Config files (automatically updated):'));
  console.log(`  ${c.dim(symbols.bullet)} src-tauri/Cargo.toml       ${c.dim(`${symbols.arrow} [package].version`)}`);
  console.log(`  ${c.dim(symbols.bullet)} package.json               ${c.dim(`${symbols.arrow} version`)}`);
  console.log(`  ${c.dim(symbols.bullet)} src-tauri/tauri.conf.json  ${c.dim(`${symbols.arrow} version, productName, app.windows[0].title`)}`);
  console.log();
  console.log(c.bold('Source markers (opt-in, written literally in your files):'));
  for (const [marker, desc] of [
    ['{{version}}', '0.2.0'],
    ['{{fullVersion}}', '0.2.0-dev.1'],
    ['{{appName}}', 'Modulith Desktop'],
    ['{{buildNumber}}', '1'],
    ['{{releaseType}}', 'dev'],
    ['{{author}}', 'Modulith Desktop Team'],
    ['{{description}}', 'app description'],
  ] as const) {
    console.log(`  ${c.highlight(marker.padEnd(18))} ${c.dim(desc)}`);
  }
  console.log();
  console.log(`  ${c.dim('Only these {{...}} placeholders are replaced — bare version')}`);
  console.log(`  ${c.dim('numbers in your code are never touched.')}`);
  console.log();
}

// ==================== 主入口 ====================

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'show':
    case undefined:
      printTitle('Modulith Desktop Version Manager');
      console.log();
      if (command === undefined) printUsage();
      else showVersion();
      break;

    case 'bump': {
      const type = (args[1] ?? 'patch') as BumpType;
      if (!BUMP_TYPES.includes(type)) {
        printError('Invalid bump type', type);
        printDim(`Valid types: ${BUMP_TYPES.join(', ')}`);
        process.exit(1);
      }
      bumpVersion(type);
      break;
    }

    case 'sync':
      syncAll(args.includes('--dry-run'));
      break;

    case 'check':
      checkVersion();
      break;

    case 'changelog':
      changelogOnly();
      break;

    default:
      printError('Unknown command', String(command));
      printUsage();
      process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export {
  readVersionFile,
  writeVersionFile,
  generateFullVersion,
  updateConfigFiles,
  updateMarkedFiles,
  buildMarkers,
  checkVersion,
  classifyCommit,
  cleanSubject,
  generateChangelog,
  CONFIG_FILES,
  VERSION_FILE,
};
export type { VersionConfig, ReleaseType };
