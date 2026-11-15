import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plugin, PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.hoisted(() =>
  vi.fn(async () => ({
    passed: true,
    exitCode: 0,
    stdout: 'non-json stdout line\n',
    stderr: '',
    durationMs: 1,
  })),
);

vi.mock('../src/workflow-runtime/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow-runtime/index.js')>();
  return {
    ...actual,
    run: runMock,
  };
});

import migrationPlugin from '../src/migration-rehearsal/index.js';
import workbenchPlugin from '../src/plugin-workbench/index.js';
import lifecyclePlugin from '../src/resource-lifecycle-inspector/index.js';
import journeyPlugin from '../src/responsive-journey-tester/index.js';
import { parseJsonReport } from '../src/workflow-runtime/index.js';

const temps: string[] = [];

afterEach(async () => {
  runMock.mockClear();
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function getTool(plugin: Plugin, name: string) {
  let tool: Tool | undefined;
  await plugin.setup({
    config: { extensions: {} },
    tools: {
      register: (t: Tool) => {
        if (t.name === name) tool = t;
      },
    },
  } as unknown as PluginAPI);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  const registered = tool;
  return (input: Record<string, unknown>, ctx: Record<string, unknown>) =>
    registered.execute(input, ctx as never, { signal: new AbortController().signal });
}

describe('workflow plugins non-JSON stdout resilience (F380-F383)', () => {
  it('parseJsonReport returns null on non-JSON stdout and extracts last JSON object before trailing noise', () => {
    expect(parseJsonReport('')).toBeNull();
    expect(parseJsonReport('banner\nnot json\n')).toBeNull();
    expect(parseJsonReport('{"passed":true}\ntrailing noise\n')).toEqual({ passed: true });
  });

  it('migration_rehearse, plugin_workbench_run, resource_lifecycle_inspect, and responsive_journey_test return report: null on non-JSON stdout', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'f380-wf-'));
    temps.push(tmp);
    await fs.writeFile(path.join(tmp, 'seed.sql'), 'CREATE TABLE t(id INT);', 'utf8');
    await fs.writeFile(path.join(tmp, 'up.sql'), 'INSERT INTO t VALUES(1);', 'utf8');
    await fs.writeFile(path.join(tmp, 'p.mjs'), 'export default { setup(){} };', 'utf8');
    await fs.writeFile(
      path.join(tmp, 'f.mjs'),
      'export function start(){} export function stop(){}',
      'utf8',
    );

    const ctx = { cwd: tmp, workspaceRoot: tmp };
    const mRes = (await (
      await getTool(migrationPlugin, 'migration_rehearse')
    )({ seed: 'seed.sql', up: 'up.sql' }, ctx)) as { report: unknown };
    expect(mRes.report).toBeNull();

    const wRes = (await (
      await getTool(workbenchPlugin, 'plugin_workbench_run')
    )({ path: 'p.mjs' }, ctx)) as { report: unknown };
    expect(wRes.report).toBeNull();

    const rRes = (await (
      await getTool(lifecyclePlugin, 'resource_lifecycle_inspect')
    )({ fixture: 'f.mjs' }, ctx)) as { report: unknown };
    expect(rRes.report).toBeNull();

    const jRes = (await (
      await getTool(journeyPlugin, 'responsive_journey_test')
    )(
      {
        url: 'http://127.0.0.1:3000',
        viewports: [{ width: 375, height: 667 }],
        steps: [],
        selectors: ['button'],
      },
      ctx,
    )) as { report: unknown };
    expect(jRes.report).toBeNull();
  });
});
