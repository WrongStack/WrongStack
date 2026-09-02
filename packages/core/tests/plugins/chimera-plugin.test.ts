import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommand } from '../../src/index.js';
import { EventBus } from '../../src/kernel/events.js';
import {
  CHIMERA_REVIEW_PROMPT,
  createChimeraPlugin,
  resolveChimeraConfig,
} from '../../src/plugins/chimera-plugin.js';
import { recordCompletedReview } from '../../src/plugins/review-claim-registry.js';

let tmp: string;
const gitInit = (dir: string) => {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
};
const commit = (dir: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
};

function makeApi(config: Record<string, unknown> = {}, sharedEventBus?: EventBus) {
  const events: Record<string, (event?: Record<string, unknown>) => Promise<void>> = {};
  const eventBus = sharedEventBus ?? new EventBus();
  const configChangeCbs: Array<() => void> = [];
  const registered: SlashCommand[] = [];
  const emitCustom = vi.fn((event: string, payload: unknown) => {
    eventBus.emitCustom(event, payload);
  });
  const onPattern = vi.fn((pattern: string, handler: (event: string, payload: unknown) => void) =>
    eventBus.onPattern(pattern, handler),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    config: { provider: 'anthropic', model: 'claude', cwd: tmp, ...config },
    events: eventBus,
    onConfigChange: (cb: () => void) => configChangeCbs.push(cb),
    onEvent: (type: string, h: (event?: Record<string, unknown>) => Promise<void>) => {
      events[type] = h;
    },
    onPattern,
    emitCustom,
    slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
    log,
  } as never;
  return { api, events, configChangeCbs, registered, emitCustom, onPattern, log };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveChimeraConfig', () => {
  it('delegates all mailbox delivery to the runtime', () => {
    expect(CHIMERA_REVIEW_PROMPT).toContain('MUST NOT use mailbox tools');
    expect(CHIMERA_REVIEW_PROMPT).toContain('runtime handles all mailbox delivery');
    expect(CHIMERA_REVIEW_PROMPT).toContain('Never send Chimera mail to a peer');
  });

  it('instructs Chimera to report findings without mutating files', () => {
    expect(CHIMERA_REVIEW_PROMPT).toContain('strictly read-only');
    expect(CHIMERA_REVIEW_PROMPT).toContain('Never edit, write, patch, update');
    expect(CHIMERA_REVIEW_PROMPT).toContain('later explicit user request');
  });

  it('applies defaults and honors overrides', () => {
    expect(resolveChimeraConfig({}, 'p', 'm')).toEqual({
      enabled: true,
      provider: 'p',
      model: 'm',
      fallbackModels: [],
      maxFiles: 15,
      autoFix: 'off',
      cascadeOn: 'off',
      maxCascadeDepth: 2,
    });
    expect(
      resolveChimeraConfig({ enabled: false, provider: 'x', model: 'y', maxFiles: 3 }, 'p', 'm'),
    ).toEqual({
      enabled: false,
      provider: 'x',
      model: 'y',
      fallbackModels: [],
      maxFiles: 3,
      autoFix: 'off',
      cascadeOn: 'off',
      maxCascadeDepth: 2,
    });
  });

  it('honors Chimera-specific fallbackModels from extensions config', () => {
    expect(
      resolveChimeraConfig(
        {
          fallbackModels: ['anthropic/claude-sonnet', 'openai/gpt-4o'],
        },
        'p',
        'm',
      ),
    ).toEqual({
      enabled: true,
      provider: 'p',
      model: 'm',
      fallbackModels: ['anthropic/claude-sonnet', 'openai/gpt-4o'],
      maxFiles: 15,
      autoFix: 'off',
      cascadeOn: 'off',
      maxCascadeDepth: 2,
    });
  });

  it('defaults fallbackModels to empty array when not configured', () => {
    expect(resolveChimeraConfig({}, 'p', 'm').fallbackModels).toEqual([]);
    expect(resolveChimeraConfig({ fallbackModels: undefined }, 'p', 'm').fallbackModels).toEqual(
      [],
    );
    expect(resolveChimeraConfig({ fallbackModels: [] }, 'p', 'm').fallbackModels).toEqual([]);
  });

  it('silently ignores the deprecated maxTokens override', () => {
    // Old configs may still pass `maxTokens: 4096`. The field is read as
    // `unknown` and dropped — output cap is now driven by the provider's
    // capabilities.maxOutput, not by chimera config.
    const cfg = resolveChimeraConfig({ maxTokens: 4096 }, 'p', 'm');
    expect(cfg).toEqual({
      enabled: true,
      provider: 'p',
      model: 'm',
      fallbackModels: [],
      fallbackProfile: undefined,
      maxFiles: 15,
      autoFix: 'off',
      cascadeOn: 'off',
      maxCascadeDepth: 2,
    });
  });

  it('honors cascade and autoFix overrides from config', () => {
    expect(
      resolveChimeraConfig({ autoFix: 'auto', cascadeOn: 'high', maxCascadeDepth: 5 }, 'p', 'm'),
    ).toEqual({
      enabled: true,
      provider: 'p',
      model: 'm',
      fallbackModels: [],
      fallbackProfile: undefined,
      maxFiles: 15,
      autoFix: 'auto',
      cascadeOn: 'high',
      maxCascadeDepth: 5,
    });
  });
});

describe('createChimeraPlugin lifecycle + command', () => {
  it('registers /chimera when enabled and reflects config changes; health/teardown work', () => {
    const { api, registered, configChangeCbs, log } = makeApi();
    const plugin = createChimeraPlugin();
    plugin.setup!(api);
    expect(registered[0]?.name).toBe('chimera');

    // config change with no enabled/provider/model delta → no log
    configChangeCbs[0]!();
    // config change flipping enabled → logs + command reflects the new state
    (api as { config: Record<string, unknown> }).config.extensions = {
      'wstack-chimera': { enabled: false },
    };
    configChangeCbs[0]!();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('config changed'));

    plugin.teardown!(api);
    return plugin.health!().then((h) => expect(h).toMatchObject({ ok: true }));
  });

  it('keeps claim bookkeeping listeners registered when disabled by config', () => {
    const { api, registered, onPattern, log } = makeApi({
      extensions: { 'wstack-chimera': { enabled: false } },
    });
    createChimeraPlugin().setup!(api);
    expect(registered).toHaveLength(0);
    expect(onPattern).toHaveBeenCalledWith('chimera.review_needed', expect.any(Function));
    expect(onPattern).toHaveBeenCalledWith('chimera.review_complete', expect.any(Function));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('disabled by config'));
  });

  it('releases shared review claims with mixed enabled state on one event bus', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 1;');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;');

    const eventBus = new EventBus();
    const disabled = makeApi({ extensions: { 'wstack-chimera': { enabled: false } } }, eventBus);
    const enabled = makeApi({}, eventBus);
    createChimeraPlugin().setup!(disabled.api);
    createChimeraPlugin().setup!(enabled.api);

    await enabled.events['session.ended']!();
    const firstBundle = enabled.emitCustom.mock.calls.find(
      ([event]) => event === 'chimera.review_needed',
    )?.[1];
    expect(firstBundle).toBeDefined();

    eventBus.emitCustom('chimera.review_complete', { bundle: firstBundle });
    // The plugin's completion listeners release claims fire-and-forget; in the
    // real host the CLI execution owner AWAITS recordCompletedReview before
    // emitting review_complete (execution-chimera-review.ts), so the release is
    // always durable before the next trigger. Await the canonical release here
    // to mirror that ordering instead of racing the void'd plugin release.
    await recordCompletedReview(eventBus as never, { bundle: firstBundle });
    await enabled.events['session.ended']!();

    const reviews = enabled.emitCustom.mock.calls.filter(
      ([event]) => event === 'chimera.review_needed',
    );
    expect(reviews).toHaveLength(2);
  });

  it('command renders enabled and disabled status', async () => {
    const { api, registered, configChangeCbs } = makeApi();
    createChimeraPlugin().setup!(api);
    const cmd = registered[0]!;
    expect((await cmd.run!('', {} as never)).message).toContain('Chimera — enabled');
    // flip to disabled via config change → the live getter reflects it
    (api as { config: Record<string, unknown> }).config.extensions = {
      'wstack-chimera': { enabled: false },
    };
    configChangeCbs[0]!();
    expect((await cmd.run!('', {} as never)).message).toContain('Chimera — disabled');
  });
});

describe('session.ended review handler', () => {
  it('skips when the directory is not a git repo', async () => {
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('not a git repo'));
  });

  it('registers delayed session-end review production with waitUntil', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 2;');
    const { api, events } = makeApi();
    createChimeraPlugin().setup!(api);
    const waitUntil = vi.fn();

    events['session.ended']?.({
      id: 'session-1',
      usage: { input: 0, output: 0 },
      waitUntil,
    });

    expect(waitUntil).toHaveBeenCalledOnce();
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
  });

  it('emits review_needed with the changed file contents', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 1;');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 2; // modified');
    await fs.writeFile(path.join(tmp, 'b.ts'), 'export const b = 3;');

    const { api, events, emitCustom } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();

    expect(emitCustom).toHaveBeenCalledWith(
      'chimera.review_needed',
      expect.objectContaining({
        cwd: tmp,
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'a.ts', status: 'modified' }),
          expect.objectContaining({ path: 'b.ts', status: 'added' }),
        ]),
      }),
    );
  });

  it('skips .wrongstack files and reports when nothing is left to review', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'keep.ts'), 'x');
    commit(tmp, 'init'); // clean tree now
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no changed files'));
  });

  it('caps the review at maxFiles', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'one.ts'), '1');
    await fs.writeFile(path.join(tmp, 'two.ts'), '2');
    const { api, events, emitCustom, log } = makeApi({
      extensions: { 'wstack-chimera': { maxFiles: 1 } },
    });
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('capping review at 1 of 2'));
    expect((emitCustom.mock.calls[0]![1] as { files: unknown[] }).files).toHaveLength(1);
  });

  it('ignores .wrongstack/ changes', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.wrongstack', 'note.md'), 'internal');
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no changed files'));
  });

  it('reports when changed paths cannot be read (a directory entry)', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    // an untracked directory shows as a single porcelain entry whose path is a dir → readFile fails
    await fs.mkdir(path.join(tmp, 'newdir'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'newdir', 'inner.ts'), 'y');
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('could not read'));
  });

  it('skips the review when chimera was disabled after setup', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'changed.ts'), 'y');
    const { api, events, emitCustom, configChangeCbs } = makeApi();
    createChimeraPlugin().setup!(api);
    (api as { config: Record<string, unknown> }).config.extensions = {
      'wstack-chimera': { enabled: false },
    };
    configChangeCbs[0]!(); // resolved → disabled
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
  });

  it('rolls back a failed emission so the next review can retry', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'c.ts'), 'changed');
    const { api, events, emitCustom, log } = makeApi();
    emitCustom.mockImplementationOnce(() => {
      throw new Error('emit blew up');
    });
    createChimeraPlugin().setup!(api);

    await events['session.ended']!();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('session.ended handler failed'));

    await events['session.ended']!();
    expect(emitCustom).toHaveBeenCalledTimes(2);
    expect(emitCustom).toHaveBeenLastCalledWith(
      'chimera.review_needed',
      expect.objectContaining({ files: expect.any(Array) }),
    );
  });
});
