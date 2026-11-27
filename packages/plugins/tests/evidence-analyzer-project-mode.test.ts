/**
 * Project mode and precision of the evidence analyzers.
 *
 * Before project mode every analyzer waited for the model to paste evidence,
 * and several rules fired on almost anything: `DROP TABLE` inside a test
 * fixture was a "destructive operation", a changed test file was a "source
 * change without visible test reference", every `M…` word was a dirty
 * worktree line and every export was "undocumented". These tests pin the
 * narrowed rules and the collectors that read the project themselves.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Plugin } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bundleBudgetGuard from '../src/bundle-budget-guard/index.js';
import changeRiskClassifier from '../src/change-risk-classifier/index.js';
import ciFailureTriage from '../src/ci-failure-triage/index.js';
import dependencyDriftDetector from '../src/dependency-drift-detector/index.js';
import envContractGuard from '../src/env-contract-guard/index.js';
import { analyzeEvidence } from '../src/evidence-analyzer/index.js';
import lockfileConsistencyGuard from '../src/lockfile-consistency-guard/index.js';
import publicApiAuditor from '../src/public-api-auditor/index.js';
import releaseReadiness from '../src/release-readiness/index.js';
import testImpactAnalyzer from '../src/test-impact-analyzer/index.js';
import workspaceHealth from '../src/workspace-health/index.js';

interface Finding {
  rule: string;
  severity: string;
  file?: string;
  line: number;
  excerpt: string;
}
interface Result {
  source: string;
  findings: Finding[];
  facts?: Record<string, unknown>;
  ruleCounts?: Record<string, number>;
  suppressed?: number;
  limitation: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function run(
  plugin: Plugin,
  input: Record<string, unknown>,
  root = process.cwd(),
  extensions: Record<string, unknown> = {},
): Promise<Result> {
  const register = vi.fn();
  const api = {
    tools: { register },
    config: { extensions: { [plugin.name]: { enabled: true, ...extensions } } },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  await plugin.setup(api as never);
  cleanups.push(async () => {
    await plugin.teardown?.(api as never);
  });
  const tool = register.mock.calls[0]![0] as {
    execute: (i: unknown, c: unknown, o: unknown) => Promise<Result>;
  };
  return tool.execute(input, { projectRoot: root }, { signal: new AbortController().signal });
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evidence-project-mode-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await project(files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const rules = (result: Result) => result.findings.map((f) => f.rule);

describe('per-rule cap', () => {
  it('keeps one chatty rule from spending the whole finding budget', () => {
    const profile = {
      name: 'probe',
      toolName: 'probe',
      description: '',
      evidenceHint: '',
      rules: [
        { label: 'chatty', severity: 'warning' as const, pattern: /noise/, advice: '' },
        { label: 'rare', severity: 'error' as const, pattern: /signal/, advice: '' },
      ],
    };
    const content = `${'noise\n'.repeat(50)}signal\n`;
    const result = analyzeEvidence(content, profile, 10, Date.now, 3);
    expect(result.findings.filter((f) => f.rule === 'chatty')).toHaveLength(3);
    expect(result.findings.filter((f) => f.rule === 'rare')).toHaveLength(1);
    expect(result.ruleCounts).toEqual({ chatty: 50, rare: 1 });
  });

  it('reports counts and suppressed findings through the tool', async () => {
    const content = Array.from({ length: 12 }, (_, i) => `TS23${10 + i}: broken`).join('\n');
    const result = await run(ciFailureTriage, { content });
    expect(result.findings).toHaveLength(5);
    expect(result.ruleCounts).toMatchObject({ 'type-check failure': 12 });
    expect(result.suppressed).toBe(7);
  });
});

describe('narrowed content rules', () => {
  const diff = (path: string, lines: string[]) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,${lines.length} @@\n${lines.join('\n')}\n`;

  it('change risk ignores test fixtures and unchanged context lines', async () => {
    const content =
      diff('tests/db.test.ts', ["+  const sql = 'DROP TABLE users';"]) +
      diff('src/session.ts', ['   const token = read();', '+  return 1;']);
    expect((await run(changeRiskClassifier, { content })).findings).toEqual([]);
    const risky = diff('src/admin.ts', ["+  await db.exec('DROP TABLE users');"]);
    expect(rules(await run(changeRiskClassifier, { content: risky }))).toContain(
      'destructive operation',
    );
  });

  it('test impact maps a changed source to its changed test and flags .only', async () => {
    const covered =
      diff('src/cart.ts', ['+export const x = 1;']) +
      diff('tests/cart.test.ts', ["+it('x', () => {});"]);
    expect((await run(testImpactAnalyzer, { content: covered })).findings).toEqual([]);
    const uncovered = diff('src/price.ts', ['+export const y = 2;']);
    expect(await run(testImpactAnalyzer, { content: uncovered })).toMatchObject({
      findings: [{ rule: 'source change without a changed test', file: 'src/price.ts' }],
    });
    const focused = diff('tests/cart.test.ts', ["+it.only('x', () => {});"]);
    expect(rules(await run(testImpactAnalyzer, { content: focused }))).toEqual([
      'focused test committed',
    ]);
  });

  it('release readiness reads only porcelain status lines as a dirty tree', async () => {
    expect(
      (await run(releaseReadiness, { content: 'Make sure the docs are current' })).findings,
    ).toEqual([]);
    expect(rules(await run(releaseReadiness, { content: ' M src/index.ts' }))).toEqual([
      'dirty worktree',
    ]);
  });

  it('public API audit flags only exports without a doc comment', async () => {
    const content = [
      '/** Documented. */',
      'export function a() {}',
      '',
      '// not a doc comment',
      'export function b() {}',
      '/** Decorated. */',
      '@sealed',
      'export class C {}',
    ].join('\n');
    expect(await run(publicApiAuditor, { content })).toMatchObject({
      findings: [{ rule: 'undocumented exported declaration', line: 5 }],
    });
  });

  it('ci triage classifies lint, build, module, lockfile, memory, timeout and permission failures', async () => {
    const content = [
      'Error: Cannot find module "./missing.js"',
      'error: lockfile had changes, but lockfile is frozen',
      'SyntaxError: Unexpected token',
      '✖ 3 problems (3 errors, 0 warnings)',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      'Error: Test timed out in 5000ms.',
      'Error: EACCES: permission denied, open "/x"',
    ].join('\n');
    expect(new Set(rules(await run(ciFailureTriage, { content })))).toEqual(
      new Set([
        'missing module or import',
        'lockfile out of date in CI',
        'build or syntax failure',
        'lint failure',
        'out of memory',
        'timeout or cancellation',
        'filesystem permission failure',
      ]),
    );
    expect(
      (await run(ciFailureTriage, { content: 'Tests 0 failed | 50 passed' })).findings,
    ).toEqual([]);
  });

  it('an analyzer without a project collector still requires evidence', async () => {
    await expect(run(ciFailureTriage, {})).rejects.toThrow(/path or content is required/);
  });
});

describe('manifest collectors', () => {
  it('workspace health finds manager, script and workspace-link breaks', async () => {
    const root = await project({
      'package.json': JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        workspaces: ['packages/*', 'apps/*'],
        scripts: { build: 'npm run compile', ok: 'npm run build', file: 'bun run scripts/x.ts' },
      }),
      'bun.lock': '',
      'packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: { ghost: 'workspace:*' },
      }),
    });
    const result = await run(workspaceHealth, {}, root);
    expect(result.source).toBe('project');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'lockfile does not match packageManager' }),
        expect.objectContaining({
          rule: 'missing script',
          excerpt: expect.stringContaining('"compile"'),
        }),
        expect.objectContaining({
          rule: 'workspace resolution failure',
          excerpt: expect.stringContaining('"apps/*"'),
        }),
        expect.objectContaining({
          rule: 'workspace resolution failure',
          excerpt: expect.stringContaining('ghost'),
        }),
      ]),
    );
    expect(result.findings.filter((f) => f.rule === 'missing script')).toHaveLength(1);
  });

  it('workspace health does not treat `bun run <installed bin>` as a missing script', async () => {
    const root = await project({
      'package.json': JSON.stringify({ scripts: { test: 'bun run vitest' } }),
      'node_modules/.bin/vitest': '',
    });
    expect((await run(workspaceHealth, {}, root)).findings).toEqual([]);
  });

  it('workspace health reports engines.node as a fact under Bun instead of comparing it', async () => {
    const root = await project({
      'package.json': JSON.stringify({ engines: { node: '>=99' } }),
    });
    const result = await run(workspaceHealth, {}, root);
    if (process.versions['bun']) {
      expect(rules(result)).not.toContain('unsupported runtime');
      expect(result.facts).toMatchObject({ enginesNode: '>=99', engineCheck: expect.any(String) });
    } else {
      expect(rules(result)).toContain('unsupported runtime');
    }
  });

  it('never reads manifests or entry points outside the project root', async () => {
    const outside = await project({
      'pkg/package.json': JSON.stringify({ name: 'escaped', dependencies: { leak: '*' } }),
      'secret.ts': 'export function stolenSecret() {}\n',
    });
    const root = await project({
      'package.json': JSON.stringify({
        workspaces: ['../outside-ws/*', `${outside.replaceAll('\\', '/')}/pkg`],
        exports: { './x': `../${outside.split(/[\\/]/).pop()}/secret.ts` },
      }),
    });
    const drift = await run(dependencyDriftDetector, {}, root);
    expect(drift.facts).toMatchObject({ manifests: 1 });
    expect(JSON.stringify(drift)).not.toContain('leak');
    const api = await run(publicApiAuditor, {}, root);
    expect(JSON.stringify(api)).not.toContain('stolenSecret');
  });

  it('keeps structural scans linear on adversarial pastes', async () => {
    // ~840 KB, under the 1 MB evidence cap: 15k exports, each preceded by
    // `*/` lines with no opener — an unbounded walk back to the file top per
    // export is ~10^9 line checks.
    const strayCloser = `${'*/\n'.repeat(10)}export function late() {}\n`.repeat(15_000);
    const minified = `export ${'"x"'.repeat(300_000)} from "./internal/y"\n`;
    const started = Date.now();
    await run(publicApiAuditor, { content: strayCloser });
    await run(publicApiAuditor, { content: minified });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('lockfile consistency flags a foreign, stale binary or missing lockfile', async () => {
    const foreign = await project({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      'bun.lock': '',
      'bun.lockb': '',
    });
    expect(rules(await run(lockfileConsistencyGuard, {}, foreign))).toEqual(
      expect.arrayContaining([
        'lockfile does not match packageManager',
        'stale binary bun lockfile',
      ]),
    );
    const missing = await project({
      'package.json': JSON.stringify({ dependencies: { a: '1.0.0' } }),
    });
    expect(rules(await run(lockfileConsistencyGuard, {}, missing))).toEqual(['missing lockfile']);
    const none = await project({});
    await expect(run(lockfileConsistencyGuard, {}, none)).rejects.toThrow(/no package\.json/);
  });

  it('lockfile consistency finds mixed and nested lockfiles', async () => {
    const root = await project({
      'package.json': JSON.stringify({ workspaces: ['pkgs/*'], dependencies: { x: '1.0.0' } }),
      'package-lock.json': '{}',
      'yarn.lock': '',
      'pkgs/one/package.json': '{}',
      'pkgs/one/pnpm-lock.yaml': '',
    });
    expect(rules(await run(lockfileConsistencyGuard, {}, root))).toEqual(
      expect.arrayContaining(['multiple lockfiles', 'nested workspace lockfile']),
    );
  });

  it('dependency drift separates real drift from range style', async () => {
    const root = await project({
      'package.json': JSON.stringify({
        workspaces: ['p/*'],
        devDependencies: { a: '^1.0.0', b: '^2.0.0' },
      }),
      'p/x/package.json': JSON.stringify({ dependencies: { a: '^2.0.0', b: '2.0.0', c: '*' } }),
    });
    const result = await run(dependencyDriftDetector, {}, root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'version drift across packages', severity: 'warning' }),
        expect.objectContaining({ rule: 'range style differs across packages', severity: 'info' }),
        expect.objectContaining({ rule: 'unbounded dependency range', file: 'p/x/package.json' }),
      ]),
    );
    expect(result.facts).toMatchObject({ driftedDependencies: 1 });
  });

  it('env contract compares the template with source reads and never echoes values', async () => {
    // Assembled at runtime so secret scanners do not mistake the fixture for a live key.
    const secret = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    const root = await project({
      '.env.example': `API_URL=https://example.invalid\nSTRIPE_SECRET_KEY=${secret}\nOLD_FLAG=1\n`,
      'src/app.ts':
        'const u = process.env.API_URL;\nconst t = process.env.TOKEN_TTL;\nconst n = process.env.NODE_ENV;',
      'src/k.ts': "const k = process.env['STRIPE_SECRET_KEY'];",
    });
    const result = await run(envContractGuard, {}, root);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'environment value exposed',
          file: '.env.example',
          line: 2,
        }),
        expect.objectContaining({
          rule: 'variable read but not in template',
          file: 'src/app.ts',
          line: 2,
        }),
        expect.objectContaining({
          rule: 'template variable never read',
          excerpt: expect.stringContaining('OLD_FLAG'),
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('NODE_ENV');
  });

  it('public API audit maps export targets to source and reports missing ones', async () => {
    const root = await project({
      'package.json': JSON.stringify({
        name: 'lib',
        exports: { '.': './dist/index.js', './extra': './extra.js' },
      }),
      'src/index.ts': 'export function open() {}\n/** Closes. */\nexport function close() {}\n',
    });
    expect((await run(publicApiAuditor, {}, root)).findings).toEqual([
      expect.objectContaining({
        rule: 'export map target missing',
        excerpt: expect.stringContaining('./extra.js'),
      }),
      expect.objectContaining({
        rule: 'undocumented exported declaration',
        file: 'src/index.ts',
        line: 1,
      }),
    ]);
  });

  it('bundle budget measures browser output and refuses when nothing is built', async () => {
    const root = await project({
      'package.json': '{}',
      'dist/index.html': '<html></html>',
      'dist/assets/app.js': 'x'.repeat(4096),
      'dist/assets/app.js.map': '{}',
    });
    const result = await run(bundleBudgetGuard, {}, root, { maxAssetKb: 2 });
    expect(rules(result)).toEqual(['asset over budget', 'source maps in build output']);
    const empty = await project({ 'package.json': '{}' });
    await expect(run(bundleBudgetGuard, {}, empty)).rejects.toThrow(/no build output/);
  });
});

describe('git collectors', { timeout: 60_000 }, () => {
  it('change risk classifies working-tree files by path and changed lines, skipping tests', async () => {
    const root = await repo({
      'migrations/001.sql': 'CREATE TABLE a (id int);\n',
      'src/app.ts': 'export const a = 1;\n',
      'tests/app.test.ts': "it('a', () => {});\n",
    });
    await writeFile(join(root, 'migrations/001.sql'), 'CREATE TABLE a (id int, b int);\n');
    await writeFile(join(root, 'src/app.ts'), "export const a = () => exec('rm -rf /tmp/x');\n");
    await writeFile(join(root, 'tests/app.test.ts'), "it('a', () => exec('DROP TABLE a'));\n");
    await mkdir(join(root, 'src/auth'), { recursive: true });
    await writeFile(join(root, 'src/auth/login.ts'), 'export {};\n');
    const result = await run(changeRiskClassifier, {}, root);
    const byFile = result.findings.map((f) => `${f.rule}@${f.file}`);
    expect(byFile).toEqual(
      expect.arrayContaining([
        'persistence or migration change@migrations/001.sql',
        'destructive operation@src/app.ts',
        'authentication or authorization change@src/auth/login.ts',
      ]),
    );
    expect(byFile.some((entry) => entry.endsWith('@tests/app.test.ts'))).toBe(false);
    expect(result.facts).toMatchObject({ changedTestFiles: 1 });
  });

  it('test impact suggests existing tests for changed source and flags .only in changed tests', async () => {
    const root = await repo({
      'package.json': '{}',
      'src/cart.ts': 'export const a = 1;\n',
      'src/price.ts': 'export const p = 1;\n',
      'tests/cart.test.ts': "it('a', () => {});\n",
      'tests/totals.test.ts': "import { p } from '../src/price';\n",
    });
    await writeFile(join(root, 'src/cart.ts'), 'export const a = 2;\n');
    await writeFile(join(root, 'src/price.ts'), 'export const p = 2;\n');
    const result = await run(testImpactAnalyzer, {}, root);
    expect(result.facts?.['suggestedTests']).toEqual(
      expect.arrayContaining(['tests/cart.test.ts', 'tests/totals.test.ts']),
    );
    expect(result.findings.map((f) => f.file)).toEqual(['src/cart.ts', 'src/price.ts']);
    await writeFile(join(root, 'tests/cart.test.ts'), "it.only('a', () => {});\n");
    const focused = await run(testImpactAnalyzer, {}, root);
    expect(focused.findings[0]).toMatchObject({
      rule: 'focused test committed',
      file: 'tests/cart.test.ts',
      line: 1,
    });
    expect(focused.findings.map((f) => f.file)).not.toContain('src/cart.ts');
  });

  it('lockfile consistency reports a lockfile git does not track', async () => {
    const root = await repo({ 'package.json': JSON.stringify({ packageManager: 'bun@1.0.0' }) });
    await writeFile(join(root, 'bun.lock'), '{}');
    const result = await run(lockfileConsistencyGuard, {}, root);
    expect(rules(result)).toEqual(['lockfile not committed']);
    expect(result.facts).toMatchObject({ tracked: { 'bun.lock': false } });
  });

  it('release readiness flags the package that breaks a lockstep version', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ version: '2.0.0', workspaces: ['p/*'] }),
      'p/a/package.json': JSON.stringify({ name: 'a', version: '2.0.0' }),
      'p/b/package.json': JSON.stringify({ name: 'b', version: '2.0.0' }),
      'p/c/package.json': JSON.stringify({ name: 'c', version: '1.9.0' }),
      'p/private/package.json': JSON.stringify({ name: 'x', version: '0.0.1', private: true }),
    });
    const result = await run(releaseReadiness, {}, root);
    expect(result.findings).toEqual([
      expect.objectContaining({ rule: 'version mismatch', file: 'p/c/package.json' }),
    ]);
    expect(result.facts).toMatchObject({ version: '2.0.0', versioning: 'lockstep', dirtyPaths: 0 });
  });

  it('release readiness reports a dirty tree, a released version and a missing changelog entry', async () => {
    const root = await repo({
      'package.json': JSON.stringify({ name: 'r', version: '1.0.0' }),
      'CHANGELOG.md': '# Changelog\n\n## 0.9.0\n',
    });
    git(root, 'tag', 'v1.0.0');
    await writeFile(join(root, 'a.txt'), 'x');
    git(root, 'add', 'a.txt');
    git(root, 'commit', '-q', '-m', 'after release');
    await writeFile(join(root, 'b.txt'), 'dirty');
    expect(rules(await run(releaseReadiness, {}, root))).toEqual(
      expect.arrayContaining([
        'dirty worktree',
        'version already released',
        'changelog entry missing',
      ]),
    );
  });

  it('git collectors fail loudly outside a repository instead of reporting a clean change', async () => {
    const root = await project({ 'package.json': '{}' });
    await expect(run(changeRiskClassifier, {}, root)).rejects.toThrow(/git diff HEAD/);
  });
});
