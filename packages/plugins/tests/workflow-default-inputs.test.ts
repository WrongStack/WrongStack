/**
 * Workflow tools fill inputs the project already knows.
 *
 * These tools used to require the model to list every changed file, every
 * source file or every workspace manifest by hand. Omitted, those fields now
 * default to the working-tree change (read-only git), the declared workspace
 * packages, a bounded source walk, or the conventional root file — and say
 * which source they used. A default that cannot be computed fails loudly.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Plugin, PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import architectureBoundaryChecker from '../src/architecture-boundary-checker/index.js';
import bugReproducer from '../src/bug-reproducer/index.js';
import decisionJournal from '../src/decision-journal/index.js';
import developerEnvironmentDoctor from '../src/developer-environment-doctor/index.js';
import executableDocumentation from '../src/executable-documentation/index.js';
import featureFlagLifecycle from '../src/feature-flag-lifecycle/index.js';
import monorepoChangePlanner from '../src/monorepo-change-planner/index.js';
import verificationLedger from '../src/verification-ledger/index.js';
import workspaceRecipeRunner from '../src/workspace-recipe-runner/index.js';

type Result = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function call(plugin: Plugin, tool: string, input: unknown, root: string): Promise<Result> {
  const tools = new Map<string, Tool>();
  const api = {
    config: { extensions: {} },
    log: { info() {}, warn() {}, error() {} },
    tools: { register: (t: Tool) => void tools.set(t.name, t) },
  } as unknown as PluginAPI;
  plugin.setup(api);
  cleanups.push(async () => {
    await plugin.teardown?.(api);
  });
  return (await tools.get(tool)!.execute(input, { projectRoot: root, cwd: root } as never, {
    signal: new AbortController().signal,
  })) as Result;
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workflow-defaults-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function git(root: string, ...args: string[]) {
  execFileSync(
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
    { cwd: root, windowsHide: true, stdio: 'ignore' },
  );
}

async function repo(files: Record<string, string>): Promise<string> {
  const root = await project(files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const workspace = {
  'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['p/*'] }),
  'p/a/package.json': JSON.stringify({ name: 'a', scripts: { test: 'x' } }),
  'p/a/src/index.ts': "export const a = 1;\nconst flag = 'NEW_CHECKOUT';\n",
  'p/b/package.json': JSON.stringify({ name: 'b', dependencies: { a: 'workspace:*' } }),
  'p/b/src/index.ts': "import { a } from '../../a/src/index';\nexport const b = a;\n",
  'p/c/package.json': JSON.stringify({ name: 'c' }),
};

describe('workflow default inputs from git', { timeout: 60_000 }, () => {
  it('monorepo plan discovers the workspace and the working-tree change', async () => {
    const root = await repo(workspace);
    expect(await call(monorepoChangePlanner, 'monorepo_change_plan', {}, root)).toMatchObject({
      affected: [],
      inputs: { manifests: 'workspace', changedFiles: 'git' },
    });
    await writeFile(join(root, 'p/a/src/index.ts'), 'export const a = 2;\n');
    await writeFile(join(root, 'tsconfig.base.json'), '{}');
    const plan = await call(monorepoChangePlanner, 'monorepo_change_plan', {}, root);
    expect(plan).toMatchObject({
      directlyChanged: ['a'],
      unknownChanges: ['tsconfig.base.json'],
      validationOrder: [
        { name: 'a', scripts: ['test'] },
        { name: 'b', scripts: [] },
      ],
    });
    expect(plan['affected']).not.toContain('c');
  });

  it('bug reproduction and verification fingerprint the changed files by default', async () => {
    const root = await repo({ 'src/x.ts': 'export const x = 1;\n' });
    const command = {
      program: process.execPath,
      args: ['-e', "console.log('boom');process.exit(1)"],
    };
    await expect(
      call(bugReproducer, 'bug_reproduce', { command, expectedOutput: 'boom' }, root),
    ).rejects.toThrow(/no changes/);
    await writeFile(join(root, 'src/x.ts'), 'export const x = 2;\n');
    const reproduced = await call(
      bugReproducer,
      'bug_reproduce',
      { command, expectedOutput: 'boom' },
      root,
    );
    expect(reproduced).toMatchObject({ status: 'reproduced', filesSource: 'git' });
    expect(Object.keys(reproduced['fingerprints'] as object)).toEqual(['src/x.ts']);
    const recorded = await call(
      verificationLedger,
      'verification_record',
      { command, label: 'x' },
      root,
    );
    expect(recorded).toMatchObject({ files: ['src/x.ts'] });
  });

  it('decision lookup matches decisions against the changed files by default', async () => {
    const root = await repo({
      'docs/decisions.jsonl': '',
      'src/pay/charge.ts': 'export {};\n',
    });
    await call(
      decisionJournal,
      'decision_record',
      {
        journal: 'docs/decisions.jsonl',
        title: 'Idempotent charges',
        rationale: 'retries',
        files: ['src/pay'],
      },
      root,
    );
    await writeFile(join(root, 'src/pay/charge.ts'), 'export const c = 1;\n');
    const found = await call(
      decisionJournal,
      'decision_lookup',
      { journal: 'docs/decisions.jsonl' },
      root,
    );
    expect(found['decisions']).toEqual([expect.objectContaining({ title: 'Idempotent charges' })]);
  });

  it('skips deleted files in a git default but the planner still counts them', async () => {
    const root = await repo({ ...workspace, 'p/c/src/old.ts': 'export {};\n' });
    await rm(join(root, 'p/c/src/old.ts'));
    await writeFile(join(root, 'p/a/src/index.ts'), 'export const a = 3;\n');
    const command = {
      program: process.execPath,
      args: ['-e', "console.log('boom');process.exit(1)"],
    };
    const result = await call(
      bugReproducer,
      'bug_reproduce',
      { command, expectedOutput: 'boom' },
      root,
    );
    expect(Object.keys(result['fingerprints'] as object)).toEqual(['p/a/src/index.ts']);
    const plan = await call(monorepoChangePlanner, 'monorepo_change_plan', {}, root);
    expect(plan['directlyChanged']).toEqual(expect.arrayContaining(['a', 'c']));
  });

  it('a git default outside a repository fails loudly', async () => {
    const root = await project({ 'package.json': JSON.stringify({ name: 'solo' }) });
    await expect(
      call(
        bugReproducer,
        'bug_reproduce',
        { command: { program: process.execPath }, expectedOutput: 'x' },
        root,
      ),
    ).rejects.toThrow(/could not be read/);
  });
});

describe('workflow default inputs from the project', () => {
  it('architecture and feature-flag scans walk the project sources when files is omitted', async () => {
    const root = await project(workspace);
    const boundaries = await call(
      architectureBoundaryChecker,
      'architecture_boundaries',
      { forbidden: [{ from: 'p/b', to: 'p/a' }] },
      root,
    );
    expect(boundaries['violations']).toEqual([
      expect.objectContaining({ from: 'p/b/src/index.ts' }),
    ]);
    // The scope a defaulted walk covered is part of the answer.
    expect(boundaries['scope']).toEqual({ source: 'project-walk', files: 2 });
    const flags = await call(
      featureFlagLifecycle,
      'feature_flag_inventory',
      { flags: [{ name: 'NEW_CHECKOUT' }] },
      root,
    );
    expect(flags['flags']).toEqual([
      expect.objectContaining({
        references: [{ path: 'p/a/src/index.ts', line: 2 }],
        unusedInScope: false,
      }),
    ]);
  });

  it('recipes, environment and documentation tools default to the conventional root files', async () => {
    const root = await project({
      'package.json': JSON.stringify({ name: 'solo', scripts: { test: 'node -e 0' } }),
      'README.md':
        '# Solo\n\n```js verify\nimport assert from "node:assert";\nassert.equal(1 + 1, 2);\n```\n',
    });
    expect(await call(workspaceRecipeRunner, 'workspace_recipes', {}, root)).toMatchObject({
      package: 'solo',
    });
    expect(
      await call(developerEnvironmentDoctor, 'developer_environment_check', {}, root),
    ).toBeTruthy();
    expect(await call(executableDocumentation, 'documentation_verify', {}, root)).toMatchObject({
      status: 'passed',
      source: 'README.md',
    });
  });
});
