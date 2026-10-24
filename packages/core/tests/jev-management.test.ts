import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@wrongstack/contracts/types/config/root';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultConfigStore } from '../src/storage/config-store.js';
import {
  appendJevActivity,
  jevActivitySnapshot,
  observeJevClient,
} from '../src/typesafe/activity.js';
import {
  jevSettingsSnapshot,
  saveJevSettings,
  validateJevSettingsPatch,
} from '../src/typesafe/settings.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jev-test-'));
  dirs.push(dir);
  const file = join(dir, 'config.json');
  const initial = {
    version: 1,
    typesafe: {
      enabled: true,
      route: 'typesafe',
      apiKey: 'old',
      endpoint: 'https://old.test',
      model: 'old-model',
    },
    unrelated: 42,
  };
  await writeFile(file, JSON.stringify(initial));
  return { file, store: new DefaultConfigStore(initial as unknown as Config) };
}
describe('Jev settings', () => {
  it('persists the master disable while preserving the stored key and consumer choices', async () => {
    const { file, store } = await fixture();
    await saveJevSettings(store, file, undefined, { features: { tool: true, brain: false } });
    await saveJevSettings(store, file, undefined, { enabled: false });
    expect(JSON.parse(await readFile(file, 'utf8')).typesafe).toMatchObject({
      enabled: false,
      apiKey: 'old',
      judgments: { tool: true, brain: false },
    });
    expect(jevSettingsSnapshot(store.get())).toMatchObject({
      enabled: false,
      status: 'disabled',
      features: { tool: true, brain: false },
      readiness: { tool: { state: 'disabled' } },
    });
  });
  it('distinguishes permission from missing dependencies', () => {
    const config = {
      version: 1,
      typesafe: { enabled: true, apiKey: 'k' },
      context: { strategy: 'hybrid' },
      modelTiers: { enabled: false },
      skills: { suggest: { enabled: true } },
      features: { skills: false },
    } as unknown as Config;
    const snapshot = jevSettingsSnapshot(config);
    expect(snapshot.features.compaction).toBe(true);
    expect(snapshot.readiness.compaction).toEqual({
      state: 'blocked',
      reason: 'selective-required',
    });
    expect(snapshot.readiness.modelTier?.reason).toBe('tiers-disabled');
    expect(snapshot.readiness.skillSuggestion?.reason).toBe('skills-disabled');
    expect(snapshot.readiness.memoryRecall?.reason).toBe('recall-injection-required');
    expect(
      jevSettingsSnapshot({ ...config, Sage: { enabled: false } }).readiness.memoryRecall?.reason,
    ).toBe('memory-disabled');
    expect(snapshot.readiness.brain?.state).toBe('conditional');
    expect(
      jevSettingsSnapshot({
        ...config,
        context: { ...config.context, strategy: 'selective' },
        modelTiers: { enabled: true, levels: { budget: {}, premium: {} } },
      }).readiness.modelTier?.state,
    ).toBe('conditional');
  });
  it('saves selective compaction without overwriting sibling context preferences', async () => {
    const { file, store } = await fixture();
    await writeFile(
      file,
      JSON.stringify({
        context: { preserveK: 9 },
        Sage: { inject: { toolResults: true } },
        unrelated: 42,
      }),
    );
    await saveJevSettings(store, file, undefined, {
      contextStrategy: 'selective',
      recallTurnContext: true,
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      context: { strategy: 'selective', preserveK: 9 },
      Sage: { inject: { toolResults: true, turnContext: true } },
      unrelated: 42,
    });
    expect(store.get().context.strategy).toBe('selective');
  });
  it('clears route credentials and stale overrides while preserving unrelated profile settings', async () => {
    const { file, store } = await fixture();
    await saveJevSettings(store, file, undefined, { route: 'openrouter' });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw).toMatchObject({ unrelated: 42, typesafe: { enabled: true, route: 'openrouter' } });
    expect(raw.typesafe.apiKey).toBeUndefined();
    expect(raw.typesafe.endpoint).toBeUndefined();
    expect(store.get().typesafe?.model).toBeUndefined();
  });
  it('encrypts a replacement key and never includes it in snapshots', async () => {
    const { file, store } = await fixture();
    const encrypt = vi.fn(() => 'enc:v1:cipher');
    const vault = {
      keyVersion: 1,
      encrypt,
      decrypt: vi.fn(),
      isEncrypted: (s: string) => s.startsWith('enc:'),
    };
    await saveJevSettings(store, file, vault, {
      apiKey: 'new-secret',
      features: { brain: false, skillSuggestion: true, tool: false },
    });
    expect(await readFile(file, 'utf8')).not.toContain('new-secret');
    expect(store.get().typesafe?.apiKey).toBe('new-secret');
    expect(store.get().typesafe?.judgments?.tool).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8')).typesafe.judgments.tool).toBe(false);
    expect(JSON.stringify(jevSettingsSnapshot(store.get()))).not.toContain('new-secret');
    expect(jevSettingsSnapshot(store.get()).features).toMatchObject({
      brain: false,
      skillSuggestion: true,
      tool: false,
    });
  });
  it('does not alter live config or corrupt files after a failed save', async () => {
    const { file, store } = await fixture();
    await writeFile(file, '{broken');
    await expect(saveJevSettings(store, file, undefined, { model: 'new' })).rejects.toThrow();
    expect(store.get().typesafe?.model).toBe('old-model');
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
  it.each([
    { route: 'bogus' },
    { features: { brain: 'false' } },
    { features: { unknown: true } },
    { requestTimeoutMs: -1 },
    { endpoint: 'https://user:secret@host/' },
    { endpoint: 'https://host/?key=secret' },
    { arbitrary: true },
  ])('rejects invalid patches %j', (patch) => {
    expect(() => validateJevSettingsPatch(patch)).toThrow();
  });

  // The endpoint is where the stored API key and every judgment payload go,
  // and `apply()` keeps the existing key when only the endpoint changes — so a
  // cleartext remote endpoint is a credential and state disclosure. Loopback
  // stays allowed: a local proxy or mock cannot leave the machine.
  it.each([
    'http://evil.test/v1',
    'http://10.0.0.5/v1',
    'http://[2001:db8::1]/v1',
    'http://127.0.0.1.evil.test/v1',
  ])('rejects cleartext non-loopback endpoint %s', (endpoint) => {
    expect(() => validateJevSettingsPatch({ endpoint })).toThrow(/https/);
  });

  it.each([
    'http://localhost:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.5.5.5/v1',
    'http://[::1]:8080/v1',
    'https://remote.test/v1',
  ])('accepts %s', (endpoint) => {
    expect(() => validateJevSettingsPatch({ endpoint })).not.toThrow();
  });
});
describe('Jev activity', () => {
  it('rotates the disk log and appends valid JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-log-'));
    dirs.push(dir);
    const file = join(dir, 'jev.jsonl');
    await writeFile(file, 'x'.repeat(5 * 1024 * 1024 + 1));
    const entry = {
      id: 'request',
      at: 123,
      feature: 'brain',
      project: dir,
      route: 'typesafe',
      model: 'jev',
      durationMs: 10,
      outcome: 'answered' as const,
    };
    await appendJevActivity(file, entry);
    expect(JSON.parse((await readFile(file, 'utf8')).trim())).toEqual(entry);
    expect((await readFile(`${file}.1`, 'utf8')).length).toBe(5 * 1024 * 1024 + 1);
    await appendJevActivity(file, { ...entry, id: 'next' });
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
  });
  it('distinguishes incomplete responses from valid decisions', async () => {
    const client = observeJevClient(
      {
        open: false,
        systemOne: async () => ({ answers: {}, usage: { inputTokens: 1, outputTokens: 0 } }),
      },
      'typesafe',
      'jev',
    );
    await client.systemOne({
      state: {},
      questions: { expected: { type: 'noul', instructions: 'Check' } },
    });
    expect(jevActivitySnapshot().entries[0]).toMatchObject({
      outcome: 'incomplete',
      reason: 'missing_or_malformed_answers',
    });
  });
  it('attributes success without logging request state, instructions or response legends', async () => {
    const client = observeJevClient(
      {
        open: false,
        systemOne: async () => ({
          answers: { fits: { type: 'noul', noul: 0.8 } },
          usage: { inputTokens: 23, outputTokens: 0 },
        }),
      },
      'typesafe',
      'jev-latest',
    );
    await client.systemOne({
      activityFeature: 'memoryRecall',
      activityPurpose: 'self-test',
      state: { secret: 'sensitive-prompt' },
      questions: { fits: { type: 'noul', instructions: 'private-instructions' } },
    });
    const entry = jevActivitySnapshot().entries[0];
    expect(entry).toMatchObject({
      feature: 'memoryRecall',
      purpose: 'self-test',
      outcome: 'answered',
      inputTokens: 23,
      answers: { fits: 0.8 },
    });
    expect(JSON.stringify(entry)).not.toMatch(/sensitive-prompt|private-instructions/);
  });
  it('logs blocked/failing calls and preserves the original error without exposing it', async () => {
    const error = new Error('Bearer secret provider body');
    error.name = 'TypeSafeDisabledError';
    const client = observeJevClient(
      {
        open: true,
        systemOne: async () => {
          throw error;
        },
      },
      'openrouter',
      'jev',
    );
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toBe(error);
    expect(client.open).toBe(true);
    expect(jevActivitySnapshot().entries[0]).toMatchObject({
      outcome: 'fallback',
      reason: 'TypeSafeDisabledError',
    });
    expect(JSON.stringify(jevActivitySnapshot().entries[0])).not.toContain('Bearer');
  });
});
