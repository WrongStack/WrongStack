import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeDeadCode,
  applyDeadCodeFixes,
  type DeadCodeFinding,
  listDeadCodeBackups,
  planDeadCodeFixes,
  undoDeadCodeFix,
} from '../src/dead-code/index.js';

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'root',
    private: true,
    workspaces: ['packages/*'],
    scripts: { build: 'node scripts/build.mjs' },
    devDependencies: { 'left-pad': '1.0.0' },
  }),
  'scripts/build.mjs': "import { util } from './util.mjs';\nutil();\n",
  'scripts/util.mjs': 'export function util() {}\n',
  'scripts/orphan.mjs': 'console.log(1);\n',
  'README.md': 'Run `node packages/app/src/orphan.ts` — docs never create entries.\n',
  'docs/example.ts': "import { two } from '../packages/app/src/ns.js';\ntwo();\n",

  'packages/lib/package.json': JSON.stringify({
    name: '@x/lib',
    exports: { '.': './dist/index.js', './extra': './dist/extra.js' },
    dependencies: { zod: '1.0.0', kleur: '1.0.0' },
  }),
  'packages/lib/src/index.ts': "export * from './a.js';\nexport { b } from './b.js';\n",
  'packages/lib/src/a.ts': 'export function a(): number {\n  return 1;\n}\n',
  'packages/lib/src/b.ts': 'export const b = 1;\nexport const bUnused = 2;\n',
  'packages/lib/src/extra.ts': "import kleur from 'kleur';\nexport const extra = kleur;\n",
  'packages/lib/src/internal.ts': 'export const internal = 1;\n',

  'packages/app/package.json': JSON.stringify({
    name: 'app',
    private: true,
    main: './dist/main.js',
    dependencies: { '@x/lib': 'workspace:*', 'unused-dep': '1.0.0' },
  }),
  'packages/app/tsconfig.json': JSON.stringify({
    compilerOptions: { paths: { '@/*': ['./src/*'] } },
  }),
  'packages/app/src/main.ts': [
    "import { a } from '@x/lib';",
    "import { helper } from '@/helpers';",
    "import * as ns from './ns.js';",
    "const lazy = await import('./lazy.js');",
    'const UNUSED_LOCAL = 1;',
    'ns.one();',
    'lazy.run();',
    'helper(a);',
    "new URL('./worker.ts', import.meta.url);",
    '',
  ].join('\n'),
  'packages/app/src/helpers/index.ts':
    "export { helper } from './helper.js';\nexport { unusedRe } from './helper.js';\n",
  'packages/app/src/helpers/helper.ts': [
    "import { join } from 'node:path';",
    "import { basename } from 'node:path';",
    '',
    'const SECRET = 1;',
    '',
    '/** Only deadFn calls this. */',
    'function privateHelper(): number {',
    '  return SECRET;',
    '}',
    '',
    'export function helper(x: unknown): unknown {',
    '  return basename(String(x));',
    '}',
    '',
    'export function deadFn(): number {',
    "  return privateHelper() + join('a').length;",
    '}',
    '',
    'export function unusedRe(): void {}',
    '',
    'export const localUse = 5;',
    'console.log(localUse);',
    '',
  ].join('\n'),
  'packages/app/src/ns.ts': 'export function one(): void {}\nexport function two(): void {}\n',
  'packages/app/src/lazy.ts': 'export function run(): void {}\nexport function notRun(): void {}\n',
  'packages/app/src/worker.ts': 'self.postMessage(1);\n',
  'packages/app/src/testonly.ts': 'export const t = 1;\n',
  'packages/app/src/orphan.ts': 'export const o = 1;\n',
  'packages/app/src/keep.ts': '// dead-code-ignore-file\nexport const kept = 1;\n',
  'packages/app/tests/main.test.ts':
    "import { t } from '../src/testonly.js';\nimport { one } from '../src/ns.js';\nconsole.log(t, one);\n",
};

let root: string;
let home: string;
let prevHome: string | undefined;

function writeFixture(): void {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function find(
  findings: DeadCodeFinding[],
  category: DeadCodeFinding['category'],
  file: string,
  name?: string,
): DeadCodeFinding | undefined {
  return findings.find((f) => f.category === category && f.file === file && f.name === name);
}

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-deadcode-'));
  root = path.join(base, 'repo');
  home = path.join(base, 'home');
  prevHome = process.env.WRONGSTACK_HOME;
  process.env.WRONGSTACK_HOME = home;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.WRONGSTACK_HOME;
  else process.env.WRONGSTACK_HOME = prevHome;
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

beforeEach(() => writeFixture());

describe('dead-code analysis', () => {
  it('reports exactly the dead things, with the right categories', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const f = r.findings;

    expect(find(f, 'unreachable-file', 'packages/app/src/orphan.ts')?.confidence).toBe('high');
    expect(find(f, 'unreachable-file', 'packages/lib/src/internal.ts')).toBeDefined();
    expect(find(f, 'unreachable-file', 'scripts/orphan.mjs')?.confidence).toBe('low');
    expect(find(f, 'test-only-file', 'packages/app/src/testonly.ts')).toBeDefined();

    expect(find(f, 'dead-export', 'packages/app/src/helpers/helper.ts', 'deadFn')?.fix).toBe(
      'remove-declaration',
    );
    expect(find(f, 'dead-export', 'packages/app/src/helpers/helper.ts', 'unusedRe')).toBeDefined();
    expect(
      find(f, 'unused-reexport', 'packages/app/src/helpers/index.ts', 'unusedRe'),
    ).toBeDefined();
    expect(find(f, 'unused-export', 'packages/app/src/helpers/helper.ts', 'localUse')?.fix).toBe(
      'remove-export-keyword',
    );
    // Namespace member reads and `const m = await import()` member reads are tracked.
    expect(find(f, 'dead-export', 'packages/app/src/ns.ts', 'two')).toBeDefined();
    expect(find(f, 'dead-export', 'packages/app/src/lazy.ts', 'notRun')).toBeDefined();
    expect(find(f, 'unused-local', 'packages/app/src/main.ts', 'UNUSED_LOCAL')).toBeDefined();
    expect(find(f, 'dead-export', 'packages/lib/src/b.ts', 'bUnused')).toBeDefined();

    expect(find(f, 'unused-dependency', 'packages/app/package.json', 'unused-dep')).toBeDefined();
    expect(find(f, 'unused-dependency', 'packages/lib/package.json', 'zod')).toBeDefined();
    expect(find(f, 'unused-dependency', 'package.json', 'left-pad')?.confidence).toBe('low');

    const files = new Set(f.map((x) => x.file));
    // Live code, public API of a published package, ignored and doc files stay out.
    for (const live of [
      'packages/app/src/worker.ts',
      'packages/app/src/keep.ts',
      'packages/lib/src/a.ts',
      'packages/lib/src/extra.ts',
      'scripts/util.mjs',
      'docs/example.ts',
      'packages/app/tests/main.test.ts',
    ]) {
      expect(files.has(live), live).toBe(false);
    }
    expect(find(f, 'unused-dependency', 'packages/lib/package.json', 'kleur')).toBeUndefined();
    expect(find(f, 'dead-export', 'packages/app/src/ns.ts', 'one')).toBeUndefined();
  });

  it('keeps finding ids stable across scans and scopes findings by path', async () => {
    const a = await analyzeDeadCode(root, {});
    const b = await analyzeDeadCode(root, { paths: ['packages/lib'] });
    expect(b.stats.cachedFiles).toBeGreaterThan(0);
    expect(b.findings.every((f) => f.file.startsWith('packages/lib/'))).toBe(true);
    for (const f of b.findings) expect(a.findings.some((x) => x.id === f.id)).toBe(true);
  });

  it('includes published API only when asked', async () => {
    fs.writeFileSync(
      path.join(root, 'packages/lib/src/a.ts'),
      'export function a() {}\nexport function pub() {}\n',
    );
    const off = await analyzeDeadCode(root, { noCache: true });
    expect(off.findings.some((f) => f.name === 'pub')).toBe(false);
    const on = await analyzeDeadCode(root, { noCache: true, includePublicApi: true });
    expect(find(on.findings, 'unused-public-export', 'packages/lib/src/a.ts', 'pub')).toBeDefined();
  });

  it('follows /// <reference path> and keeps global-script declarations', async () => {
    // The reference is the only thing that puts globals.ts in the program, and
    // its top-level declarations are global: main.ts uses them.
    fs.writeFileSync(
      path.join(root, 'packages/app/src/main.ts'),
      [
        '/// <reference path="./globals.ts" />',
        fs.readFileSync(path.join(root, 'packages/app/src/main.ts'), 'utf8'),
        'console.log(APP_VERSION, formatVersion());',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'packages/app/src/globals.ts'),
      'declare const APP_VERSION: string;\nfunction formatVersion(): string {\n  return APP_VERSION;\n}\n',
    );
    const r = await analyzeDeadCode(root, { noCache: true });
    expect(r.findings.filter((f) => f.file === 'packages/app/src/globals.ts')).toEqual([]);
  });

  it('keeps conventional entries when the package only has a tool config', async () => {
    // vitest.config.ts is loaded by vitest, not an entry to svc's code; it used
    // to switch off the src/server convention and mark the whole package dead.
    for (const [rel, content] of Object.entries({
      'packages/svc/package.json': JSON.stringify({ name: 'svc', private: true }),
      'packages/svc/vitest.config.ts': 'export default {};\n',
      'packages/svc/src/server.ts': "import { routes } from './routes.js';\nroutes();\n",
      'packages/svc/src/routes.ts': 'export function routes(): void {}\n',
    })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const r = await analyzeDeadCode(root, { noCache: true });
    expect(r.findings.filter((f) => f.file.startsWith('packages/svc/src/'))).toEqual([]);
  });

  it('falls back to package resolution when a catch-all paths alias resolves nothing', async () => {
    // TypeScript keeps resolving after a `paths` miss; `"*"` used to swallow
    // the `@x/lib` import, so `a` (which main.ts uses) read as unused.
    fs.writeFileSync(
      path.join(root, 'packages/app/tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '*': ['./types/*'], '@/*': ['./src/*'] } } }),
    );
    const r = await analyzeDeadCode(root, { noCache: true, includePublicApi: true });
    expect(r.findings.some((f) => f.file === 'packages/lib/src/a.ts' && f.name === 'a')).toBe(
      false,
    );
    expect(find(r.findings, 'dead-export', 'packages/lib/src/b.ts', 'bUnused')).toBeDefined();
  });
});

describe('dead-code fixes', () => {
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('removes a dead export and everything only it used', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const dead = find(r.findings, 'dead-export', 'packages/app/src/helpers/helper.ts', 'deadFn')!;
    const res = await applyDeadCodeFixes(root, [dead.id], { verify: 'none' });
    expect(res.ok).toBe(true);
    const after = read('packages/app/src/helpers/helper.ts');
    expect(after).not.toContain('deadFn');
    expect(after).not.toContain('privateHelper');
    expect(after).not.toContain('SECRET');
    expect(after).not.toContain('Only deadFn calls this');
    expect(after).not.toContain('import { join }');
    // Untouched: still-used import and declarations.
    expect(after).toContain("import { basename } from 'node:path';");
    expect(after).toContain('export function helper');
    expect(after).not.toMatch(/\n\n\n/);
  });

  it('applies only the reviewed plan revision and writes nothing when the plan changed', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const dead = find(r.findings, 'dead-export', 'packages/app/src/helpers/helper.ts', 'deadFn')!;
    const plan = await planDeadCodeFixes(root, [dead.id]);
    expect(plan.revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await planDeadCodeFixes(root, [dead.id])).revision).toBe(plan.revision);
    // The file changes after review: the same finding now plans different file contents.
    const helper = 'packages/app/src/helpers/helper.ts';
    const edited = `${read(helper)}\nexport const lateEdit = 1;\n`;
    fs.writeFileSync(path.join(root, helper), edited);
    const stale = await applyDeadCodeFixes(root, [dead.id], {
      verify: 'none',
      expectedRevision: plan.revision,
    });
    expect(stale).toMatchObject({ ok: false, stale: true, rolledBack: false, changed: [] });
    expect(stale.backupId).toBeUndefined();
    expect(stale.plan.revision).not.toBe(plan.revision);
    expect(read(helper)).toBe(edited);
    const reviewed = await applyDeadCodeFixes(root, [dead.id], {
      verify: 'none',
      expectedRevision: stale.plan.revision,
    });
    expect(reviewed.ok).toBe(true);
    expect(read(helper)).not.toContain('deadFn');
  });

  it('removes barrel re-exports together with the declaration they point at', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const dead = find(r.findings, 'dead-export', 'packages/app/src/helpers/helper.ts', 'unusedRe')!;
    const plan = await planDeadCodeFixes(root, [dead.id]);
    expect(plan.changes.map((c) => c.file).sort()).toEqual([
      'packages/app/src/helpers/helper.ts',
      'packages/app/src/helpers/index.ts',
    ]);
    // Planning writes nothing.
    expect(read('packages/app/src/helpers/index.ts')).toContain('unusedRe');
    await applyDeadCodeFixes(root, [dead.id], { verify: 'none' });
    expect(read('packages/app/src/helpers/index.ts')).toBe(
      "export { helper } from './helper.js';\n",
    );
  });

  it('drops only the export keyword when the file still uses the binding', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const f = find(r.findings, 'unused-export', 'packages/app/src/helpers/helper.ts', 'localUse')!;
    await applyDeadCodeFixes(root, [f.id], { verify: 'none' });
    expect(read('packages/app/src/helpers/helper.ts')).toContain('\nconst localUse = 5;\n');
  });

  it('deletes unreachable files, edits manifests, and undo restores everything', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const orphan = find(r.findings, 'unreachable-file', 'packages/app/src/orphan.ts')!;
    const dep = find(r.findings, 'unused-dependency', 'packages/app/package.json', 'unused-dep')!;
    const beforeManifest = read('packages/app/package.json');
    const res = await applyDeadCodeFixes(root, [orphan.id, dep.id], { verify: 'none' });
    expect(res.deleted).toEqual(['packages/app/src/orphan.ts']);
    expect(JSON.parse(read('packages/app/package.json')).dependencies).toEqual({
      '@x/lib': 'workspace:*',
    });
    expect(listDeadCodeBackups(root)[0]?.id).toBe(res.backupId);

    const undo = undoDeadCodeFix(root, res.backupId!);
    expect(undo.conflicts).toEqual([]);
    expect(read('packages/app/src/orphan.ts')).toBe(FIXTURE['packages/app/src/orphan.ts']);
    expect(read('packages/app/package.json')).toBe(beforeManifest);
  });

  it('refuses to undo over files edited after the fix unless forced', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const f = find(r.findings, 'dead-export', 'packages/app/src/ns.ts', 'two')!;
    const res = await applyDeadCodeFixes(root, [f.id], { verify: 'none' });
    fs.appendFileSync(path.join(root, 'packages/app/src/ns.ts'), '// user edit\n');
    expect(undoDeadCodeFix(root, res.backupId!).conflicts).toEqual(['packages/app/src/ns.ts']);
    expect(read('packages/app/src/ns.ts')).toContain('// user edit');
    undoDeadCodeFix(root, res.backupId!, { force: true });
    expect(read('packages/app/src/ns.ts')).toBe(FIXTURE['packages/app/src/ns.ts']);
  });

  it('rolls every file back when verification fails', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const backupsBefore = listDeadCodeBackups(root).length;
    const ids = [
      find(r.findings, 'unreachable-file', 'packages/app/src/orphan.ts')!.id,
      find(r.findings, 'dead-export', 'packages/app/src/lazy.ts', 'notRun')!.id,
    ];
    const res = await applyDeadCodeFixes(root, ids, {
      verify: 'none',
      verifyCommand: [process.execPath, '-e', 'process.exit(3)'],
    });
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    expect(read('packages/app/src/orphan.ts')).toBe(FIXTURE['packages/app/src/orphan.ts']);
    expect(read('packages/app/src/lazy.ts')).toBe(FIXTURE['packages/app/src/lazy.ts']);
    expect(listDeadCodeBackups(root)).toHaveLength(backupsBefore);
  });

  it('keeps edits made while verification ran when it rolls back', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const lazy = path.join(root, 'packages/app/src/lazy.ts');
    const ids = [
      find(r.findings, 'unreachable-file', 'packages/app/src/orphan.ts')!.id,
      find(r.findings, 'dead-export', 'packages/app/src/lazy.ts', 'notRun')!.id,
    ];
    const res = await applyDeadCodeFixes(root, ids, {
      verify: 'none',
      verifyCommand: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(lazy)}, 'mine\\n');process.exit(1)`,
      ],
    });
    expect(res.rolledBack).toBe(true);
    expect(read('packages/app/src/lazy.ts')).toBe('mine\n');
    expect(read('packages/app/src/orphan.ts')).toBe(FIXTURE['packages/app/src/orphan.ts']);
    expect(undoDeadCodeFix(root, res.backupId!).conflicts).toEqual(['packages/app/src/lazy.ts']);
  });

  it('skips ids that no longer exist and findings without a mechanical fix', async () => {
    const r = await analyzeDeadCode(root, { noCache: true });
    const testOnly = find(r.findings, 'test-only-file', 'packages/app/src/testonly.ts')!;
    const plan = await planDeadCodeFixes(root, ['000000000000', testOnly.id]);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped.map((s) => s.id).sort()).toEqual(['000000000000', testOnly.id].sort());
  });

  it('will not delete a file a surviving file still imports', async () => {
    // internal.ts is unreachable; make another unreachable file import it and select only internal.ts.
    fs.writeFileSync(
      path.join(root, 'packages/lib/src/user.ts'),
      "import { internal } from './internal.js';\nconsole.log(internal);\n",
    );
    const r = await analyzeDeadCode(root, { noCache: true });
    const internal = find(r.findings, 'unreachable-file', 'packages/lib/src/internal.ts')!;
    const plan = await planDeadCodeFixes(root, [internal.id]);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('packages/lib/src/user.ts');
  });

  it('keeps what a file it will not delete still imports', async () => {
    // user.ts (not selected) → mid.ts → internal.ts: keeping mid.ts keeps internal.ts.
    fs.writeFileSync(
      path.join(root, 'packages/lib/src/user.ts'),
      "import { mid } from './mid.js';\nconsole.log(mid);\n",
    );
    fs.writeFileSync(
      path.join(root, 'packages/lib/src/mid.ts'),
      "import { internal } from './internal.js';\nexport const mid = internal;\n",
    );
    const r = await analyzeDeadCode(root, { noCache: true });
    const internal = find(r.findings, 'unreachable-file', 'packages/lib/src/internal.ts')!;
    const mid = find(r.findings, 'unreachable-file', 'packages/lib/src/mid.ts')!;
    const plan = await planDeadCodeFixes(root, [internal.id, mid.id]);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped.map((s) => s.id).sort()).toEqual([internal.id, mid.id].sort());
  });

  it('will not delete a file a surviving file still loads via import.meta.glob', async () => {
    // x.ts is unreachable; the also-unreachable loader.ts still globs it at
    // runtime. extraEdges references must block the deletion just like imports.
    fs.mkdirSync(path.join(root, 'packages/lib/src/targets'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages/lib/src/loader.ts'),
      "void import.meta.glob('./targets/*.ts');\n",
    );
    fs.writeFileSync(path.join(root, 'packages/lib/src/targets/x.ts'), 'export const x = 1;\n');
    const r = await analyzeDeadCode(root, { noCache: true });
    const x = find(r.findings, 'unreachable-file', 'packages/lib/src/targets/x.ts')!;
    const plan = await planDeadCodeFixes(root, [x.id]);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped[0]?.reason).toContain('packages/lib/src/loader.ts');
  });
});

describe('dead-code precision (patterns found on a real monorepo)', () => {
  const scratch = (): string => path.join(path.dirname(root), 'precision');
  const project = (files: Record<string, string>): string => {
    const dir = scratch();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
  };

  it('does not count a shadowing inner declaration as a use of the top-level one', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: 'src/main.ts' }),
      'src/main.ts': "import { run } from './spawn.js';\nrun(1);\n",
      'src/spawn.ts': [
        'export const EXIT_CODE = 42;',
        'export function run(code: number): boolean {',
        '  const EXIT_CODE = 42;',
        '  return code === EXIT_CODE;',
        '}',
        '',
      ].join('\n'),
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    // Dead, not merely "needlessly exported": dropping `export` alone would leave it unused.
    expect(find(r.findings, 'dead-export', 'src/spawn.ts', 'EXIT_CODE')).toBeDefined();
    expect(find(r.findings, 'unused-export', 'src/spawn.ts', 'EXIT_CODE')).toBeUndefined();
  });

  it('never reports compile-time gates, and treats a UI kit as medium confidence', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: 'src/main.ts' }),
      'src/main.ts':
        "import { KINDS } from './kinds.js';\nimport { Button } from './components/ui/kit.js';\nconsole.log(KINDS, Button);\n",
      'src/kinds.ts': [
        "export const KINDS = ['a', 'b'] as const;",
        "type Kind = 'a' | 'b';",
        'type AssertNever<T extends never> = T;',
        'export type KindCoverage = AssertNever<Exclude<Kind, (typeof KINDS)[number]>>;',
        '',
      ].join('\n'),
      'src/components/ui/kit.ts': 'export const Button = 1;\nexport const DialogClose = 2;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(r.findings.some((f) => f.name === 'KindCoverage')).toBe(false);
    expect(
      find(r.findings, 'dead-export', 'src/components/ui/kit.ts', 'DialogClose')?.confidence,
    ).toBe('medium');
  });

  it('tracks member reads of a dynamic import bound inside a function', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: 'src/main.ts' }),
      'src/main.ts': [
        'export async function load(): Promise<void> {',
        "  const mod = await import('./dyn.js');",
        '  mod.used();',
        '}',
        'void load();',
        '',
      ].join('\n'),
      'src/dyn.ts': 'export function used(): void {}\nexport function unused(): void {}\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'dead-export', 'src/dyn.ts', 'unused')).toBeDefined();
    expect(r.findings.some((f) => f.file === 'src/dyn.ts' && f.name === 'used')).toBe(false);
  });

  it('marks types reachable from an exported signature as low confidence, even through private types', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: 'src/main.ts' }),
      'src/main.ts': "import { wire } from './wiring.js';\nconsole.log(wire());\n",
      'src/wiring.ts': [
        'export interface Entry { at: number }',
        'interface Result { ring: Entry[] }',
        'export function wire(): Result {',
        '  return { ring: [] };',
        '}',
        '',
      ].join('\n'),
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unused-export', 'src/wiring.ts', 'Entry')?.confidence).toBe('low');
  });

  it('keeps files loaded by import.meta.glob alive, but only what the glob matches', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: 'src/main.ts' }),
      'src/main.ts': "import { routes } from './globby.js';\nroutes();\n",
      'src/globby.ts': "export const routes = (): unknown => import.meta.glob('./routes/*.ts');\n",
      'src/routes/one.ts': 'export const r1 = 1;\n',
      'src/routes/two.ts': 'export const r2 = 1;\n',
      // A single `*` does not cross `/`: unreachable even with a working glob.
      'src/routes/nested/deep.ts': 'export const deep = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(r.findings.some((f) => f.file === 'src/routes/one.ts')).toBe(false);
    expect(r.findings.some((f) => f.file === 'src/routes/two.ts')).toBe(false);
    expect(find(r.findings, 'unreachable-file', 'src/routes/nested/deep.ts')).toBeDefined();
  });

  it('tracks import.meta.glob array form and import.meta.resolve as loads', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: 'src/main.ts' }),
      'src/main.ts': "import { a, w } from './globby.js';\nconsole.log(a, w);\n",
      'src/globby.ts': [
        "export const a = (): unknown => import.meta.glob(['./arr/first.ts', './arr/second.ts']);",
        "export const w = (): string => import.meta.resolve('./resolved.js');",
        '',
      ].join('\n'),
      'src/arr/first.ts': 'export const f = 1;\n',
      'src/arr/second.ts': 'export const s = 2;\n',
      'src/resolved.ts': 'export const r = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    for (const live of ['src/arr/first.ts', 'src/arr/second.ts']) {
      expect(
        r.findings.some((f) => f.file === live),
        live,
      ).toBe(false);
    }
    // resolve() references the file without importing its exports: the file must
    // stay alive (no delete), while its unread exports may still be reported.
    expect(find(r.findings, 'unreachable-file', 'src/resolved.ts')).toBeUndefined();
  });

  it('keeps files loaded by a root-absolute import.meta.glob alive', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true }),
      'packages/app/package.json': JSON.stringify({
        name: 'app',
        private: true,
        main: './src/main.ts',
      }),
      'packages/app/src/main.ts': "import { routes } from './globby.js';\nroutes();\n",
      'packages/app/src/globby.ts':
        "export const routes = (): unknown => import.meta.glob('/packages/app/src/routes/*.ts');\n",
      'packages/app/src/routes/one.ts': 'export const r1 = 1;\n',
      'packages/app/src/routes/two.ts': 'export const r2 = 1;\n',
      // A single `*` never crosses `/`: unreachable even with a working glob.
      'packages/app/src/routes/nested/deep.ts': 'export const deep = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(r.findings.some((f) => f.file === 'packages/app/src/routes/one.ts')).toBe(false);
    expect(r.findings.some((f) => f.file === 'packages/app/src/routes/two.ts')).toBe(false);
    expect(
      find(r.findings, 'unreachable-file', 'packages/app/src/routes/nested/deep.ts'),
    ).toBeDefined();
  });

  it('follows package.json "imports" (#subpath) to their targets', async () => {
    const dir = project({
      'package.json': JSON.stringify({
        name: 'p',
        private: true,
        main: './src/main.ts',
        imports: { '#util': './src/util.ts', '#lib/*': './src/lib/*.ts' },
      }),
      'src/main.ts': "import { util } from '#util';\nimport { x } from '#lib/x';\nutil(x);\n",
      'src/util.ts': 'export function util(_: unknown): void {}\n',
      'src/lib/x.ts': 'export const x = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/util.ts')).toBeUndefined();
    expect(find(r.findings, 'unreachable-file', 'src/lib/x.ts')).toBeUndefined();
  });

  it('keeps every member of a namespace object the module exports', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: './src/main.ts' }),
      'src/main.ts':
        "import api from './api.js';\nimport { mod } from './dyn.js';\napi.run();\nmod.go();\n",
      'src/api.ts': "import * as impl from './impl.js';\nexport default impl;\n",
      'src/dyn.ts': "export const mod = await import('./other.js');\n",
      'src/impl.ts': 'export function run(): void {}\n',
      'src/other.ts': 'export function go(): void {}\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'dead-export', 'src/impl.ts', 'run')).toBeUndefined();
    expect(find(r.findings, 'dead-export', 'src/other.ts', 'go')).toBeUndefined();
  });

  it('credits the source of build output named by scripts and CI configs', async () => {
    const dir = project({
      'package.json': JSON.stringify({
        name: 'p',
        private: true,
        main: './dist/index.js',
        scripts: { worker: 'node dist/worker.js' },
      }),
      '.github/workflows/ci.yml': 'steps:\n  - run: node dist/job.js\n',
      'src/index.ts': 'export const x = 1;\n',
      'src/worker.ts': 'console.log(1);\n',
      'src/job.ts': 'console.log(2);\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/worker.ts')).toBeUndefined();
    expect(find(r.findings, 'unreachable-file', 'src/job.ts')).toBeUndefined();
  });

  it('publishes what an exports pattern maps to, even under a different public key', async () => {
    const dir = project({
      'package.json': JSON.stringify({
        name: '@x/ui',
        version: '1.0.0',
        exports: { '.': './dist/index.js', './features/*': './dist/feat/*.js' },
      }),
      'src/index.ts': 'export const root = 1;\n',
      'src/feat/a.ts': 'export const a = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/feat/a.ts')).toBeUndefined();
  });

  it('reads source folders named like build output (src/commands/build) as source', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: './src/main.ts' }),
      'src/main.ts': "import { run } from './commands/build/index.js';\nrun();\n",
      'src/commands/build/index.ts':
        "import { helper } from '../../util/helper.js';\nexport function run(): void { helper(); }\n",
      'src/util/helper.ts': 'export function helper(): void {}\n',
      'build/out.js': 'console.log(1);\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/util/helper.ts')).toBeUndefined();
    expect(r.findings.some((f) => f.file === 'build/out.js')).toBe(false);
  });

  it('keeps what .vue/.svelte components import, modules and dependencies alike', async () => {
    const dir = project({
      'package.json': JSON.stringify({
        name: 'p',
        private: true,
        main: './src/main.ts',
        dependencies: { 'vue-router': '4.0.0' },
      }),
      'src/main.ts': "import App from './App.vue';\nconsole.log(App);\n",
      'src/App.vue':
        "<script setup lang=\"ts\">\nimport { useX } from './useX';\nimport { createRouter } from 'vue-router';\nuseX(createRouter);\n</script>\n",
      'src/Widget.svelte': "<script>\n  import { w } from './w.js';\n</script>\n<p>{w}</p>\n",
      'src/useX.ts': 'export function useX(_: unknown): void {}\n',
      'src/w.ts': 'export const w = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/useX.ts')).toBeUndefined();
    expect(find(r.findings, 'unreachable-file', 'src/w.ts')).toBeUndefined();
    expect(find(r.findings, 'unused-dependency', 'package.json', 'vue-router')).toBeUndefined();
  });

  it('counts the automatic JSX runtime as a use of react', async () => {
    const dir = project({
      'package.json': JSON.stringify({
        name: 'p',
        private: true,
        main: './src/main.tsx',
        dependencies: { react: '19.0.0', 'react-dom': '19.0.0' },
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }),
      'src/main.tsx':
        "import { createRoot } from 'react-dom/client';\ncreateRoot(document.body).render(<div />);\n",
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unused-dependency', 'package.json', 'react')).toBeUndefined();
  });

  it('keeps files loaded by an import.meta.glob brace pattern alive', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: './src/main.ts' }),
      'src/main.ts':
        "export const routes = import.meta.glob('./routes/*.{ts,tsx}');\nconsole.log(routes);\n",
      'src/routes/a.ts': 'export const a = 1;\n',
      'src/routes/b.tsx': 'export const b = 1;\n',
      'src/routes/c.js': 'export const c = 1;\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/routes/a.ts')).toBeUndefined();
    expect(find(r.findings, 'unreachable-file', 'src/routes/b.tsx')).toBeUndefined();
    expect(find(r.findings, 'unreachable-file', 'src/routes/c.js')).toBeDefined();
  });

  it('maps tsconfig paths through the longest matching pattern, not the first declared', async () => {
    const dir = project({
      'package.json': JSON.stringify({ name: 'p', private: true, main: './src/main.ts' }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '*': ['./types/*'], '@/*': ['./src/*'] } },
      }),
      'src/main.ts': "import { helper } from '@/helper';\nhelper();\n",
      'src/helper.ts': 'export function helper(): void {}\n',
    });
    const r = await analyzeDeadCode(dir, { noCache: true });
    expect(find(r.findings, 'unreachable-file', 'src/helper.ts')).toBeUndefined();
  });
});
