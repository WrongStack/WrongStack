import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChimeraReviewNeededPayload, SlashCommand } from '../../src/index.js';
import { EventBus } from '../../src/kernel/events.js';
import {
  buildReviewerModelPool,
  createAutoReviewPlugin,
  resolveAutoReviewConfig,
  selectRoundRobinReviewerAssignment,
} from '../../src/plugins/auto-review-plugin.js';
import type { Config } from '../../src/types/config.js';

let tmp: string;

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'auto-review@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'auto-review test'], { cwd: dir });
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function makeApi(autoReviewConfig: Record<string, unknown> = {}) {
  const events: Record<string, (payload?: { ctx?: { todos?: never[] } }) => Promise<void>> = {};
  const eventBus = new EventBus();
  const registered: SlashCommand[] = [];
  const emitCustom = vi.fn();
  const onPattern = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    config: {
      provider: 'test-provider',
      model: 'test-model',
      cwd: tmp,
      extensions: {
        'wstack-auto-review': {
          enabled: true,
          debounceMs: 0,
          maxConcurrentReviews: 10,
          ...autoReviewConfig,
        },
      },
    },
    events: eventBus,
    onConfigChange: vi.fn(),
    onEvent: (type: string, handler: (payload?: { ctx?: { todos?: never[] } }) => Promise<void>) => {
      events[type] = handler;
    },
    onPattern,
    emitCustom,
    slashCommands: {
      register: (command: SlashCommand) => registered.push(command),
      unregister: vi.fn(),
    },
    log,
  } as never;

  return { api, events, emitCustom, onPattern, log, registered };
}

function reviewPayloads(emitCustom: ReturnType<typeof vi.fn>): ChimeraReviewNeededPayload[] {
  return emitCustom.mock.calls
    .filter(([event]) => event === 'chimera.review_needed')
    .map(([, payload]) => payload as ChimeraReviewNeededPayload);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-review-'));
  gitInit(tmp);
  await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 1;\n');
  commitAll(tmp, 'initial');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('auto-review change detection', () => {
  it('leaves claim bookkeeping to Chimera while retaining cascade handling', () => {
    const { api, onPattern } = makeApi();
    createAutoReviewPlugin().setup!(api);

    expect(onPattern).not.toHaveBeenCalledWith('chimera.review_needed', expect.any(Function));
    expect(onPattern).toHaveBeenCalledWith('chimera.review_complete', expect.any(Function));
  });

  it('reviews later content edits even when the porcelain status remains modified', async () => {
    const { api, events, emitCustom } = makeApi();
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    await events['iteration.completed']!();
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 3;\n');
    await events['iteration.completed']!();

    const payloads = reviewPayloads(emitCustom);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]!.files[0]).toMatchObject({
      path: 'tracked.ts',
      status: 'modified',
      content: 'export const value = 2;\n',
    });
    expect(payloads[1]!.files[0]).toMatchObject({
      path: 'tracked.ts',
      status: 'modified',
      content: 'export const value = 3;\n',
    });
  });

  it('retains the latest debounced snapshot until a later eligible iteration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { api, events, emitCustom, log } = makeApi({ debounceMs: 5_000 });
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    await events['iteration.completed']!();

    vi.setSystemTime(101_000);
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 3;\n');
    await events['iteration.completed']!();
    expect(reviewPayloads(emitCustom)).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('retaining 1 pending file'));

    vi.setSystemTime(106_000);
    await events['iteration.completed']!();

    const payloads = reviewPayloads(emitCustom);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.files[0]?.content).toBe('export const value = 3;\n');
  });

  it('never reads or includes untracked files in a review bundle', async () => {
    const { api, events, emitCustom } = makeApi();
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(tmp, '.env.local'), 'PRIVATE_TOKEN=do-not-send\n');
    await events['iteration.completed']!();

    const [payload] = reviewPayloads(emitCustom);
    expect(payload?.files.map((file) => file.path)).toEqual(['tracked.ts']);
    expect(payload?.allChangedFiles?.map((file) => file.path)).not.toContain('.env.local');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_TOKEN');
  });

  it('does not repeat an unchanged mid-session review at session end', async () => {
    const { api, events, emitCustom, log } = makeApi();
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    await events['iteration.completed']!();
    await events['session.ended']!();

    expect(reviewPayloads(emitCustom)).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('unchanged files already have reviews in progress'),
    );
  });

  it('reviews a file again at session end when its content changed after the mid-session claim', async () => {
    const { api, events, emitCustom } = makeApi();
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    await events['iteration.completed']!();
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 3;\n');
    await events['session.ended']!();

    const payloads = reviewPayloads(emitCustom);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]!.files[0]?.content).toBe('export const value = 3;\n');
  });

  it('expires a final-review in-flight entry after five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { api, events, registered } = makeApi({ maxConcurrentReviews: 1 });
    createAutoReviewPlugin().setup!(api);

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    await events['session.ended']!();

    const command = registered.find((candidate) => candidate.name === 'auto-review');
    expect(command).toBeDefined();
    await expect(command!.run('')).resolves.toMatchObject({
      message: expect.stringContaining('In-flight:      1 review(s)'),
    });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(command!.run('')).resolves.toMatchObject({
      message: expect.stringContaining('In-flight:      0 review(s)'),
    });
  });
});

describe('resolveAutoReviewConfig — empty/unknown fallbackProfile', () => {
  // A minimal session Config with a healthy session provider/model but NO
  // fallbackProfiles map, so any profile name resolves to an empty chain.
  function sessionConfig(overrides: Partial<Config> = {}): Config {
    return {
      provider: 'session-provider',
      model: 'session-model',
      ...overrides,
    } as Config;
  }

  it('falls through to the session provider/model when the profile does not exist', () => {
    // An unknown profile name → FallbackProfileManager.resolve returns an empty
    // chain (no throw, no default), so the reviewer inherits the session model.
    const resolved = resolveAutoReviewConfig(
      { enabled: true, fallbackProfile: 'does-not-exist' },
      sessionConfig(),
    );

    expect(resolved.provider).toBe('session-provider');
    expect(resolved.model).toBe('session-model');
  });

  it('does not synthesize fallback models when an unknown profile has no chain', () => {
    const resolved = resolveAutoReviewConfig(
      { enabled: true, fallbackProfile: 'does-not-exist' },
      sessionConfig(),
    );

    expect(resolved.fallbackModels).toEqual([]);
  });

  it('never emits a blank model string that a provider would 401 as "Model is not supported"', () => {
    // Shadow Agent observed opencode-go returning 401 "Model is not supported"
    // for an empty model string. Guard that resolveAutoReviewConfig never yields
    // an empty/whitespace model even on the empty-profile fallthrough path.
    const resolved = resolveAutoReviewConfig(
      { enabled: true, fallbackProfile: '' },
      sessionConfig(),
    );

    expect(resolved.model.trim().length).toBeGreaterThan(0);
    expect(resolved.provider.trim().length).toBeGreaterThan(0);
  });

  it('honors an explicit provider/model override even when the profile is unknown', () => {
    // When the config sets provider/model directly, the empty profile must not
    // override them — this is the safe configuration path.
    const resolved = resolveAutoReviewConfig(
      {
        enabled: true,
        provider: 'explicit-provider',
        model: 'explicit-model',
        fallbackProfile: 'does-not-exist',
      },
      sessionConfig(),
    );

    expect(resolved.provider).toBe('explicit-provider');
    expect(resolved.model).toBe('explicit-model');
  });
});

describe('resolveAutoReviewConfig — fallback chain source', () => {
  function sessionConfig(overrides: Partial<Config> = {}): Config {
    return {
      provider: 'session-provider',
      model: 'session-model',
      ...overrides,
    } as Config;
  }

  it('does not synthesize fallback models when the effective profile is empty', () => {
    const resolved = resolveAutoReviewConfig(
      { enabled: true },
      sessionConfig(),
    );

    expect(resolved.provider).toBe('session-provider');
    expect(resolved.model).toBe('session-model');
    expect(resolved.fallbackModels).toEqual([]);
  });

  it('does not synthesize fallback models when a named profile is unknown', () => {
    const resolved = resolveAutoReviewConfig(
      { enabled: true, fallbackProfile: 'does-not-exist' },
      sessionConfig(),
    );

    expect(resolved.provider).toBe('session-provider');
    expect(resolved.model).toBe('session-model');
    expect(resolved.fallbackModels).toEqual([]);
  });

  it('uses configured profile entries as fallbacks and avoids duplicating the session ref', () => {
    const cfg: Config = {
      provider: 'profile-p1',
      model: 'profile-m1',
      fallbackProfiles: {
        good: ['alt-provider/alt-model', 'session-provider/session-model'],
      },
      providers: {
        'alt-provider': { baseUrl: 'http://alt.test', models: ['alt-model'] },
        'session-provider': {
          baseUrl: 'http://session.test',
          models: ['session-model'],
        },
      },
    } as Config;

    const resolved = resolveAutoReviewConfig(
      { enabled: true, fallbackProfile: 'good' },
      cfg,
    );

    expect(resolved.provider).toBe('alt-provider');
    expect(resolved.model).toBe('alt-model');
    expect(resolved.fallbackModels).toEqual([
      'session-provider/session-model',
      'profile-p1/profile-m1',
    ]);
  });

  it('appends the session ref when the profile chain has entries but none match the session', () => {
    const cfg: Config = {
      provider: 'session-provider',
      model: 'session-model',
      fallbackProfiles: {
        alt: ['alt-provider/alt-model'],
      },
      providers: {
        'alt-provider': { baseUrl: 'http://alt.test', models: ['alt-model'] },
      },
    } as Config;

    const resolved = resolveAutoReviewConfig(
      { enabled: true, fallbackProfile: 'alt' },
      cfg,
    );

    expect(resolved.provider).toBe('alt-provider');
    expect(resolved.model).toBe('alt-model');
    expect(resolved.fallbackModels).toEqual(['session-provider/session-model']);
  });

  it('keeps the fallback chain empty when the only candidate equals the selected primary', () => {
    const resolved = resolveAutoReviewConfig(
      { enabled: true, provider: 'explicit-p', model: 'explicit-m' },
      { provider: 'explicit-p', model: 'explicit-m' } as Config,
    );

    expect(resolved.fallbackModels).toEqual([]);
  });
});

describe('reviewer model round-robin', () => {
  it('builds a deduped primary+fallback pool in stable order', () => {
    const pool = buildReviewerModelPool('a', 'm1', [
      'b/m2',
      'a/m1', // primary duplicate
      'b/m2', // fallback duplicate
      'c/m3',
      '', // blank dropped
      'bare-no-provider', // unusable without provider
    ]);
    expect(pool).toEqual(['a/m1', 'b/m2', 'c/m3']);
  });

  it('rotates primary across the pool and wraps fallbacks', () => {
    const pool = ['p0/m0', 'p1/m1', 'p2/m2'];

    const a0 = selectRoundRobinReviewerAssignment(pool, 0);
    expect(a0).toMatchObject({
      provider: 'p0',
      model: 'm0',
      fallbackModels: ['p1/m1', 'p2/m2'],
      nextCursor: 1,
    });

    const a1 = selectRoundRobinReviewerAssignment(pool, 1);
    expect(a1).toMatchObject({
      provider: 'p1',
      model: 'm1',
      fallbackModels: ['p2/m2', 'p0/m0'],
      nextCursor: 2,
    });

    const a2 = selectRoundRobinReviewerAssignment(pool, 2);
    expect(a2).toMatchObject({
      provider: 'p2',
      model: 'm2',
      fallbackModels: ['p0/m0', 'p1/m1'],
      nextCursor: 0,
    });

    // Wraps
    const a3 = selectRoundRobinReviewerAssignment(pool, 3);
    expect(a3.provider).toBe('p0');
    expect(a3.model).toBe('m0');
    expect(a3.nextCursor).toBe(1);
  });

  it('handles negative cursors via modular wrap', () => {
    const pool = ['p0/m0', 'p1/m1'];
    const a = selectRoundRobinReviewerAssignment(pool, -1);
    expect(a.provider).toBe('p1');
    expect(a.model).toBe('m1');
    expect(a.fallbackModels).toEqual(['p0/m0']);
  });

  it('returns the defensive fallback when the pool is empty', () => {
    const a = selectRoundRobinReviewerAssignment([], 5, 'session-p', 'session-m');
    expect(a).toEqual({
      provider: 'session-p',
      model: 'session-m',
      fallbackModels: [],
      nextCursor: 6,
    });
  });

  it('spreads successive assignments so concurrent reviewers do not share a primary', () => {
    // Simulates N concurrent chimera spawns advancing a shared cursor.
    const pool = buildReviewerModelPool('session-p', 'session-m', [
      'fallback-p1/fallback-m1',
      'fallback-p2/fallback-m2',
    ]);
    expect(pool.length).toBeGreaterThan(1);

    const primaries = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < pool.length; i++) {
      const a = selectRoundRobinReviewerAssignment(pool, cursor);
      primaries.add(`${a.provider}/${a.model}`);
      cursor = a.nextCursor;
    }
    expect(primaries.size).toBe(pool.length);
  });
});

/**
 * A snapshot pass reads every changed file in the working tree. Overlapping
 * passes each retain everything they have read so far, which measured 1.28GB of
 * live strings in a real session (~180 stacked passes over ~90 changed files).
 * These pin the two bounds that keep that from coming back.
 */
describe('auto-review snapshot memory bounds', () => {
  it('skips a snapshot pass while another is still walking the tree', async () => {
    const { api, events, log } = makeApi();
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');

    // Two iterations that overlap in time — exactly the shape that stacked in
    // production, where an iteration completed before the previous pass did.
    const first = events['iteration.completed']!();
    const second = events['iteration.completed']!();
    await Promise.all([first, second]);

    // Assert the SKIP, not the emitted-payload count: the claim registry
    // already dedupes identical content, so a payload count of 1 passes even
    // with the guard removed. Only the log proves which path ran.
    expect(log.info).toHaveBeenCalledWith(
      '[auto-review] snapshot pass already in flight, skipping',
    );
  });

  it('does not read files above the per-file snapshot cap', async () => {
    const { api, events, emitCustom } = makeApi();
    createAutoReviewPlugin().setup!(api);
    await events['agent.run.started']!();

    // 300KB > MAX_SNAPSHOT_FILE_BYTES (256KB): the class of file (lockfiles,
    // changelogs, generated bundles) that dominated the retained heap.
    await fs.writeFile(path.join(tmp, 'huge.ts'), `// ${'x'.repeat(300 * 1024)}\n`);
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 2;\n');
    commitAll(tmp, 'add huge');
    await fs.writeFile(path.join(tmp, 'huge.ts'), `// ${'y'.repeat(300 * 1024)}\n`);
    await fs.writeFile(path.join(tmp, 'tracked.ts'), 'export const value = 3;\n');

    await events['iteration.completed']!();

    const payloads = reviewPayloads(emitCustom);
    expect(payloads).toHaveLength(1);
    const paths = payloads[0]!.files.map((file) => file.path);
    expect(paths).toContain('tracked.ts');
    expect(paths).not.toContain('huge.ts');
  });
});
