import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { describe, expect, it, vi } from 'vitest';
import { diagnoseConfig } from '../src/config-doctor.js';
import { buildDoctorCommand } from '../src/slash-commands/doctor.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe('diagnoseConfig', () => {
  it('reports a clean config as unchanged with no findings', () => {
    const report = diagnoseConfig({
      version: 1,
      provider: 'anthropic',
      model: 'claude-fable-5',
      hints: true,
    });
    expect(report.findings).toEqual([]);
    expect(report.changed).toBe(false);
  });

  it('does not flag any valid Config key as unknown — regression', () => {
    // Spot-check, not the safety net. This list is hand-written, so it drifts
    // exactly like the whitelist it pins — which is how eight real fields came
    // to be reported as "unknown key". The real gate is the `ConfigKeyCoverage`
    // type in config-doctor.ts, which `tsc` checks against `keyof Config`.
    const report = diagnoseConfig({
      version: 1,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      hints: true,
      uiLocale: 'en',
      favoriteModels: ['gpt-4'],
      favoriteModelsOnly: false,
      Sage: { enabled: true },
      skills: ['git-flow'],
      brain: { defaultMode: 'off' },
      fallbackProfiles: { coding: ['gpt-4o'] },
      fallbackMaxLastResortCandidates: 20,
      // `agents` is nested here — it was never a top-level Config field, but
      // the whitelist carried it as a phantom entry, so a stray top-level
      // `agents` block used to be waved through.
      acp: { agents: {} },
      fleet: { enabled: false },
      git: { identity: { name: 'x', email: 'x@x' } },
      pluginManager: { locked: ['secret-scanner'] },
    });
    const unknownKeys = report.findings.filter((f) => f.problem.includes('unknown key'));
    expect(unknownKeys).toHaveLength(0);
    expect(report.findings).toHaveLength(0);
  });

  it('accepts the fields WrongStack writes to its own config — regression', () => {
    // Every key here was reported to the user as "unknown key — left untouched
    // (delete it manually if unwanted)" while WrongStack itself was writing it:
    // `/theme` writes `themePreset`, the WebUI prompt-variant picker and
    // `boot.ts` write `systemPrompt`, `/fallback gate` writes
    // `fallbackGateSeconds`. Following that advice would have silently reset
    // the user's theme and prompt variant.
    const report = diagnoseConfig({
      version: 1,
      activeProfile: 'default',
      themePreset: 'github-dark',
      systemPrompt: { variant: 'pro' },
      modelTiers: { enabled: true },
      chronicle: { retentionDays: 30 },
      cloudSync: { enabled: false },
      fallbackProfile: 'coding',
      fallbackGateSeconds: 7,
    });
    expect(report.findings).toEqual([]);
    expect(report.changed).toBe(false);
  });

  it('still flags a genuinely unknown top-level key', () => {
    // The widened whitelist must not turn the check into a no-op.
    const report = diagnoseConfig({ version: 1, agents: {}, notAConfigField: 1 });
    const unknown = report.findings.filter((f) => f.problem.includes('unknown key'));
    expect(unknown.map((f) => f.path).sort()).toEqual(['agents', 'notAConfigField']);
    expect(unknown.every((f) => f.severity === 'warning')).toBe(true);
  });

  it('coerces stringified booleans and removes uncoercible ones', () => {
    const report = diagnoseConfig({ hints: 'true', debugStream: 'banana' });
    expect(report.fixed['hints']).toBe(true);
    expect('debugStream' in report.fixed).toBe(false);
    expect(report.changed).toBe(true);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.every((f) => f.severity === 'error' && f.fix)).toBe(true);
  });

  it('repairs maxConcurrent strings and keeps zero as runtime default', () => {
    expect(diagnoseConfig({ maxConcurrent: '8' }).fixed['maxConcurrent']).toBe(8);
    expect(diagnoseConfig({ maxConcurrent: 0 }).fixed['maxConcurrent']).toBe(0);
    expect('maxConcurrent' in diagnoseConfig({ maxConcurrent: 'lots' }).fixed).toBe(false);
  });

  it('repairs fleet.budget numeric ceilings', () => {
    const report = diagnoseConfig({
      fleet: {
        budget: {
          maxSpawns: '256',
          maxTokens: -10,
          maxCostUsd: '1.5',
          junk: true,
        },
      },
    });
    const fleet = report.fixed['fleet'] as { budget: Record<string, unknown> };
    expect(fleet.budget['maxSpawns']).toBe(256);
    expect(fleet.budget['maxTokens']).toBe(0);
    expect(fleet.budget['maxCostUsd']).toBe(1.5);
    expect(report.findings.some((f) => f.path.startsWith('fleet.budget.'))).toBe(true);
  });

  it('removes non-object fleet.budget', () => {
    const report = diagnoseConfig({ fleet: { budget: 'nope' } });
    const fleet = report.fixed['fleet'] as Record<string, unknown>;
    expect(fleet['budget']).toBeUndefined();
    expect(report.findings.some((f) => f.path === 'fleet.budget')).toBe(true);
  });

  it('repairs fallbackMaxLastResortCandidates: strips non-numbers, floors fractions, keeps valid values', () => {
    // Valid positive number — kept as-is.
    expect(diagnoseConfig({ fallbackMaxLastResortCandidates: 20 }).fixed).toMatchObject({
      fallbackMaxLastResortCandidates: 20,
    });
    // String number — coerced to number.
    expect(diagnoseConfig({ fallbackMaxLastResortCandidates: '8' }).fixed).toMatchObject({
      fallbackMaxLastResortCandidates: 8,
    });
    // Zero — kept (means "disabled").
    expect(diagnoseConfig({ fallbackMaxLastResortCandidates: 0 }).fixed).toMatchObject({
      fallbackMaxLastResortCandidates: 0,
    });
    // Fraction — floored to integer.
    expect(diagnoseConfig({ fallbackMaxLastResortCandidates: 3.7 }).fixed).toMatchObject({
      fallbackMaxLastResortCandidates: 3,
    });
    // Negative — clamped to 0 (disabled). Consistent with maxConcurrent
    // clamping: fix to a valid value rather than silently removing the
    // user's explicit field and reverting to the built-in default.
    const neg = diagnoseConfig({ fallbackMaxLastResortCandidates: -1 });
    expect(neg.fixed).toMatchObject({ fallbackMaxLastResortCandidates: 0 });
    expect(neg.findings.some((f) => f.path === 'fallbackMaxLastResortCandidates')).toBe(true);
    // NaN — removed.
    const nan = diagnoseConfig({ fallbackMaxLastResortCandidates: NaN });
    expect('fallbackMaxLastResortCandidates' in nan.fixed).toBe(false);
    expect(nan.findings.some((f) => f.path === 'fallbackMaxLastResortCandidates')).toBe(true);
  });

  it('drops invalid autonomy enums and negative delays', () => {
    const report = diagnoseConfig({
      autonomy: {
        defaultMode: 'automatic',
        enhanceLanguage: 'klingon',
        autoProceedDelayMs: -5,
        enhance: 'true',
      },
    });
    const autonomy = report.fixed['autonomy'] as Record<string, unknown>;
    expect('defaultMode' in autonomy).toBe(false);
    expect('enhanceLanguage' in autonomy).toBe(false);
    expect(autonomy['autoProceedDelayMs']).toBe(0);
    expect(autonomy['enhance']).toBe(true);
  });

  it('removes malformed plugins entries but keeps valid ones', () => {
    const report = diagnoseConfig({
      plugins: ['my-plugin', { name: 'other', enabled: 'false' }, 42, { noName: true }],
    });
    const plugins = report.fixed['plugins'] as unknown[];
    expect(plugins).toHaveLength(2);
    expect((plugins[1] as Record<string, unknown>)['enabled']).toBe(false);
  });

  it('validates and repairs plugin-manager locks without removing the policy', () => {
    const report = diagnoseConfig({
      pluginManager: { locked: [' secret-scanner ', '', 42, 'secret-scanner', '*'] },
    });

    expect(report.fixed['pluginManager']).toEqual({ locked: ['secret-scanner', '*'] });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ path: 'pluginManager.locked', severity: 'error' }),
    );
  });

  it('removes non-object extensions entries', () => {
    const report = diagnoseConfig({ extensions: { good: { a: 1 }, bad: 'nope' } });
    const ext = report.fixed['extensions'] as Record<string, unknown>;
    expect('good' in ext).toBe(true);
    expect('bad' in ext).toBe(false);
  });

  it('validates extensions against plugin configSchemas and removes invalid options', () => {
    const report = diagnoseConfig(
      { extensions: { 'semver-bump': { defaultPart: 'gigantic', tagPrefix: 'v' } } },
      [
        {
          name: 'semver-bump',
          configSchema: {
            type: 'object',
            properties: {
              defaultPart: { type: 'string', enum: ['major', 'minor', 'patch', 'auto'] },
              tagPrefix: { type: 'string' },
            },
          },
        },
      ],
    );
    const section = (report.fixed['extensions'] as Record<string, Record<string, unknown>>)[
      'semver-bump'
    ]!;
    expect('defaultPart' in section).toBe(false);
    expect(section['tagPrefix']).toBe('v');
  });

  it('renames case-typo top-level keys and warns on truly unknown ones', () => {
    const report = diagnoseConfig({ debugstream: true, frobnicate: 1 });
    expect(report.fixed['debugStream']).toBe(true);
    expect('debugstream' in report.fixed).toBe(false);
    expect(report.fixed['frobnicate']).toBe(1); // left untouched
    const unknown = report.findings.find((f) => f.path === 'frobnicate');
    expect(unknown?.severity).toBe('warning');
    expect(unknown?.fix).toBeUndefined();
  });

  it('renames a blank provider id to custom-N and preserves its value', () => {
    const report = diagnoseConfig({
      providers: {
        '': { type: 'custom', family: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' },
        anthropic: { type: 'anthropic' },
      },
    });
    const providers = report.fixed['providers'] as Record<string, Record<string, unknown>>;
    expect('' in providers).toBe(false);
    expect(providers['custom-1']?.['baseUrl']).toBe('http://localhost:1234/v1');
    expect('anthropic' in providers).toBe(true);
    const finding = report.findings.find((f) => f.path === 'providers.(empty)');
    expect(finding?.severity).toBe('error');
    expect(finding?.fix).toBe('renamed to "custom-1"');
    expect(report.changed).toBe(true);
  });

  it('skips custom-N ids already taken when renaming blanks', () => {
    const report = diagnoseConfig({
      providers: {
        '': { type: 'a' },
        ' ': { type: 'b' },
        'custom-1': { type: 'c' },
      },
    });
    const providers = report.fixed['providers'] as Record<string, unknown>;
    expect(Object.keys(providers).sort()).toEqual(['custom-1', 'custom-2', 'custom-3']);
  });

  it('leaves a healthy providers map untouched', () => {
    const report = diagnoseConfig({ providers: { anthropic: { type: 'anthropic' } } });
    expect(report.findings.some((f) => f.path.startsWith('providers'))).toBe(false);
    expect(report.changed).toBe(false);
  });

  it('reports a non-object providers value without fixing it', () => {
    const report = diagnoseConfig({ providers: 'nope' });
    const finding = report.findings.find((f) => f.path === 'providers');
    expect(finding?.severity).toBe('error');
    expect(finding?.fix).toBeUndefined();
    expect(report.fixed['providers']).toBe('nope');
  });

  it('warns on plaintext secrets but never rewrites them', () => {
    const report = diagnoseConfig({ apiKey: 'sk-plain', sync: { githubToken: 'enc:v1:abc' } });
    const warning = report.findings.find((f) => f.path === 'apiKey');
    expect(warning?.severity).toBe('warning');
    expect(report.findings.some((f) => f.path === 'sync.githubToken')).toBe(false);
    expect(report.fixed['apiKey']).toBe('sk-plain');
  });
});

// ---------------------------------------------------------------------------
// /doctor command
// ---------------------------------------------------------------------------

function makeCtx(
  globalContent?: string,
  projectContent?: string,
): {
  ctx: SlashCommandContext;
  globalConfig: string;
  inProjectConfig: string;
  update: ReturnType<typeof vi.fn>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-doctor-test-'));
  const wsDir = path.join(dir, '.wrongstack');
  mkdirSync(wsDir, { recursive: true });
  const globalConfig = path.join(wsDir, 'config.json');
  const inProjectConfig = path.join(dir, 'project', 'config.json');
  if (globalContent !== undefined) writeFileSync(globalConfig, globalContent);
  if (projectContent !== undefined) {
    mkdirSync(path.dirname(inProjectConfig), { recursive: true });
    writeFileSync(inProjectConfig, projectContent);
  }
  const update = vi.fn();
  const ctx = {
    configStore: { get: vi.fn(() => ({})), update },
    paths: { globalConfig, profileConfig: () => globalConfig, inProjectConfig },
  } as never as SlashCommandContext;
  return { ctx, globalConfig, inProjectConfig, update };
}

describe('/doctor slash command', () => {
  it('reports findings without writing in report mode', async () => {
    const content = JSON.stringify({ hints: 'true' });
    const { ctx, globalConfig } = makeCtx(content);
    const res = await buildDoctorCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('hints');
    expect(text).toContain('auto-fixable');
    expect(readFileSync(globalConfig, 'utf8')).toBe(content); // untouched
  });

  it('reports a healthy config', async () => {
    const { ctx } = makeCtx(JSON.stringify({ version: 1, hints: true }));
    const res = await buildDoctorCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('config is healthy');
  });

  it('fix mode repairs the file, backs it up, and updates the config store', async () => {
    const { ctx, globalConfig, update } = makeCtx(
      JSON.stringify({ hints: 'true', maxConcurrent: '6' }),
    );
    const res = await buildDoctorCommand(ctx).run!('fix');
    expect(stripAnsi(res!.message!)).toContain('fixes written');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.hints).toBe(true);
    expect(written.maxConcurrent).toBe(6);
    expect(existsSync(`${globalConfig}.last`)).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ hints: true }));
  });

  it('fix mode restores corrupt JSON from the .last backup', async () => {
    const good = JSON.stringify({ version: 1, hints: true });
    const { ctx, globalConfig } = makeCtx('{ this is not json');
    writeFileSync(`${globalConfig}.last`, good);

    const res = await buildDoctorCommand(ctx).run!('fix');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('restored from config.json.last');
    expect(JSON.parse(readFileSync(globalConfig, 'utf8'))).toEqual({ version: 1, hints: true });
    // The corrupt original is preserved next to the file
    const dir = path.dirname(globalConfig);
    expect(readdirSync(dir).some((f) => f.endsWith('.broken.bak'))).toBe(true);
  });

  it('report mode flags corrupt JSON without touching the file', async () => {
    const { ctx, globalConfig } = makeCtx('{ broken');
    const res = await buildDoctorCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('invalid JSON');
    expect(readFileSync(globalConfig, 'utf8')).toBe('{ broken');
  });

  it('warns about credential fields in the project config', async () => {
    const { ctx } = makeCtx(
      JSON.stringify({ version: 1 }),
      JSON.stringify({ apiKey: 'enc:v1:abc', hints: true }),
    );
    const res = await buildDoctorCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('not project-safe');
  });

  it('rejects unknown subcommands', async () => {
    const { ctx } = makeCtx();
    const res = await buildDoctorCommand(ctx).run!('heal');
    // `sessions` joined `fix` as a subcommand, so the usage line names both.
    expect(stripAnsi(res!.message!)).toContain('Usage: /doctor [fix|sessions [fix]]');
  });
});

/**
 * `/doctor sessions` is the session-corpus half. It shares the command so
 * "something is wrong with my setup" has one entry point, but it diagnoses a
 * completely different subject and must not touch the config path.
 */
describe('/doctor sessions', () => {
  function sessionsCtx(): { ctx: SlashCommandContext; sessionsDir: string } {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), 'wstack-doctor-sessions-'));
    const ctx = {
      configStore: { get: vi.fn(() => ({})), update: vi.fn() },
      paths: { projectSessions: sessionsDir },
    } as never as SlashCommandContext;
    return { ctx, sessionsDir };
  }

  const ev = (type: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ type, ts: '2026-08-29T10:00:00.000Z', ...extra })}
`;

  it('reports on the corpus and offers a repair without performing one', async () => {
    const { ctx, sessionsDir } = sessionsCtx();
    const day = path.join(sessionsDir, '2026-08-29');
    mkdirSync(day, { recursive: true });
    const journal = path.join(day, 'sess_a.jsonl');
    const body =
      ev('session_start', { id: '2026-08-29/sess_a', model: 'm', provider: 'p' }) +
      ev('user_input', { content: 'a question' });
    writeFileSync(journal, body);

    const res = await buildDoctorCommand(ctx).run!('sessions');
    const text = stripAnsi(res!.message!);

    expect(text).toContain('Session Doctor');
    expect(text).toContain('missing_summary');
    expect(text).toContain('/doctor sessions fix');
    // Report mode wrote nothing: no sidecar appeared and the journal is intact.
    expect(existsSync(path.join(day, 'sess_a.summary.json'))).toBe(false);
    expect(readFileSync(journal, 'utf8')).toBe(body);
  });

  it('rebuilds derived artifacts on fix and leaves the journal byte-identical', async () => {
    const { ctx, sessionsDir } = sessionsCtx();
    const day = path.join(sessionsDir, '2026-08-29');
    mkdirSync(day, { recursive: true });
    const journal = path.join(day, 'sess_b.jsonl');
    const body =
      ev('session_start', { id: '2026-08-29/sess_b', model: 'm', provider: 'p' }) +
      ev('user_input', { content: 'rebuild me' }) +
      ev('session_end');
    writeFileSync(journal, body);

    const res = await buildDoctorCommand(ctx).run!('sessions fix');
    const text = stripAnsi(res!.message!);

    expect(text).toContain('rebuilt 1 summary sidecar');
    expect(text).toContain('Journals were not modified.');
    const sidecar = JSON.parse(readFileSync(path.join(day, 'sess_b.summary.json'), 'utf8'));
    expect(sidecar.title).toContain('rebuild me');
    // The invariant the whole feature rests on.
    expect(readFileSync(journal, 'utf8')).toBe(body);
  });

  it('rejects an unknown session subcommand rather than guessing', async () => {
    const { ctx } = sessionsCtx();
    const res = await buildDoctorCommand(ctx).run!('sessions wipe');
    expect(stripAnsi(res!.message!)).toContain('Usage: /doctor sessions [fix]');
  });
});
