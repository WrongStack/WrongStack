import { open, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { safeResolveReal } from './_util.js';

export type E2EFramework = 'playwright' | 'cypress';
export type E2EPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

interface E2EPlanInput {
  cwd?: string | undefined;
  framework?: E2EFramework | 'all' | undefined;
  maxDepth?: number | undefined;
  includeSpecs?: boolean | undefined;
}

export interface E2EServerHint {
  kind: 'managed' | 'attach';
  command?: string | undefined;
  url?: string | undefined;
  port?: number | undefined;
  source: 'static-config';
  incomplete: boolean;
}

export interface E2EExecutionPlan {
  command: string;
  args: string[];
  cwd: string;
  source: 'package-script' | 'framework-default';
  script?: string | undefined;
}

export interface E2EProjectPlan {
  framework: E2EFramework;
  root: string;
  configPath?: string | undefined;
  packagePath?: string | undefined;
  packageManager: E2EPackageManager;
  evidence: string[];
  scripts: string[];
  serverHints: E2EServerHint[];
  specPattern: string;
  specCount: number;
  specSamples: string[];
  specsTruncated: boolean;
  execution: E2EExecutionPlan;
  warnings: string[];
}

export interface E2EPlanOutput {
  root: string;
  projects: E2EProjectPlan[];
  scannedDirectories: number;
  scanTruncated: boolean;
  warnings: string[];
}

interface ScanResult {
  configs: Array<{ framework: E2EFramework; absolutePath: string }>;
  packageFiles: string[];
  scannedDirectories: number;
  truncated: boolean;
}

interface PackageInfo {
  path: string;
  scripts: Record<string, string>;
  dependencies: Set<string>;
  packageManager?: E2EPackageManager | undefined;
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const CONFIG_NAMES = new Map<string, E2EFramework>([
  ['playwright.config.ts', 'playwright'],
  ['playwright.config.js', 'playwright'],
  ['playwright.config.mts', 'playwright'],
  ['playwright.config.mjs', 'playwright'],
  ['playwright.config.cts', 'playwright'],
  ['playwright.config.cjs', 'playwright'],
  ['cypress.config.ts', 'cypress'],
  ['cypress.config.js', 'cypress'],
  ['cypress.config.mts', 'cypress'],
  ['cypress.config.mjs', 'cypress'],
  ['cypress.config.cts', 'cypress'],
  ['cypress.config.cjs', 'cypress'],
  ['cypress.json', 'cypress'],
]);

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.wrongstack',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'coverage-html',
  'playwright-report',
  'test-results',
  '.next',
]);

const MAX_SCAN_DIRECTORIES = 4_000;
const MAX_PACKAGE_BYTES = 512 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SPEC_SAMPLES = 20;

function relativePath(root: string, target: string): string {
  const value = path.relative(root, target) || '.';
  return value.split(path.sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function staticString(source: string, property: string): string | undefined {
  const key = escapeRegExp(property);
  const direct = source.match(
    new RegExp(`(?:['"]?${key}['"]?)\\s*:\\s*(['"\\x60])([^'"\\x60\\r\\n]*)\\1`),
  );
  if (direct?.[2] && !direct[2].includes('${')) return direct[2];

  const sameLineFallback = source.match(
    new RegExp(`(?:['"]?${key}['"]?)\\s*:[^\\r\\n]{0,300}?(['"\\x60])([^'"\\x60\\r\\n]*)\\1`),
  );
  return sameLineFallback?.[2] && !sameLineFallback[2].includes('${')
    ? sameLineFallback[2]
    : undefined;
}

function staticNumber(source: string, property: string): number | undefined {
  const key = escapeRegExp(property);
  const match = source.match(new RegExp(`(?:['"]?${key}['"]?)\\s*:\\s*(\\d{2,5})\\b`));
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

function serverHints(framework: E2EFramework, source: string): E2EServerHint[] {
  if (framework === 'playwright' && /\bwebServer\s*:/.test(source)) {
    const command = staticString(source, 'command');
    const url = staticString(source, 'url');
    const port = staticNumber(source, 'port');
    return [
      {
        kind: 'managed',
        ...(command ? { command } : {}),
        ...(url ? { url } : {}),
        ...(port ? { port } : {}),
        source: 'static-config',
        incomplete: !command || (!url && !port),
      },
    ];
  }

  const baseUrl = staticString(source, 'baseURL') ?? staticString(source, 'baseUrl');
  return baseUrl
    ? [{ kind: 'attach', url: baseUrl, source: 'static-config', incomplete: false }]
    : [];
}

function configuredSpecPattern(framework: E2EFramework, source: string): string {
  if (framework === 'playwright') {
    const testDir = staticString(source, 'testDir') ?? './tests';
    return `${testDir.replace(/\/$/, '')}/**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs}`;
  }
  return (
    staticString(source, 'specPattern') ??
    'cypress/{e2e,integration}/**/*.cy.{js,jsx,ts,tsx,mjs,cjs}'
  );
}

async function scanWorkspace(
  root: string,
  maxDepth: number,
  signal: AbortSignal,
): Promise<ScanResult> {
  const result: ScanResult = {
    configs: [],
    packageFiles: [],
    scannedDirectories: 0,
    truncated: false,
  };
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

  while (queue.length > 0) {
    signal.throwIfAborted();
    const current = queue.shift();
    if (!current) break;
    result.scannedDirectories += 1;
    if (result.scannedDirectories > MAX_SCAN_DIRECTORIES) {
      result.truncated = true;
      break;
    }

    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      signal.throwIfAborted();
      const absolutePath = path.join(current.directory, entry.name);
      if (entry.isFile()) {
        if (entry.name === 'package.json') result.packageFiles.push(absolutePath);
        const framework = CONFIG_NAMES.get(entry.name);
        if (framework) result.configs.push({ framework, absolutePath });
      } else if (
        entry.isDirectory() &&
        current.depth < maxDepth &&
        !SKIP_DIRECTORIES.has(entry.name) &&
        !entry.name.startsWith('coverage-') &&
        !entry.name.startsWith('cov-')
      ) {
        queue.push({ directory: absolutePath, depth: current.depth + 1 });
      }
    }
  }

  return result;
}

async function readPackageInfo(packagePath: string): Promise<PackageInfo | undefined> {
  try {
    const raw = await readBoundedText(packagePath, MAX_PACKAGE_BYTES);
    if (raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts =
      parsed.scripts && typeof parsed.scripts === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.scripts as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};
    const dependencies = new Set<string>();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const value = parsed[field];
      if (!value || typeof value !== 'object') continue;
      for (const name of Object.keys(value as Record<string, unknown>)) dependencies.add(name);
    }
    const declared =
      typeof parsed.packageManager === 'string' ? (parsed.packageManager.split('@')[0] ?? '') : '';
    const packageManager = ['pnpm', 'npm', 'yarn', 'bun'].includes(declared)
      ? (declared as E2EPackageManager)
      : undefined;
    return { path: packagePath, scripts, dependencies, packageManager };
  } catch {
    return undefined;
  }
}

function frameworkFromPackage(info: PackageInfo): E2EFramework[] {
  const found = new Set<E2EFramework>();
  if (info.dependencies.has('@playwright/test') || info.dependencies.has('playwright')) {
    found.add('playwright');
  }
  if (info.dependencies.has('cypress')) found.add('cypress');
  for (const command of Object.values(info.scripts)) {
    if (/\bplaywright(?:\.cmd)?\b/i.test(command)) found.add('playwright');
    if (/\bcypress(?:\.cmd)?\b/i.test(command)) found.add('cypress');
  }
  return [...found];
}

async function detectPackageManager(
  projectRoot: string,
  scanRoot: string,
  declared?: E2EPackageManager,
): Promise<E2EPackageManager> {
  if (declared) return declared;
  let directory = projectRoot;
  while (true) {
    const names = new Set<string>();
    try {
      for (const entry of await readdir(directory)) names.add(entry);
    } catch {
      // Continue toward the scan root.
    }
    if (names.has('pnpm-lock.yaml')) return 'pnpm';
    if (names.has('yarn.lock')) return 'yarn';
    if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun';
    if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) return 'npm';
    if (directory === scanRoot) break;
    const parent = path.dirname(directory);
    const relativeParent = path.relative(scanRoot, parent);
    if (
      parent === directory ||
      relativeParent.startsWith('..') ||
      path.isAbsolute(relativeParent)
    ) {
      break;
    }
    directory = parent;
  }
  return 'npm';
}

function matchingScripts(info: PackageInfo | undefined, framework: E2EFramework): string[] {
  if (!info) return [];
  const matcher =
    framework === 'playwright' ? /\bplaywright(?:\.cmd)?\b/i : /\bcypress(?:\.cmd)?\b/i;
  return Object.entries(info.scripts)
    .filter(([, command]) => matcher.test(command))
    .map(([name]) => name)
    .sort((a, b) => {
      const preferred = ['test:e2e', 'e2e', 'e2e:test'];
      const ai = preferred.indexOf(a);
      const bi = preferred.indexOf(b);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.localeCompare(b);
    });
}

function executionPlan(
  framework: E2EFramework,
  manager: E2EPackageManager,
  root: string,
  configPath: string | undefined,
  scripts: string[],
): E2EExecutionPlan {
  const script = scripts[0];
  if (script) {
    return {
      command: manager,
      args: ['run', script],
      cwd: root,
      source: 'package-script',
      script,
    };
  }

  const runnerArgs = framework === 'playwright' ? ['playwright', 'test'] : ['cypress', 'run'];
  if (configPath) {
    runnerArgs.push(framework === 'playwright' ? '--config' : '--config-file', configPath);
  }
  return {
    command: manager === 'bun' ? 'bunx' : manager,
    args:
      manager === 'bun'
        ? runnerArgs
        : manager === 'npm'
          ? ['exec', '--', ...runnerArgs]
          : ['exec', ...runnerArgs],
    cwd: root,
    source: 'framework-default',
  };
}

function isSpec(framework: E2EFramework, filename: string): boolean {
  if (framework === 'cypress') return /\.cy\.(?:[cm]?[jt]sx?)$/i.test(filename);
  return /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/i.test(filename);
}

async function collectSpecs(
  root: string,
  framework: E2EFramework,
  testDirectory: string | undefined,
  signal: AbortSignal,
): Promise<{ count: number; samples: string[]; truncated: boolean }> {
  const roots = testDirectory
    ? [path.resolve(root, testDirectory)]
    : framework === 'cypress'
      ? [path.join(root, 'cypress', 'e2e'), path.join(root, 'cypress', 'integration')]
      : [path.join(root, 'tests')];
  const samples: string[] = [];
  let count = 0;
  let scanned = 0;
  const queue = [...roots];

  while (queue.length > 0) {
    signal.throwIfAborted();
    const directory = queue.shift();
    if (!directory) break;
    scanned += 1;
    if (scanned > MAX_SCAN_DIRECTORIES) return { count, samples, truncated: true };
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) queue.push(target);
      else if (entry.isFile() && isSpec(framework, entry.name)) {
        count += 1;
        if (samples.length < MAX_SPEC_SAMPLES) samples.push(relativePath(root, target));
      }
    }
  }
  return { count, samples, truncated: count > samples.length };
}

async function readConfig(configPath: string | undefined): Promise<string> {
  if (!configPath) return '';
  return (await readBoundedText(configPath, MAX_CONFIG_BYTES)) ?? '';
}

function nearestPackage(
  projectRoot: string,
  packagesByDirectory: Map<string, PackageInfo>,
  scanRoot: string,
): PackageInfo | undefined {
  let directory = projectRoot;
  while (true) {
    const found = packagesByDirectory.get(directory);
    if (found) return found;
    if (directory === scanRoot) return undefined;
    const parent = path.dirname(directory);
    if (parent === directory || relativePath(scanRoot, parent).startsWith('..')) return undefined;
    directory = parent;
  }
}

export async function discoverE2EProjects(
  root: string,
  options: {
    framework?: E2EFramework | 'all' | undefined;
    maxDepth?: number | undefined;
    includeSpecs?: boolean | undefined;
    signal: AbortSignal;
  },
): Promise<E2EPlanOutput> {
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 5, 8));
  const scan = await scanWorkspace(root, maxDepth, options.signal);
  const packages = (await Promise.all(scan.packageFiles.map(readPackageInfo))).filter(
    (info): info is PackageInfo => Boolean(info),
  );
  const packagesByDirectory = new Map(packages.map((info) => [path.dirname(info.path), info]));
  const candidates = new Map<
    string,
    { framework: E2EFramework; root: string; configPath?: string }
  >();

  for (const config of scan.configs) {
    if (
      options.framework &&
      options.framework !== 'all' &&
      config.framework !== options.framework
    ) {
      continue;
    }
    const projectRoot = path.dirname(config.absolutePath);
    candidates.set(`${config.framework}:${projectRoot}`, {
      framework: config.framework,
      root: projectRoot,
      configPath: config.absolutePath,
    });
  }

  for (const info of packages) {
    const projectRoot = path.dirname(info.path);
    for (const framework of frameworkFromPackage(info)) {
      if (options.framework && options.framework !== 'all' && framework !== options.framework)
        continue;
      const key = `${framework}:${projectRoot}`;
      if (!candidates.has(key)) candidates.set(key, { framework, root: projectRoot });
    }
  }

  const projects: E2EProjectPlan[] = [];
  for (const candidate of candidates.values()) {
    options.signal.throwIfAborted();
    const info = nearestPackage(candidate.root, packagesByDirectory, root);
    const source = await readConfig(candidate.configPath);
    const scripts = matchingScripts(info, candidate.framework);
    const manager = await detectPackageManager(candidate.root, root, info?.packageManager);
    const testDirectory =
      candidate.framework === 'playwright' ? staticString(source, 'testDir') : undefined;
    const resolvedTestDirectory = testDirectory
      ? path.resolve(candidate.root, testDirectory)
      : undefined;
    const relativeTestDirectory = resolvedTestDirectory
      ? path.relative(root, resolvedTestDirectory)
      : undefined;
    const unsafeTestDirectory = Boolean(
      relativeTestDirectory &&
        (relativeTestDirectory.startsWith('..') || path.isAbsolute(relativeTestDirectory)),
    );
    const specs =
      options.includeSpecs === false || unsafeTestDirectory
        ? { count: 0, samples: [], truncated: false }
        : await collectSpecs(candidate.root, candidate.framework, testDirectory, options.signal);
    const warnings: string[] = [];
    if (!candidate.configPath)
      warnings.push('Framework dependency or script found without a config file.');
    if (candidate.configPath && !source) {
      warnings.push('Config could not be read or exceeded the static inspection limit.');
    }
    if (unsafeTestDirectory) {
      warnings.push(
        'Configured testDir resolves outside the requested discovery root and was not scanned.',
      );
    }
    const hints = serverHints(candidate.framework, source);
    if (hints.some((hint) => hint.incomplete)) {
      warnings.push('Configured server contains dynamic values; only static hints are shown.');
    }

    projects.push({
      framework: candidate.framework,
      root: relativePath(root, candidate.root),
      ...(candidate.configPath ? { configPath: relativePath(root, candidate.configPath) } : {}),
      ...(info ? { packagePath: relativePath(root, info.path) } : {}),
      packageManager: manager,
      evidence: [
        ...(candidate.configPath ? [`config:${relativePath(root, candidate.configPath)}`] : []),
        ...(info?.dependencies.has(
          candidate.framework === 'playwright' ? '@playwright/test' : 'cypress',
        )
          ? [`dependency:${candidate.framework === 'playwright' ? '@playwright/test' : 'cypress'}`]
          : []),
        ...scripts.map((script) => `script:${script}`),
      ],
      scripts,
      serverHints: hints,
      specPattern: configuredSpecPattern(candidate.framework, source),
      specCount: specs.count,
      specSamples: specs.samples,
      specsTruncated: specs.truncated,
      execution: executionPlan(
        candidate.framework,
        manager,
        relativePath(root, candidate.root),
        candidate.configPath ? relativePath(candidate.root, candidate.configPath) : undefined,
        scripts,
      ),
      warnings,
    });
  }

  projects.sort((a, b) => a.root.localeCompare(b.root) || a.framework.localeCompare(b.framework));
  return {
    root,
    projects,
    scannedDirectories: scan.scannedDirectories,
    scanTruncated: scan.truncated,
    warnings: scan.truncated
      ? [`Discovery stopped after ${MAX_SCAN_DIRECTORIES} directories; narrow cwd or maxDepth.`]
      : [],
  };
}

type E2EPlanContext = Parameters<Tool<E2EPlanInput, E2EPlanOutput>['execute']>[1];

export const e2ePlanTool = {
  name: 'e2e_plan',
  category: 'Code Quality',
  description:
    'Discover Playwright and Cypress projects and preview bounded E2E execution plans without loading configs or starting processes.',
  usageHint:
    'Use before running browser E2E tests. The result identifies authoritative configs, package scripts, ' +
    'static server hints, specs, and exact argv. This tool never imports project config or executes commands.',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: ['fs.read'],
  icon: 'test',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'Directory inside the project to inspect.' },
      framework: {
        type: 'string',
        enum: ['all', 'playwright', 'cypress'],
        description: 'Optional framework filter; defaults to all.',
      },
      maxDepth: {
        type: 'integer',
        minimum: 0,
        maximum: 8,
        description: 'Maximum workspace discovery depth; defaults to 5.',
      },
      includeSpecs: {
        type: 'boolean',
        description: 'Count and sample specs; defaults to true.',
      },
    },
  },
  async execute(input: E2EPlanInput, ctx: E2EPlanContext, opts?: { signal: AbortSignal }) {
    const root = await safeResolveReal(input.cwd ?? '.', ctx);
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    return discoverE2EProjects(root, {
      framework: input.framework,
      maxDepth: input.maxDepth,
      includeSpecs: input.includeSpecs,
      signal,
    });
  },
} satisfies Tool<E2EPlanInput, E2EPlanOutput>;
