import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __architectureHealthTestInternals,
  buildArchitectureHealth,
  collectIdentifiers,
  collectModuleSpecifiers,
  collectRuntimeExports,
  evaluateReportFreshness,
  findNonCommandSlashImports,
  findTestOnlyExports,
  FRESHNESS_REPORT_FILES,
  globToRegExp,
  loadArchitectureInputs,
  parseTsConfigFiles,
  renderArchitectureHealthMarkdown,
  stronglyConnectedComponents,
  validateHotspotBaseline,
  validateTestOnlyExportBaseline,
} from '../../../../scripts/lib/architecture-health.mjs';
import {
  parseVitestFileList,
  validateRuntimeTestInventory,
} from '../../../../scripts/lib/test-inventory.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('architecture health scanner', () => {
  it('builds and renders the repository architecture report end to end', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../../..');
    const { registry, exceptions, hotspots } = await loadArchitectureInputs(repoRoot);
    const report = await buildArchitectureHealth({
      repoRoot,
      registry,
      exceptions,
      hotspots,
      now: new Date('2026-07-30T00:00:00.000Z'),
    });
    const markdown = renderArchitectureHealthMarkdown(report);

    expect(report.generatedAt).toBe('2026-07-30T00:00:00.000Z');
    expect(report.packages.length).toBeGreaterThan(1);
    expect(report.summary.sourceFiles).toBeGreaterThan(100);
    expect(report.testOwnership.runtimeAssignments.length).toBeGreaterThan(100);
    expect(markdown).toContain('# Architecture Health Report');
    expect(markdown).toContain('TypeScript test coverage debt');
    expect(
      renderArchitectureHealthMarkdown({
        ...report,
        errors: [],
        scope: { ...report.scope, excludedPaths: [] },
        cycles: { ...report.cycles, runtime: [], type: [] },
      }),
    ).toContain('PASS — no blocking architecture-health errors.');
  }, 60_000);

  it('exercises filesystem, resolution, graph, matching, and exception edge cases', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'architecture-health-internals-'));
    temporaryRoots.push(root);
    const src = path.join(root, 'src');
    await mkdir(path.join(src, 'nested'), { recursive: true });
    await mkdir(path.join(src, 'dist'), { recursive: true });
    await writeFile(path.join(src, 'nested', 'index.ts'), 'export {};');
    await writeFile(path.join(src, 'ignore.txt'), 'ignore');
    await writeFile(path.join(src, 'dist', 'ignored.ts'), 'export {};');

    expect(await __architectureHealthTestInternals.pathExists(src)).toBe(true);
    expect(await __architectureHealthTestInternals.pathExists(path.join(root, 'missing'))).toBe(
      false,
    );
    expect(
      await __architectureHealthTestInternals.walk(path.join(root, 'missing'), () => true),
    ).toEqual([]);
    expect(
      await __architectureHealthTestInternals.walk(src, (file) => file.endsWith('.ts')),
    ).toEqual([path.join(src, 'nested', 'index.ts')]);
    expect(__architectureHealthTestInternals.isTestFile('a.test.mts')).toBe(true);
    expect(__architectureHealthTestInternals.isTestFile('a.ts')).toBe(false);
    expect(
      __architectureHealthTestInternals.stripSourceComments(
        '\'escaped\\\' quote\' "escaped\\" quote" `escaped\\` template` // tail\n/* block */x',
      ),
    ).toContain('x');
    expect(
      __architectureHealthTestInternals.candidatePaths(
        path.join(src, 'nested', 'index.js'),
        new Set(['.ts']),
      ),
    ).toContain(path.join(src, 'nested', 'index.ts'));
    expect(
      __architectureHealthTestInternals.candidatePaths(path.join(src, 'nested'), new Set(['.ts'])),
    ).toContain(path.join(src, 'nested', 'index.ts'));

    const known = new Set([path.normalize(path.join(src, 'nested', 'index.ts'))]);
    await expect(
      __architectureHealthTestInternals.resolveRelativeModule(
        path.join(src, 'entry.ts'),
        'external',
        known,
        new Set(['.ts']),
      ),
    ).resolves.toBeNull();
    await expect(
      __architectureHealthTestInternals.resolveRelativeModule(
        path.join(src, 'entry.ts'),
        './nested/index.js',
        known,
        new Set(['.ts']),
      ),
    ).resolves.toBe(path.normalize(path.join(src, 'nested', 'index.ts')));
    await expect(
      __architectureHealthTestInternals.resolveRelativeModule(
        path.join(src, 'entry.ts'),
        './missing.js',
        known,
        new Set(['.ts']),
      ),
    ).resolves.toBeNull();

    const graphEdges = [
      { from: 'a', to: 'b', typeOnly: true },
      { from: 'b', to: 'a', typeOnly: false },
    ];
    expect(__architectureHealthTestInternals.findGraphCycles(['a', 'b'], graphEdges, true)).toEqual(
      [],
    );
    expect(
      __architectureHealthTestInternals.findGraphCycles(['a', 'b'], graphEdges, false),
    ).toEqual([['a', 'b']]);
    expect(__architectureHealthTestInternals.findGraphCycles(['orphan'], [], false)).toEqual([]);
    expect(
      __architectureHealthTestInternals.findPackageCycles([
        { name: 'a', workspaceDependencies: ['b'] },
        { name: 'b', workspaceDependencies: ['a'] },
      ]),
    ).toEqual([['a', 'b']]);

    const project = {
      exactFiles: ['exact.test.ts'],
      excludeFiles: ['excluded.test.ts'],
      excludePrefixes: ['skip/'],
      includePrefixes: ['tests/'],
    };
    expect(__architectureHealthTestInternals.matchesTestProject('exact.test.ts', project)).toBe(
      true,
    );
    expect(__architectureHealthTestInternals.matchesTestProject('excluded.test.ts', project)).toBe(
      false,
    );
    expect(__architectureHealthTestInternals.matchesTestProject('skip/a.test.ts', project)).toBe(
      false,
    );
    expect(__architectureHealthTestInternals.matchesTestProject('tests/a.test.ts', project)).toBe(
      true,
    );
    expect(__architectureHealthTestInternals.matchesTestProject('other.test.ts', project)).toBe(
      false,
    );
    expect(
      JSON.parse(__architectureHealthTestInternals.stripJsonComments('{"a": 1, // x\n}')),
    ).toEqual({ a: 1 });

    const valid = {
      id: 'valid',
      kind: 'runtime-module-cycle',
      members: ['b', 'a'],
      owner: 'owner',
      reason: 'reason',
      introduced: '2026-01-01',
      reviewBy: '2027-01-01',
      removeWhen: 'fixed',
      canonicalTask: 'task',
    };
    const exceptions = __architectureHealthTestInternals.validateExceptions(
      {
        exceptions: [
          valid,
          { ...valid },
          { ...valid, id: 'duplicate-cycle' },
          { ...valid, id: 'expired', members: ['x'], reviewBy: '2020-01-01' },
          { ...valid, id: 'invalid-date', members: ['y'], reviewBy: 'invalid' },
          { ...valid, id: 'missing-members', members: undefined },
          { ...valid, id: 'slash', kind: 'slash-command-import', members: ['z'] },
          { ...valid, id: 'unsupported', members: [], kind: 'other' },
          {},
        ],
      },
      [
        { kind: 'runtime-module-cycle', members: ['a', 'b'] },
        { kind: 'type-module-cycle', members: ['unmatched'] },
      ],
      new Date('2026-07-30T00:00:00.000Z'),
    );
    expect(exceptions.matched).toEqual(['duplicate-cycle']);
    expect(exceptions.unexcepted).toEqual([{ kind: 'type-module-cycle', members: ['unmatched'] }]);
    expect(exceptions.errors.join('\n')).toContain('duplicates exception');
    expect(exceptions.errors.join('\n')).toContain('duplicate exception id');
    expect(exceptions.errors.join('\n')).toContain('exception expired');
    expect(exceptions.errors.join('\n')).toContain('invalid reviewBy');
    expect(exceptions.errors.join('\n')).toContain('unsupported kind');
    expect(exceptions.errors.join('\n')).toContain("missing required field 'kind'");
    expect(exceptions.errors.join('\n')).toContain('exception no longer matches');
  });

  it('parses valid and invalid TypeScript config ownership', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'architecture-health-tsconfig-'));
    temporaryRoots.push(root);
    const packageDir = path.join(root, 'packages', 'sample');
    const testsDir = path.join(packageDir, 'tests');
    await mkdir(testsDir, { recursive: true });
    const testFile = path.join(testsDir, 'owned.test.ts');
    await writeFile(testFile, 'export {};');
    await writeFile(path.join(packageDir, 'tsconfig.json'), '{}');
    await writeFile(
      path.join(packageDir, 'tsconfig.test.json'),
      '{"include": ["tests/**/*.test.ts"], "exclude": ["tests/excluded/**"],}',
    );
    await writeFile(path.join(packageDir, 'tsconfig.invalid.json'), '{broken');

    const configs = await parseTsConfigFiles(root, packageDir, [testFile]);
    expect(configs).toEqual([
      {
        path: 'packages/sample/tsconfig.invalid.json',
        error: expect.any(String),
        testFiles: [],
      },
      {
        path: 'packages/sample/tsconfig.json',
        error: null,
        testFiles: [],
      },
      {
        path: 'packages/sample/tsconfig.test.json',
        error: null,
        testFiles: ['packages/sample/tests/owned.test.ts'],
      },
    ]);
  });

  it('collects side-effect and import-equals module forms', () => {
    expect(
      collectModuleSpecifiers(
        [
          "import './side-effect.js';",
          "import Legacy = require('./legacy.js');",
          "import type Contract = require('./contract.js');",
          "const runtime = require('./runtime.cjs');",
        ].join('\n'),
        'fixture.ts',
      ),
    ).toEqual([
      { specifier: './side-effect.js', typeOnly: false, syntax: 'import' },
      { specifier: './legacy.js', typeOnly: false, syntax: 'require' },
      { specifier: './contract.js', typeOnly: false, syntax: 'require' },
      { specifier: './runtime.cjs', typeOnly: false, syntax: 'require' },
      { specifier: './legacy.js', typeOnly: false, syntax: 'import-equals' },
      { specifier: './contract.js', typeOnly: true, syntax: 'import-equals' },
    ]);
  });

  it('reports every build-level architecture violation from a fixture workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'architecture-health-build-'));
    temporaryRoots.push(root);
    const writePackage = async (
      name: string,
      manifest: Record<string, unknown>,
      files: Record<string, string>,
    ) => {
      const dir = path.join(root, 'packages', name);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest));
      for (const [relative, source] of Object.entries(files)) {
        const target = path.join(dir, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, source);
      }
    };
    await writePackage(
      'core',
      { name: 'core', dependencies: { a: 'workspace:*' } },
      {
        'src/unclassified/a.ts': "import './b.js';",
        'src/unclassified/b.ts': "import './a.js';",
      },
    );
    await writePackage(
      'a',
      { name: 'a', dependencies: { b: 'workspace:*' } },
      {
        'src/index.ts': 'export {};',
        'tests/a.test.ts': 'export {};',
      },
    );
    await writePackage(
      'b',
      { name: 'b', dependencies: { a: 'workspace:*' } },
      {
        'src/index.ts': 'export {};',
      },
    );
    await writePackage(
      'unnamed',
      {},
      {
        'src/index.ts': 'export {};',
      },
    );
    await writePackage(
      'cli',
      { name: 'cli' },
      {
        'src/execution.ts': "import './slash-commands/foo.js';",
        'src/slash-commands/foo.ts': 'export {};',
      },
    );
    await writePackage(
      'excluded',
      { name: 'excluded' },
      {
        'src/index.ts': 'export {};',
      },
    );
    await mkdir(path.join(root, 'packages', 'no-manifest'), { recursive: true });
    await writeFile(path.join(root, 'packages', 'README.md'), 'not a package');

    const report = await buildArchitectureHealth({
      repoRoot: root,
      registry: {
        scope: {
          workspaceRoots: ['missing', 'packages'],
          excludedPaths: ['packages/excluded'],
        },
        sourceExtensions: ['.ts'],
        coreAreas: { stale: {} },
        testProjects: [],
      },
      exceptions: {},
      hotspots: { thresholdLines: 1_000, files: {} },
    });

    expect(report.errors.join('\n')).toContain('workspace package cycle');
    expect(report.errors.join('\n')).toContain('unclassified Core areas');
    expect(report.errors.join('\n')).toContain('stale Core registry areas');
    expect(report.errors.join('\n')).toContain('without exactly one runtime project');
    expect(report.errors.join('\n')).toContain('non-command module imports');
    expect(report.errors.join('\n')).toContain('unexcepted module cycle');

    const cleanRoot = await mkdtemp(path.join(tmpdir(), 'architecture-health-clean-'));
    temporaryRoots.push(cleanRoot);
    await mkdir(path.join(cleanRoot, 'packages', 'core', 'src'), { recursive: true });
    await writeFile(
      path.join(cleanRoot, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: 'core' }),
    );
    const clean = await buildArchitectureHealth({
      repoRoot: cleanRoot,
      registry: {
        scope: { workspaceRoots: ['packages'], excludedPaths: [] },
        sourceExtensions: ['.ts'],
        coreAreas: {},
        testProjects: [],
      },
      exceptions: {},
      hotspots: { thresholdLines: 1_000, files: {} },
    });
    expect(clean.errors).toEqual([]);
  });

  it('classifies runtime and type-only module edges', () => {
    const imports = collectModuleSpecifiers(
      [
        "import { value } from './runtime.js';",
        "import type { Contract } from './contract.js';",
        "import { type OtherContract } from './other-contract.js';",
        "export type { PublicContract } from './public-contract.js';",
        "export { publicValue } from './public-value.js';",
        "const lazy = import('./lazy.js');",
        "type LazyContract = import('./lazy-contract.js').LazyContract;",
      ].join('\n'),
      'fixture.ts',
    );

    expect(imports).toEqual([
      { specifier: './runtime.js', typeOnly: false, syntax: 'import' },
      { specifier: './contract.js', typeOnly: true, syntax: 'import' },
      { specifier: './other-contract.js', typeOnly: true, syntax: 'import' },
      { specifier: './public-contract.js', typeOnly: true, syntax: 'export' },
      { specifier: './public-value.js', typeOnly: false, syntax: 'export' },
      { specifier: './lazy.js', typeOnly: false, syntax: 'dynamic-import' },
      { specifier: './lazy-contract.js', typeOnly: true, syntax: 'dynamic-import' },
    ]);
  });

  it('ignores import examples in comments and template fixtures', () => {
    const imports = collectModuleSpecifiers(
      [
        "// import { fake } from './comment.js';",
        "/** @see import('./docs.js').Docs */",
        "const fixture = `import { fake } from './template.js'`;",
        "import { real } from './real.js';",
      ].join('\n'),
      'fixture.ts',
    );

    expect(imports).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);
  });

  it('ignores export examples inside regex literals and following comments', () => {
    // Regression: a regex literal containing quote characters (e.g. `['"]`)
    // used to desynchronise stripSourceComments' string-state machine, which
    // leaked subsequent comment text such as `// export { X } from './fake.js'`
    // into the module-edge scan and fabricated phantom dependency cycles.
    const regexLiteralLine = String.raw`const re = /export\s+from\s+['"]([^'"]+)['"]/g;`;
    const imports = collectModuleSpecifiers(
      [
        regexLiteralLine,
        "// export { fake } from './line-comment.js';",
        "/* export { fake } from './block-comment.js'; */",
        "import { real } from './real.js';",
      ].join('\n'),
      'fixture.ts',
    );

    expect(imports).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);
  });

  it('keeps JSX closing tags, regex flags, in-class slashes, and postfix ops from opening false regexes', () => {
    // JSX closing tag: `/` after `<` is a tag close, not a regex literal start.
    expect(
      collectModuleSpecifiers(
        ["const el = <div>{'a/b'}</div>;", "import { real } from './real.js';"].join('\n'),
        'fixture.tsx',
      ),
    ).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);

    // Regex flags then division: `/re/g / 2` closes the regex at the flagged `/`.
    expect(
      collectModuleSpecifiers(
        ["const x = /re/g / 2;", "import { real } from './real.js';"].join('\n'),
        'fixture.ts',
      ),
    ).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);

    // In-class slash: `/[a/b]/` must not close at the slash inside `[...]`.
    expect(
      collectModuleSpecifiers(
        ["const x = /[a/b]/;", "import { real } from './real.js';"].join('\n'),
        'fixture.ts',
      ),
    ).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);

    // Postfix increment before division: `n++ / 2` is division, not a regex.
    expect(
      collectModuleSpecifiers(
        ["const x = n++ / 2;", "import { real } from './real.js';"].join('\n'),
        'fixture.ts',
      ),
    ).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);
  });

  it('treats a lone `>` as division but an `=>` arrow as regex-preceding', () => {
    // Relational division after a lone `>` must NOT open a regex that swallows
    // the following import (a `/` after `>` is division here, not a regex).
    expect(
      collectModuleSpecifiers(
        ['const x = a > / b;', "import { real } from './real.js';"].join('\n'),
        'fixture.ts',
      ),
    ).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);

    // Arrow body: `=> /['"]/ ` is a regex; quotes inside must not desync the scan.
    expect(
      collectModuleSpecifiers(
        ['const f = () => /[\'"]/.test(s);', "import { real } from './real.js';"].join('\n'),
        'fixture.ts',
      ),
    ).toEqual([{ specifier: './real.js', typeOnly: false, syntax: 'import' }]);
  });

  it('reports only strongly connected graph components', () => {
    const adjacency = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['a', 'c'])],
      ['c', new Set<string>()],
      ['d', new Set(['d'])],
    ]);

    expect(stronglyConnectedComponents(adjacency.keys(), adjacency)).toEqual([['a', 'b'], ['d']]);
    expect(stronglyConnectedComponents(['missing'], new Map())).toEqual([]);
  });

  it('matches zero or more directories for double-star globs', () => {
    const pattern = globToRegExp('tests/**/*.test.ts');
    expect(pattern.test('tests/direct.test.ts')).toBe(true);
    expect(pattern.test('tests/nested/example.test.ts')).toBe(true);
    expect(pattern.test('src/example.test.ts')).toBe(false);
  });

  it('matches single-star, question-mark, and escaped regex characters in globs', () => {
    const pattern = globToRegExp('packages/*/tests/file?.test.ts');
    expect(pattern.test('packages/core/tests/file1.test.ts')).toBe(true);
    expect(pattern.test('packages/core/nested/tests/file1.test.ts')).toBe(false);
    expect(pattern.test('packages/core/tests/file12.test.ts')).toBe(false);
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
    expect(globToRegExp('src/**.ts').test('src/nested/file.ts')).toBe(true);
  });

  it('blocks reusable CLI modules from importing command adapters', () => {
    const edges = [
      {
        from: 'packages/cli/src/execution.ts',
        to: 'packages/cli/src/slash-commands/statusline.ts',
      },
      {
        from: 'packages/cli/src/cli-main.ts',
        to: 'packages/cli/src/slash-commands/index.ts',
      },
      {
        from: 'packages/cli/src/slash-commands/statusline.ts',
        to: 'packages/cli/src/slash-commands/helpers.ts',
      },
    ];

    expect(findNonCommandSlashImports(edges)).toEqual([edges[0]]);
  });

  it('requires reviewed hotspot baseline changes for growth and shrinkage', () => {
    const result = validateHotspotBaseline(
      [
        { file: 'src/growing.ts', lines: 900, relativeImports: 8 },
        { file: 'src/shrinking.ts', lines: 850, relativeImports: 3 },
        { file: 'src/new.ts', lines: 801, relativeImports: 1 },
      ],
      {
        thresholdLines: 800,
        files: {
          'src/growing.ts': { lines: 880, relativeImports: 7 },
          'src/shrinking.ts': { lines: 900, relativeImports: 4 },
          'src/deleted.ts': { lines: 810, relativeImports: 2 },
        },
      },
    );

    expect(result.errors).toEqual([
      'src/growing.ts: hotspot grew from 880 to 900 lines; review and update the ratchet in the same change',
      'src/growing.ts: relative import fan-out increased from 7 to 8; review and update the ratchet in the same change',
      'src/shrinking.ts: hotspot shrunk from 900 to 850 lines; review and update the ratchet in the same change',
      'src/shrinking.ts: relative import fan-out decreased from 4 to 3; review and update the ratchet in the same change',
      'src/new.ts: new 801-line hotspot is not in architecture/hotspots.json',
      'src/deleted.ts: stale hotspot baseline; remove or tighten it in the same change',
    ]);
  });

  it('parses and normalizes Vitest file-list JSON', () => {
    expect(
      parseVitestFileList(
        'C:\\repo',
        JSON.stringify([
          { file: 'C:\\repo\\packages\\core\\tests\\b.test.ts' },
          { file: 'C:\\repo\\packages\\core\\tests\\a.test.ts' },
          { file: 'C:\\repo\\packages\\core\\tests\\a.test.ts' },
        ]),
      ),
    ).toEqual(['packages/core/tests/a.test.ts', 'packages/core/tests/b.test.ts']);
  });

  it('rejects malformed Vitest file-list output', () => {
    expect(() => parseVitestFileList('C:\\repo', 'not-json')).toThrow(
      'Vitest returned invalid JSON',
    );
    expect(() => parseVitestFileList('C:\\repo', '{}')).toThrow('must be a JSON array');
    expect(() => parseVitestFileList('C:\\repo', '[{}]')).toThrow('without a file path');
    expect(parseVitestFileList('/repo', JSON.stringify(['tests/a.test.ts']))).toEqual([
      'tests/a.test.ts',
    ]);
    const parse = JSON.parse;
    JSON.parse = () => {
      throw 'plain failure';
    };
    try {
      expect(() => parseVitestFileList('/repo', 'ignored')).toThrow('plain failure');
    } finally {
      JSON.parse = parse;
    }
  });

  it('rejects zero collection, missing files, unexpected files, and overlapping projects', () => {
    const result = validateRuntimeTestInventory(
      [
        { file: 'packages/a/tests/a.test.ts', projects: ['node'] },
        { file: 'packages/b/tests/b.test.ts', projects: ['jsdom'] },
      ],
      new Map([
        ['node', ['packages/a/tests/a.test.ts', 'packages/extra/tests/x.test.ts']],
        ['jsdom', []],
        ['duplicate', ['packages/a/tests/a.test.ts']],
      ]),
      ['node', 'jsdom', 'duplicate'],
    );

    expect(result.errors).toEqual([
      'node: 1 unexpected test file(s) were collected: packages/extra/tests/x.test.ts',
      'jsdom: Vitest collected zero test files',
      'jsdom: 1 expected test file(s) were not collected: packages/b/tests/b.test.ts',
      'duplicate: 1 unexpected test file(s) were collected: packages/a/tests/a.test.ts',
      'packages/a/tests/a.test.ts: collected by multiple runtime projects: duplicate, node',
    ]);
  });

  it('reports unknown assignments and returns clean per-project rows', () => {
    const result = validateRuntimeTestInventory(
      [
        { file: 'ignored.test.ts', projects: ['node', 'jsdom'] },
        { file: 'unknown.test.ts', projects: ['missing'] },
        { file: 'node.test.ts', projects: ['node'] },
      ],
      new Map([['node', ['node.test.ts']]]),
      ['node'],
    );
    expect(result.errors).toEqual(['unknown.test.ts: assigned to unknown runtime project missing']);
    expect(result.projects).toEqual([
      {
        projectId: 'node',
        expected: 1,
        collected: 1,
        missing: [],
        unexpected: [],
      },
    ]);

    expect(validateRuntimeTestInventory([], new Map(), ['empty']).projects).toEqual([
      {
        projectId: 'empty',
        expected: 0,
        collected: 0,
        missing: [],
        unexpected: [],
      },
    ]);
  });
});

/**
 * Dead-but-covered code. The audit named six live examples — `viz-store`'s
 * pruners, `useFleetPolling`, `tui/input-validation`, `privileged-actions.ts`,
 * `settings-panel-reducers.ts`, `cli/config-history.ts` — all of them exported,
 * all of them carrying green tests, none of them reached from production. A
 * passing suite over an unreachable function reads exactly like a passing suite
 * over a working feature, which is why nobody noticed.
 *
 * The check answers one question mechanically: does anything other than a test
 * mention this export?
 */
describe('test-only export detection', () => {
  it('collects runtime exports and skips types and re-exports', () => {
    const names = collectRuntimeExports(`
      export function alpha() {}
      export const beta = 1;
      export class Gamma {}
      export enum Delta { A }
      export interface Epsilon { a: string }
      export type Zeta = string;
      export { eta, theta as iota };
      export { kappa } from './elsewhere.js';
      export type { Lambda } from './elsewhere.js';
    `);
    expect([...names].sort()).toEqual(['Delta', 'Gamma', 'alpha', 'beta', 'eta', 'iota']);
    // A barrel forwarding a name is not the name's definition; counting it as
    // one would report the same symbol from every layer that passes it along.
    expect(names.has('kappa')).toBe(false);
    expect(names.has('Epsilon')).toBe(false);
  });

  it('ignores identifiers that appear only in comments', () => {
    const identifiers = collectIdentifiers('// mentionsGhost\nconst real = 1;');
    expect(identifiers.has('real')).toBe(true);
    expect(identifiers.has('mentionsGhost')).toBe(false);
  });

  it('flags an export that only a test mentions', () => {
    const found = findTestOnlyExports({
      exportsByFile: new Map([['pkg/src/a.ts', new Set(['onlyTested', 'alsoUsed'])]]),
      sourceIdentifiers: new Map([
        ['onlyTested', { files: 1, firstFile: 'pkg/src/a.ts' }],
        ['alsoUsed', { files: 2, firstFile: 'pkg/src/a.ts' }],
      ]),
      testIdentifiers: new Set(['onlyTested', 'alsoUsed']),
    });
    expect(found).toEqual([{ file: 'pkg/src/a.ts', name: 'onlyTested' }]);
  });

  it('does not flag an export nothing references at all', () => {
    // Unreferenced everywhere is a different finding (plain dead code) and the
    // name-matching heuristic is far weaker there — a symbol reached only
    // through a dynamic lookup would be reported wrongly. This check is scoped
    // to the shape it can prove: tests reference it, production does not.
    const found = findTestOnlyExports({
      exportsByFile: new Map([['pkg/src/a.ts', new Set(['orphan'])]]),
      sourceIdentifiers: new Map([['orphan', { files: 1, firstFile: 'pkg/src/a.ts' }]]),
      testIdentifiers: new Set(),
    });
    expect(found).toEqual([]);
  });

  it('counts a single non-defining source file as real usage', () => {
    const found = findTestOnlyExports({
      exportsByFile: new Map([['pkg/src/a.ts', new Set(['shared'])]]),
      // Seen once, in a file that is NOT the definer — a genuine consumer.
      sourceIdentifiers: new Map([['shared', { files: 1, firstFile: 'pkg/src/b.ts' }]]),
      testIdentifiers: new Set(['shared']),
    });
    expect(found).toEqual([]);
  });

  it('ratchets: new entries fail, and stale baseline entries fail too', () => {
    const baseline = { schemaVersion: 1, files: { 'pkg/src/a.ts': ['known'] } };

    expect(
      validateTestOnlyExportBaseline([{ file: 'pkg/src/a.ts', name: 'known' }], baseline).errors,
    ).toEqual([]);

    const withNew = validateTestOnlyExportBaseline(
      [
        { file: 'pkg/src/a.ts', name: 'known' },
        { file: 'pkg/src/a.ts', name: 'fresh' },
      ],
      baseline,
    );
    expect(withNew.errors).toHaveLength(1);
    expect(withNew.errors[0]).toContain('fresh');
    expect(withNew.errors[0]).toContain('only tests reference it');

    const nowWired = validateTestOnlyExportBaseline([], baseline);
    expect(nowWired.errors).toHaveLength(1);
    expect(nowWired.errors[0]).toContain('no longer test-only');
  });
});

describe('report freshness gate', () => {
  function git(cwd: string, ...args: string[]) {
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  }

  /**
   * Commit with an explicit committer/author timestamp: git's %cI has
   * one-second resolution, and undated rapid commits here would collide
   * into the same second, making stale scenarios read fresh.
   */
  function commitAt(cwd: string, dateIso: string, message: string) {
    execFileSync('git', ['commit', '-qm', message], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_COMMITTER_DATE: dateIso, GIT_AUTHOR_DATE: dateIso },
    });
  }

  async function initScratchRepo(tag: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), `freshness-${tag}-`));
    temporaryRoots.push(dir);
    await mkdir(path.join(dir, 'packages/x'), { recursive: true });
    await mkdir(path.join(dir, 'docs/reports'), { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    await writeFile(path.join(dir, 'packages/x/a.ts'), 'export const a = 1;\n');
    git(dir, 'add', '.');
    commitAt(dir, '2026-01-01T00:00:00Z', 'source');
    return dir;
  }

  async function commitReportPair(dir: string, stamp: string): Promise<void> {
    for (const rel of FRESHNESS_REPORT_FILES) {
      await writeFile(path.join(dir, rel), `${stamp}\n`);
    }
    git(dir, 'add', 'docs/reports');
    commitAt(dir, '2026-01-01T00:00:01Z', `report ${stamp}`);
  }

  it('is fresh when the report pair is committed after the newest source commit', async () => {
    const dir = await initScratchRepo('fresh');
    await commitReportPair(dir, 'newer');
    expect(evaluateReportFreshness(dir).status).toBe('fresh');
  });

  it('is stale when a source-only commit lands after the report pair', async () => {
    const dir = await initScratchRepo('stale');
    await commitReportPair(dir, 'first');
    await writeFile(path.join(dir, 'packages/x/a.ts'), 'export const a = 2;\n');
    git(dir, 'add', 'packages');
    commitAt(dir, '2026-01-01T00:00:02Z', 'source-only');
    const verdict = evaluateReportFreshness(dir);
    expect(verdict.status).toBe('stale');
    expect(verdict.reason).toBe('stale-committed-evidence');
  });

  it('is fresh when one commit touches both sources and the report pair (same-PR flow)', async () => {
    const dir = await initScratchRepo('same-commit');
    await commitReportPair(dir, 'first');
    await writeFile(path.join(dir, 'packages/x/a.ts'), 'export const a = 3;\n');
    await writeFile(path.join(dir, FRESHNESS_REPORT_FILES[0]), '{"v":3}\n');
    await writeFile(path.join(dir, FRESHNESS_REPORT_FILES[1]), '# r3\n');
    git(dir, 'add', '.');
    commitAt(dir, '2026-01-01T00:00:02Z', 'source+report together');
    expect(evaluateReportFreshness(dir).status).toBe('fresh');
  });

  it('stays stale on a partial regen that recommits only one report file', async () => {
    const dir = await initScratchRepo('partial');
    await commitReportPair(dir, 'first');
    await writeFile(path.join(dir, 'packages/x/a.ts'), 'export const a = 4;\n');
    git(dir, 'add', 'packages');
    commitAt(dir, '2026-01-01T00:00:02Z', 'source-only');
    await writeFile(path.join(dir, FRESHNESS_REPORT_FILES[0]), '{"v":4}\n');
    git(dir, 'add', FRESHNESS_REPORT_FILES[0]);
    commitAt(dir, '2026-01-01T00:00:03Z', 'regen json only');
    const verdict = evaluateReportFreshness(dir);
    expect(verdict.status).toBe('stale');
    // The .md never moved past the original pair commit → older-of-the-pair.
    expect(verdict.reportCommitMs).toBe(Date.parse('2026-01-01T00:00:01Z'));
  });

  it('is stale when a report file exists on disk but has no commit history', async () => {
    const dir = await initScratchRepo('never-committed');
    // Files exist on disk but were never staged or committed: git log for
    // them is empty, which maps to 0 (older than every source commit).
    await writeFile(path.join(dir, FRESHNESS_REPORT_FILES[0]), '{}\n');
    await writeFile(path.join(dir, FRESHNESS_REPORT_FILES[1]), '# r\n');
    const verdict = evaluateReportFreshness(dir);
    expect(verdict.status).toBe('stale');
    expect(verdict.reportCommitMs).toBe(0);
  });

  it('skips with a warning-shaped result when git history is unavailable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'freshness-nogit-'));
    temporaryRoots.push(dir);
    await mkdir(path.join(dir, 'packages/x'), { recursive: true });
    await mkdir(path.join(dir, 'docs/reports'), { recursive: true });
    const verdict = evaluateReportFreshness(dir);
    expect(verdict.status).toBe('skipped');
    expect(verdict.reason).toBe('git-history-unavailable');
  });

  it('skips on a shallow clone instead of reporting a false fresh (actions/checkout fetch-depth: 1 shape)', async () => {
    const dir = await initScratchRepo('shallow-src');
    await commitReportPair(dir, 'first');
    await writeFile(path.join(dir, 'packages/x/a.ts'), 'export const a = 9;\n');
    git(dir, 'add', 'packages');
    commitAt(dir, '2026-01-01T00:00:02Z', 'source-only');
    // The full clone of this tree is stale — proving the shallow verdict
    // below is a deliberate skip for this scenario, not an accident.
    expect(evaluateReportFreshness(dir).status).toBe('stale');

    const dst = await mkdtemp(path.join(tmpdir(), 'freshness-shallow-'));
    temporaryRoots.push(dst);
    git(dir, 'clone', '--quiet', '--depth', '1', '--no-local', pathToFileURL(dir).href, dst);
    // At the shallow boundary the tip commit has no parent, so path-filtered
    // log treats every path as newly added at HEAD — undecidable, not fresh.
    const verdict = evaluateReportFreshness(dst);
    expect(verdict.status).toBe('skipped');
    expect(verdict.reason).toBe('shallow-repository');
  });
});
