import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import {
  createSpecialistTriggerPlugin,
  type SpecialistNeededPayload,
} from '../../src/plugins/specialist-trigger-plugin.js';
import type { SlashCommand } from '../../src/types/slash-command.js';

let tmp: string;

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'trigger@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'trigger test'], { cwd: dir });
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function makeApi(triggerConfig: Record<string, unknown> = {}) {
  const handlers: Record<string, (event?: unknown) => Promise<void> | void> = {};
  const registered: SlashCommand[] = [];
  const emitCustom = vi.fn();
  const api = {
    config: {
      cwd: tmp,
      extensions: {
        'wstack-specialist-triggers': {
          enabled: true,
          // Fire on the first settled scan so the tests exercise matching and
          // caps rather than timer plumbing; debounce has its own test.
          debounceMs: 1,
          ...triggerConfig,
        },
      },
    },
    events: new EventBus(),
    onConfigChange: vi.fn(),
    onEvent: (type: string, handler: (event?: unknown) => Promise<void> | void) => {
      handlers[type] = handler;
    },
    onPattern: vi.fn(),
    emitCustom,
    slashCommands: {
      register: (command: SlashCommand) => registered.push(command),
      unregister: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
  return { api, handlers, emitCustom, registered };
}

function needs(emitCustom: ReturnType<typeof vi.fn>): SpecialistNeededPayload[] {
  return emitCustom.mock.calls
    .filter(([event]) => event === 'fleet.specialist_needed')
    .map(([, payload]) => payload as SpecialistNeededPayload);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an iteration and wait for the settled scan to finish.
 *
 * Polls rather than sleeping a fixed span: the settled pass shells out to `git
 * status`, which on Windows routinely costs more than any sleep short enough to
 * keep the suite quick. `until` is the emit count the caller expects — the wait
 * ends as soon as it is reached, and otherwise burns the full budget so a test
 * asserting that nothing fires still gives the plugin every chance to.
 */
async function settle(
  handlers: Record<string, (event?: unknown) => Promise<void> | void>,
  emitCustom: ReturnType<typeof vi.fn>,
  until = Number.POSITIVE_INFINITY,
): Promise<void> {
  await handlers['iteration.completed']?.({});
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (needs(emitCustom).length >= until) return;
    await sleep(25);
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'specialist-trigger-'));
  gitInit(tmp);
  await fs.mkdir(path.join(tmp, 'db', 'migrations'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 1;\n');
  commitAll(tmp, 'initial');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('specialist trigger plugin', () => {
  it('does nothing at all until the user enables it', async () => {
    const { api, handlers, emitCustom } = makeApi({ enabled: false });
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '002.sql'), 'select 2;\n');
    // Not merely "emits nothing": the event handler is never registered, so a
    // disabled plugin cannot even run `git status` on every iteration.
    expect(handlers['iteration.completed']).toBeUndefined();
    expect(needs(emitCustom)).toEqual([]);
  });

  it('registers its status command even while disabled, so it is discoverable', async () => {
    const { api, registered } = makeApi({ enabled: false });
    createSpecialistTriggerPlugin().setup?.(api);
    expect(registered.map((command) => command.name)).toContain('specialist-triggers');
  });

  it('wakes the role that owns a changed file, with the paths and a task', async () => {
    const { api, handlers, emitCustom } = makeApi();
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');

    await settle(handlers, emitCustom, 1);

    const fired = needs(emitCustom);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ role: 'database', tier: 'budget', cwd: tmp });
    expect(fired[0]?.paths).toEqual(['db/migrations/001_init.sql']);
    expect(fired[0]?.task).toContain('db/migrations/001_init.sql');
  });

  it('sees a brand-new file, not only a modified one', async () => {
    const { api, handlers, emitCustom } = makeApi();
    createSpecialistTriggerPlugin().setup?.(api);
    // Untracked, never committed. `git status --porcelain --untracked-files=no`
    // — what the reviewer path uses — would not report this at all, and adding
    // a migration is far more common than editing one.
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '002_new.sql'), 'select 2;\n');

    await settle(handlers, emitCustom, 1);
    expect(needs(emitCustom)[0]?.paths).toEqual(['db/migrations/002_new.sql']);
  });

  it('stays quiet for a change no rule claims', async () => {
    const { api, handlers, emitCustom } = makeApi();
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');

    await settle(handlers, emitCustom);
    expect(needs(emitCustom)).toEqual([]);
  });

  it('fires once for an unchanged path set, however many iterations pass', async () => {
    const { api, handlers, emitCustom } = makeApi();
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');

    await settle(handlers, emitCustom, 1);
    await settle(handlers, emitCustom, 2);
    await settle(handlers, emitCustom, 2);

    // The file stays dirty for the rest of the session; re-firing per iteration
    // is how a helpful background agent turns into a bill.
    expect(needs(emitCustom)).toHaveLength(1);
  });

  it('fires again once the matched set actually changes', async () => {
    const { api, handlers, emitCustom } = makeApi();
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');
    await settle(handlers, emitCustom, 1);

    await fs.writeFile(path.join(tmp, 'db', 'migrations', '002_more.sql'), 'select 3;\n');
    await settle(handlers, emitCustom, 2);

    const fired = needs(emitCustom);
    expect(fired).toHaveLength(2);
    expect(fired[1]?.paths).toHaveLength(2);
  });

  it('waits for the paths to stop moving before firing', async () => {
    const { api, handlers, emitCustom } = makeApi({ debounceMs: 10_000 });
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');

    await handlers['iteration.completed']?.({});
    await sleep(200);
    // A half-written migration must not be reviewed mid-edit.
    expect(needs(emitCustom)).toEqual([]);
  });

  it('honours the per-session cap', async () => {
    const { api, handlers, emitCustom } = makeApi({ maxPerSession: 1, maxConcurrent: 10 });
    createSpecialistTriggerPlugin().setup?.(api);

    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');
    await settle(handlers, emitCustom, 1);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '002_more.sql'), 'select 3;\n');
    await settle(handlers, emitCustom, 2);

    expect(needs(emitCustom)).toHaveLength(1);
  });

  it('honours the concurrency cap', async () => {
    const { api, handlers, emitCustom } = makeApi({ maxConcurrent: 1, maxPerSession: 10 });
    createSpecialistTriggerPlugin().setup?.(api);

    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');
    await settle(handlers, emitCustom, 1);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '002_more.sql'), 'select 3;\n');
    await settle(handlers, emitCustom, 2);

    // Nothing releases the in-flight slot within the test window, so the
    // second settled set must not fire.
    expect(needs(emitCustom)).toHaveLength(1);
  });

  it('respects a session that has switched subagents off', async () => {
    const { api, handlers, emitCustom } = makeApi();
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');

    await handlers['iteration.completed']?.({
      ctx: { meta: { subagentsAllowed: false } },
    });
    await sleep(200);
    expect(needs(emitCustom)).toEqual([]);
  });

  it('ignores its own bookkeeping directory', async () => {
    const { api, handlers, emitCustom } = makeApi({
      rules: [{ role: 'audit-log', match: ['**/*.jsonl'], reason: 'a log changed, look at it' }],
    });
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.mkdir(path.join(tmp, '.wrongstack', 'agents'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.wrongstack', 'agents', 'dispatch-log.jsonl'), '{}\n');
    commitAll(tmp, 'add agent bookkeeping');
    await fs.writeFile(path.join(tmp, '.wrongstack', 'agents', 'dispatch-log.jsonl'), '{"a":1}\n');

    await settle(handlers, emitCustom);
    // Agents writing their own telemetry would otherwise wake agents.
    expect(needs(emitCustom)).toEqual([]);
  });

  it('stops scanning after the session ends', async () => {
    const { api, handlers, emitCustom } = makeApi({ debounceMs: 10 });
    createSpecialistTriggerPlugin().setup?.(api);
    await fs.writeFile(path.join(tmp, 'db', 'migrations', '001_init.sql'), 'select 2;\n');

    await handlers['iteration.completed']?.({});
    handlers['session.ended']?.({});
    await sleep(300);

    expect(needs(emitCustom)).toEqual([]);
  });

  it('survives a directory that is not a git repository', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'specialist-trigger-plain-'));
    try {
      const { api, handlers, emitCustom } = makeApi();
      (api as { config: { cwd: string } }).config.cwd = plain;
      createSpecialistTriggerPlugin().setup?.(api);
      await expect(settle(handlers, emitCustom)).resolves.toBeUndefined();
      expect(needs(emitCustom)).toEqual([]);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});
