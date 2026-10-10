import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, gzipSync } from 'node:zlib';
import type { Plugin, PluginAPI, Tool } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as plugins from '../src/index.js';
import { fingerprints, workflowPlugin } from '../src/workflow-runtime/index.js';
import { decodePng } from '../src/workflow-runtime/png.js';

let root: string;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wrongstack-workflows-test-'));
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  await rm(root, { recursive: true, force: true });
});
async function file(path: string, value: string | Buffer) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
  return path;
}
function harness(plugin: Plugin) {
  const registered = new Map<string, Tool>();
  const api = {
    config: { extensions: {} },
    log: { info() {}, warn() {}, error() {} },
    tools: {
      register(tool: Tool) {
        registered.set(tool.name, tool);
      },
    },
  } as unknown as PluginAPI;
  plugin.setup(api);
  cleanup.push(async () => {
    await plugin.teardown?.(api);
  });
  return {
    api,
    tools: registered,
    async call(name: string, input: unknown, signal = new AbortController().signal) {
      const tool = registered.get(name);
      if (!tool) throw new Error(`Missing ${name}`);
      return tool.execute(input, { projectRoot: root, cwd: root } as never, { signal });
    },
  };
}
function node(script: string) {
  return { program: process.execPath, args: ['-e', script] };
}
async function server(handler: RequestListener) {
  const instance: Server = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Missing server');
  return `http://127.0.0.1:${address.port}`;
}

describe('workflow plugins: command evidence and lifecycle', () => {
  it('rejects a result completed after the workflow was cancelled or unloaded', async () => {
    for (const unload of [false, true]) {
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const plugin = workflowPlugin({
        name: 'cancel-fixture',
        description: 'fixture',
        tools: [
          {
            name: 'wait',
            description: 'wait',
            properties: {},
            async run() {
              await waiting;
              return { passed: true };
            },
          },
        ],
      });
      const h = harness(plugin);
      const controller = new AbortController();
      const pending = h.call('wait', {}, controller.signal);
      const assertion = expect(pending).rejects.toThrow();
      if (unload) await plugin.teardown?.(h.api);
      else controller.abort();
      finish();
      await assertion;
    }
  });
  it('compares replay JSON objects independently of property order', async () => {
    const baseUrl = await server((_req, res) => {
      res.end(JSON.stringify({ nested: { b: 2, a: 1 } }));
    });
    expect(
      await harness(plugins.apiConsumerReplayPlugin).call('api_consumer_replay', {
        baseUrl,
        cases: [{ path: '/', expectedJson: { nested: { a: 1, b: 2 } } }],
      }),
    ).toMatchObject({ passed: true });
  });

  it('reports a missing required trace layer as an issue', async () => {
    await file(
      'trace.json',
      JSON.stringify({ spans: [{ id: 'one', traceId: 't', layer: 'api', startMs: 0, endMs: 1 }] }),
    );
    expect(
      await harness(plugins.runtimeTraceExplorerPlugin).call('runtime_trace_explore', {
        path: 'trace.json',
        traceId: 't',
        layers: ['storage'],
      }),
    ).toMatchObject({ status: 'issues-found', missingLayers: ['storage'] });
  });
  it('reproduces an attributed failure, but not an unrelated failure', async () => {
    await file('source.ts', 'broken');
    const h = harness(plugins.bugReproducerPlugin);
    const result = await h.call('bug_reproduce', {
      command: node("console.error('BUG-42');process.exitCode=1"),
      files: ['source.ts'],
      expectedOutput: 'BUG-42',
    });
    expect(result).toMatchObject({
      status: 'reproduced',
      recipe: expect.stringContaining('assert.equal(result.status, 0'),
    });
    expect(
      await h.call('bug_reproduce', {
        command: node('process.exitCode=1'),
        files: ['source.ts'],
        expectedOutput: 'BUG-42',
      }),
    ).toMatchObject({ status: 'not-reproduced' });
  });
  it('invalidates verification after file edits and isolates loaded hosts', async () => {
    await file('source.ts', 'first');
    const h = harness(plugins.verificationLedgerPlugin);
    await h.call('verification_record', {
      command: node('process.exitCode=0'),
      files: ['source.ts'],
      label: 'unit',
    });
    expect(await h.call('verification_status', {})).toMatchObject({
      records: [{ status: 'passed' }],
    });
    await file('source.ts', 'second');
    expect(await h.call('verification_status', {})).toMatchObject({
      records: [{ status: 'stale' }],
    });
    expect(
      await harness(plugins.verificationLedgerPlugin).call('verification_status', {}),
    ).toMatchObject({ records: [] });
  });
  it('does not accept missing acceptance evidence or empty criteria', async () => {
    const h = harness(plugins.acceptanceVerifierPlugin);
    expect(
      await h.call('acceptance_verify', { criteria: [{ id: '1', requirement: 'button works' }] }),
    ).toMatchObject({ accepted: false, criteria: [{ status: 'unverified' }] });
    await expect(h.call('acceptance_verify', { criteria: [] })).rejects.toThrow();
    await file('a.ts', 'source');
    expect(
      await h.call('acceptance_verify', {
        criteria: [
          {
            id: '1',
            requirement: 'assertions',
            files: ['a.ts'],
            command: node('process.exitCode=0'),
          },
        ],
      }),
    ).toMatchObject({ accepted: true });
  });
  it('invalidates earlier acceptance evidence changed by a later criterion', async () => {
    await file('a.ts', 'first');
    await file('b.ts', 'other');
    expect(
      await harness(plugins.acceptanceVerifierPlugin).call('acceptance_verify', {
        criteria: [
          {
            id: 'first',
            requirement: 'first check',
            files: ['a.ts'],
            command: node('process.exitCode=0'),
          },
          {
            id: 'second',
            requirement: 'second check',
            files: ['b.ts'],
            command: node("require('node:fs').writeFileSync('a.ts','changed')"),
          },
        ],
      }),
    ).toMatchObject({ accepted: false, criteria: [{ status: 'stale' }, { status: 'passed' }] });
  });
  it('keeps deterministic results when optional Council and One Shot are unavailable', async () => {
    await file('packages/a/package.json', '{"name":"a"}');
    const h = harness(plugins.monorepoChangePlannerPlugin);
    const input = {
      manifests: ['packages/a/package.json'],
      changedFiles: ['packages/a/src/a.ts'],
      review: 'council',
    };
    expect(await h.call('monorepo_change_plan', input)).toMatchObject({
      affected: ['a'],
      advice: { used: false, fallbackReason: 'unavailable' },
    });
    const complete = vi.fn().mockResolvedValue({ text: '{"suggestions":["Run consumer tests"]}' });
    h.api.llm = { complete, council: vi.fn().mockRejectedValue(new Error('offline')) } as never;
    expect(await h.call('monorepo_change_plan', input)).toMatchObject({
      affected: ['a'],
      advice: { used: true, value: { suggestions: ['Run consumer tests'] } },
    });
    complete.mockResolvedValue({ text: '{"passed":true}' });
    expect(await h.call('monorepo_change_plan', { ...input, review: 'one-shot' })).toMatchObject({
      affected: ['a'],
      advice: { used: false, fallbackReason: 'invalid-response' },
    });
  });
  it('discovers actual scripts and executes the selected recipe', async () => {
    await file(
      'package.json',
      JSON.stringify({
        name: 'fixture',
        packageManager: 'pnpm@12.0.0',
        scripts: { test: 'node test.js' },
        dependencies: { child: 'workspace:*' },
      }),
    );
    const h = harness(plugins.workspaceRecipeRunnerPlugin);
    expect(await h.call('workspace_recipes', { path: 'package.json' })).toMatchObject({
      manager: 'pnpm',
      prerequisites: ['child'],
      recipes: [{ name: 'test', command: { program: 'pnpm', args: ['run', 'test'] } }],
    });
    expect(
      await h.call('workspace_recipe_run', { command: node('console.log(42)') }),
    ).toMatchObject({ passed: true, stdout: expect.stringContaining('42') });
  });
  it('rejects disabled plugins, traversal and stale tool handles after reload', async () => {
    const h = harness(plugins.workspaceRecipeRunnerPlugin);
    await expect(h.call('workspace_recipes', { path: '../outside.json' })).rejects.toThrow(
      /inside/,
    );
    h.api.config.extensions = { 'workspace-recipe-runner': { enabled: false } };
    await expect(h.call('workspace_recipes', { path: 'package.json' })).rejects.toThrow(/disabled/);
    h.api.config.extensions = {};
    const old = h.tools.get('workspace_recipes')!;
    plugins.workspaceRecipeRunnerPlugin.setup(h.api);
    await expect(
      old.execute({ path: 'package.json' }, { projectRoot: root } as never, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
  it('aborts before executing a command and reports timeouts as failures', async () => {
    const h = harness(plugins.workspaceRecipeRunnerPlugin);
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.call('workspace_recipe_run', { command: node('process.exitCode=0') }, controller.signal),
    ).rejects.toThrow();
    expect(
      await h.call('workspace_recipe_run', {
        command: { ...node('setInterval(()=>{},1000)'), timeoutMs: 100 },
      }),
    ).toMatchObject({ passed: false, timedOut: true });
  });
});

describe('workflow plugins: project analysis', () => {
  it('finds missing trace parents, cycles and absent layers', async () => {
    await file(
      'trace.json',
      JSON.stringify({
        spans: [
          {
            id: 'a',
            traceId: 't',
            parentId: 'missing',
            layer: 'api',
            startMs: 0,
            endMs: 4,
            status: 'error',
          },
        ],
      }),
    );
    expect(
      await harness(plugins.runtimeTraceExplorerPlugin).call('runtime_trace_explore', {
        path: 'trace.json',
        traceId: 't',
        layers: ['ui', 'api'],
      }),
    ).toMatchObject({
      missingLayers: ['ui'],
      issues: expect.arrayContaining([
        { id: 'a', issue: 'missing-parent' },
        { id: 'a', issue: 'error-span' },
      ]),
    });
  });
  it('detects forbidden literal import edges and cycles', async () => {
    await file('ui/a.ts', "import {b} from '../db/b.js';");
    await file('db/b.ts', "import '../ui/a.js';");
    expect(
      await harness(plugins.architectureBoundaryCheckerPlugin).call('architecture_boundaries', {
        files: ['ui/a.ts', 'db/b.ts'],
        forbidden: [{ from: 'ui', to: 'db' }],
      }),
    ).toMatchObject({
      violations: [{ from: 'ui/a.ts', to: 'db/b.ts' }],
      cycles: [['ui/a.ts', 'db/b.ts', 'ui/a.ts']],
    });
  });
  it('orders changed monorepo dependencies before transitive consumers', async () => {
    await file('packages/a/package.json', JSON.stringify({ name: 'a', scripts: { build: 'tsc' } }));
    await file(
      'packages/b/package.json',
      JSON.stringify({
        name: 'b',
        dependencies: { a: 'workspace:*' },
        scripts: { test: 'vitest' },
      }),
    );
    expect(
      await harness(plugins.monorepoChangePlannerPlugin).call('monorepo_change_plan', {
        manifests: ['packages/a/package.json', 'packages/b/package.json'],
        changedFiles: ['packages/a/src/a.ts'],
      }),
    ).toMatchObject({ affected: ['a', 'b'], validationOrder: [{ name: 'a' }, { name: 'b' }] });
  });
  it('preserves customized values during configuration preview and rejects conflicts', async () => {
    await file('config.json', '{"old":7,"custom":true}');
    const h = harness(plugins.configMigrationAssistantPlugin);
    expect(
      await h.call('config_migration_preview', {
        path: 'config.json',
        renames: [{ from: 'old', to: 'new' }],
        defaults: { custom: false },
      }),
    ).toMatchObject({ migrated: { new: 7, custom: true }, written: false });
    await expect(
      h.call('config_migration_preview', {
        path: 'config.json',
        renames: [{ from: 'old', to: 'custom' }],
      }),
    ).rejects.toThrow(/exists/);
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe('{"old":7,"custom":true}');
  });
  it('matches flag tokens without confusing prefix names', async () => {
    await file('flags.ts', 'useFlag("checkout_v2"); useFlag("old_flag_more");');
    expect(
      await harness(plugins.featureFlagLifecyclePlugin).call('feature_flag_inventory', {
        files: ['flags.ts'],
        flags: [{ name: 'checkout_v2', expiresAt: '2000-01-01' }, { name: 'old_flag' }],
      }),
    ).toMatchObject({
      flags: [
        { name: 'checkout_v2', expired: true, unusedInScope: false },
        { name: 'old_flag', unusedInScope: true },
      ],
    });
  });
  it('invalidates generated artifacts when their inputs change', async () => {
    await file('source.json', '{}');
    await file('generated.ts', 'export {}');
    const h = harness(plugins.generatedArtifactTrackerPlugin);
    const rules = [
      { id: 'types', inputs: ['source.json'], outputs: ['generated.ts'], command: 'generate' },
    ];
    await h.call('generated_artifacts', { action: 'capture', rules });
    await file('source.json', '{"new":true}');
    expect(await h.call('generated_artifacts', { action: 'check', rules })).toMatchObject({
      generators: [{ status: 'regeneration-required' }],
    });
  });
  it('detects missing localization keys and changed placeholders', async () => {
    await file('en.json', '{"hello":"Hi {name}","save":"Save"}');
    await file('tr.json', '{"hello":"Merhaba {other}"}');
    expect(
      await harness(plugins.localizationCompletenessPlugin).call('localization_compare', {
        base: 'en.json',
        locales: { tr: 'tr.json' },
      }),
    ).toMatchObject({
      passed: false,
      locales: [{ missing: ['save'], mismatches: [{ key: 'hello' }] }],
    });
  });
  it('writes and retrieves decision records by affected directory', async () => {
    const h = harness(plugins.decisionJournalPlugin);
    await h.call('decision_record', {
      journal: 'docs/decisions.jsonl',
      title: 'Keep transactions',
      rationale: 'Atomic edits',
      files: ['src/db'],
    });
    expect(
      await h.call('decision_lookup', { journal: 'docs/decisions.jsonl', files: ['src/db/a.ts'] }),
    ).toMatchObject({ decisions: [{ title: 'Keep transactions', superseded: false }] });
  });
});

describe('workflow plugins: live local services and subprocesses', () => {
  it('replays real HTTP fixtures and finds response drift', async () => {
    const url = await server((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const h = harness(plugins.apiConsumerReplayPlugin);
    expect(
      await h.call('api_consumer_replay', {
        baseUrl: url,
        cases: [{ path: '/', expectedStatus: 200, expectedJson: { ok: true } }],
      }),
    ).toMatchObject({ passed: true });
    expect(
      await h.call('api_consumer_replay', {
        baseUrl: url,
        cases: [{ path: '/', expectedStatus: 201 }],
      }),
    ).toMatchObject({ passed: false });
    await expect(
      h.call('api_consumer_replay', {
        baseUrl: 'http://example.com',
        cases: [{ path: '/', expectedStatus: 200 }],
      }),
    ).rejects.toThrow(/loopback/);
  });
  it('rehearses real SQLite SQL and verifies rollback equivalence', async () => {
    await file(
      'seed.sql',
      'CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1);',
    );
    await file('up.sql', 'CREATE TABLE extra(id INTEGER);');
    await file('down.sql', 'DROP TABLE extra;');
    expect(
      await harness(plugins.migrationRehearsalPlugin).call('migration_rehearse', {
        seed: 'seed.sql',
        up: 'up.sql',
        down: 'down.sql',
      }),
    ).toMatchObject({ execution: { passed: true }, report: { rollbackMatches: true } });
  });
  it('exercises a real injected 429 endpoint and closes it afterward', async () => {
    const h = harness(plugins.failureInjectionLabPlugin);
    const command = {
      program: process.execPath,
      args: [
        '-e',
        'fetch(process.argv[1]).then(r=>{if(r.status!==429)process.exitCode=1})',
        '{faultUrl}',
      ],
    };
    expect(await h.call('failure_inject', { command, scenario: 'rate-limit' })).toMatchObject({
      passed: true,
      requests: 1,
    });
  });
  it('measures real parallel success counts and final-state invariants', async () => {
    let updates = 0;
    const url = await server((request, response) => {
      if (request.method === 'POST') {
        updates++;
        response.statusCode = updates === 1 ? 200 : 409;
        response.end();
      } else {
        response.end(JSON.stringify({ updates }));
      }
    });
    expect(
      await harness(plugins.concurrencyScenarioTesterPlugin).call('concurrency_test', {
        url,
        count: 4,
        expectedSuccesses: 1,
        invariant: { url, expectedJson: { updates: 4 } },
      }),
    ).toMatchObject({ passed: true, successes: 1, invariant: true });
  });
  it('runs resource lifecycle cleanup in a real child', async () => {
    await file(
      'lifecycle.mjs',
      'export function start(){return setInterval(()=>{},5000)};export function stop(handle){clearInterval(handle)}',
    );
    expect(
      await harness(plugins.resourceLifecycleInspectorPlugin).call('resource_lifecycle_inspect', {
        fixture: 'lifecycle.mjs',
        cycles: 2,
      }),
    ).toMatchObject({
      execution: { passed: true },
      report: { passed: true, cycles: expect.any(Array) },
    });
  });
  it('returns retained resources without hanging on the leaked timer', async () => {
    await file(
      'leak.mjs',
      'export function start(){return setInterval(()=>{},5000)};export function stop(){}',
    );
    expect(
      await harness(plugins.resourceLifecycleInspectorPlugin).call('resource_lifecycle_inspect', {
        fixture: 'leak.mjs',
        cycles: 2,
      }),
    ).toMatchObject({
      execution: { passed: true },
      report: { passed: false, retained: [{ Timeout: 1 }, { Timeout: 2 }] },
    });
  });
  it('does not report disposed, numerically cleared or unreferenced timers as active leaks', async () => {
    await file(
      'timer-handles.mjs',
      `export function start(){
        const closed=setInterval(()=>{},5000);closed.close();
        const disposed=setInterval(()=>{},5000);disposed[Symbol.dispose]();
        const numeric=setInterval(()=>{},5000);clearInterval(Number(numeric));
        setInterval(()=>{},5000).unref();
        return setTimeout(()=>{},5000);
      }
      export function stop(handle){clearTimeout(handle)}`,
    );
    expect(
      await harness(plugins.resourceLifecycleInspectorPlugin).call('resource_lifecycle_inspect', {
        fixture: 'timer-handles.mjs',
        cycles: 2,
      }),
    ).toMatchObject({ execution: { passed: true }, report: { passed: true, retained: [{}, {}] } });
  });
  it('executes marked documentation examples and reports failed assertions', async () => {
    await file(
      'README.md',
      '```js verify\nimport assert from "node:assert/strict"; assert.equal(2,3);\n```\n\n```js\nthrow Error("not selected");\n```',
    );
    expect(
      await harness(plugins.executableDocumentationPlugin).call('documentation_verify', {
        path: 'README.md',
      }),
    ).toMatchObject({ status: 'failed', examples: [{ line: 1, passed: false }] });
  });
  it('rejects workspace installs before allocating an upgrade sandbox', async () => {
    await file('package.json', '{"dependencies":{"a":"workspace:*"}}');
    await expect(
      harness(plugins.dependencyUpgradeSandboxPlugin).call('dependency_upgrade_try', {
        files: ['package.json'],
        dependency: 'a',
        version: '2.0.0',
        checks: [node('')],
      }),
    ).rejects.toThrow(/standalone/);
  });
  it('installs an upgrade from a local registry, runs real checks and preserves the source manifest', async () => {
    const packageName = `workflow-upgrade-fixture-${Date.now()}`;
    const packageJson = JSON.stringify({
      name: packageName,
      version: '2.0.0',
      scripts: { install: 'node -e "process.exit(99)"' },
    });
    const header = Buffer.alloc(512);
    header.write('package/package.json');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(Buffer.byteLength(packageJson).toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    const archive = gzipSync(
      Buffer.concat([
        header,
        Buffer.from(packageJson),
        Buffer.alloc((512 - (Buffer.byteLength(packageJson) % 512)) % 512),
        Buffer.alloc(1024),
      ]),
    );
    let url = '';
    url = await server((request, response) => {
      if (request.url?.endsWith('.tgz')) {
        response.setHeader('content-type', 'application/octet-stream');
        response.end(archive);
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          name: packageName,
          'dist-tags': { latest: '2.0.0' },
          versions: {
            '2.0.0': {
              name: packageName,
              version: '2.0.0',
              dist: {
                tarball: `${url}/fixture.tgz`,
                shasum: createHash('sha1').update(archive).digest('hex'),
              },
            },
          },
        }),
      );
    });
    const original = JSON.stringify({
      name: 'upgrade-project',
      version: '1.0.0',
      dependencies: { [packageName]: '1.0.0' },
    });
    await file('package.json', original);
    const command = node(
      `const assert=require('node:assert/strict');assert.equal(require(${JSON.stringify(`${packageName}/package.json`)}).version,'2.0.0')`,
    );
    expect(
      await harness(plugins.dependencyUpgradeSandboxPlugin).call('dependency_upgrade_try', {
        files: ['package.json'],
        dependency: packageName,
        version: '2.0.0',
        registry: url,
        checks: [command],
      }),
    ).toMatchObject({ passed: true, install: { passed: true }, checks: [{ passed: true }] });
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(original);
  }, 30000);
  it('probes the actual Node runtime and reports absent package-manager declarations', async () => {
    await file('package.json', '{}');
    expect(
      await harness(plugins.developerEnvironmentDoctorPlugin).call('developer_environment_check', {
        manifest: 'package.json',
      }),
    ).toMatchObject({
      node: { passed: true },
      installed: false,
      issues: expect.arrayContaining(['packageManager is not declared']),
    });
  });
  it('propagates missing service dependencies', async () => {
    const url = await server((_request, response) => response.end('ok'));
    expect(
      await harness(plugins.serviceTopologyInspectorPlugin).call('service_topology_inspect', {
        services: [{ name: 'api', url, dependsOn: ['database'] }],
      }),
    ).toMatchObject({
      services: [{ healthy: true, blockedBy: ['database'] }],
      missing: ['database'],
    });
  });
  it('detects a plugin hook leak in a real ESM lifecycle harness', async () => {
    await file(
      'leaky.mjs',
      "export default {name:'leaky',setup(api){api.registerHook('PostToolUse','*',()=>{})},teardown(){}};",
    );
    expect(
      await harness(plugins.pluginWorkbenchPlugin).call('plugin_workbench_run', {
        path: 'leaky.mjs',
      }),
    ).toMatchObject({ execution: { passed: true }, report: { passed: false, leaked: 2 } });
  });
  it('accepts the real extension unregister function contract in the workbench', async () => {
    await file(
      'extension.mjs',
      "let release; export default {name:'extension',setup(api){release?.();release=api.extensions.register({name:'example'})},teardown(){release?.()}};",
    );
    expect(
      await harness(plugins.pluginWorkbenchPlugin).call('plugin_workbench_run', {
        path: 'extension.mjs',
      }),
    ).toMatchObject({ execution: { passed: true }, report: { passed: true, leaked: 0 } });
  });
  it('runs an actual responsive browser journey and detects an offscreen control', async () => {
    await symlink(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const url = await server((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<button id="go" onclick="this.textContent=\'Done\'">Go</button><button id="outside" style="position:absolute;left:2000px">Outside</button>',
      );
    });
    const result = await harness(plugins.responsiveJourneyTesterPlugin).call(
      'responsive_journey_test',
      {
        url,
        viewports: [{ width: 390, height: 300 }],
        steps: [{ action: 'click', selector: '#go' }],
        selectors: ['#go', '#outside'],
      },
    );
    expect(result).toMatchObject({
      execution: { passed: true },
      report: {
        passed: false,
        results: [
          {
            controls: [
              { selector: '#go', visible: true },
              { selector: '#outside', reachable: false },
            ],
          },
        ],
      },
    });
  }, 30000);
});

function image(red: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  function chunk(type: string, bytes: Buffer) {
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length, 0);
    result.write(type, 4);
    bytes.copy(result, 8);
    return result;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
it('fingerprints binary bytes without lossy UTF-8 normalization', async () => {
  await file('asset.bin', Buffer.from([255]));
  const first = await fingerprints(root, ['asset.bin']);
  await file('asset.bin', Buffer.from([254]));
  expect(await fingerprints(root, ['asset.bin'])).not.toEqual(first);
});
it('compares decoded screenshot pixels rather than compressed bytes', async () => {
  await file('before.png', image(0));
  await file('after.png', image(200));
  expect(decodePng(image(200)).pixels[0]).toBe(200);
  const h = harness(plugins.visualRegressionReviewerPlugin);
  expect(
    await h.call('visual_regression_compare', { baseline: 'before.png', current: 'after.png' }),
  ).toMatchObject({ passed: false, changedPixels: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } });
  expect(
    await h.call('visual_regression_compare', {
      baseline: 'before.png',
      current: 'after.png',
      tolerance: 201,
    }),
  ).toMatchObject({ passed: true });
});
