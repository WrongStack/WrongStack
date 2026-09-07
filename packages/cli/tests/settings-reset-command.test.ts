import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { executeSettingsSubcommand } from '../src/slash-commands/settings-mutations.js';

let dir: string;
let globalConfig: string;
let inProjectConfig: string;

/** A user config carrying identity + custom values that a reset must keep. */
const userConfig = {
  version: 1,
  activeProfile: 'default',
  provider: 'p1',
  model: 'm1',
  providers: {
    p1: { type: 'openai-compatible', apiKeys: [{ label: 'default', apiKey: 'secret-key' }] },
  },
  mcpServers: { context7: { url: 'https://mcp.example/mcp' } },
  fallbackProfiles: { default: ['p1/m1'] },
  configScope: 'global',
  context: { softThreshold: 0.42, myCustom: 'keep-me' },
  tools: { maxIterations: 7, nextsteps: { enabled: true } },
  autonomy: { autoProceedDelayMs: 99_999, thinkingWord: 'custom' },
  yolo: false,
  maxConcurrent: 2,
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wstack-settings-reset-'));
  globalConfig = path.join(dir, 'global', 'config.json');
  inProjectConfig = path.join(dir, 'project', 'config.json');
  mkdirSync(path.dirname(globalConfig), { recursive: true });
  writeFileSync(globalConfig, JSON.stringify(userConfig));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await import('node:fs/promises').then((fsp) =>
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
  );
});

function makeCtx(config: Record<string, unknown>, confirmResult: boolean | null) {
  const store = {
    get: vi.fn(() => config),
    update: vi.fn(),
  };
  const ctx = {
    configStore: store,
    paths: { globalConfig, profileConfig: () => globalConfig, inProjectConfig },
    confirm: vi.fn(async () => confirmResult),
  } as never as SlashCommandContext;
  return { ctx, store };
}

function run(args: string, ctx: SlashCommandContext) {
  return executeSettingsSubcommand('reset', args.length > 0 ? args.split(' ') : [], ctx);
}

function written(): Record<string, unknown> {
  return JSON.parse(readFileSync(globalConfig, 'utf8'));
}

describe('/settings reset', () => {
  it('with no args lists sections and writes nothing', async () => {
    const { ctx } = makeCtx(userConfig, true);
    const res = await run('', ctx);
    const text = stripAnsi(res.message);
    expect(text).toContain('reset all');
    expect(text).toContain('context');
    expect(text).toContain('Identity is kept');
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(written()).toEqual(userConfig);
  });

  it('rejects unknown sections without touching the file', async () => {
    const { ctx } = makeCtx(userConfig, true);
    const res = await run('context nope', ctx);
    expect(stripAnsi(res.message)).toContain('Unknown section');
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(written()).toEqual(userConfig);
  });

  it('cancels without writing when the user declines', async () => {
    const before = readFileSync(globalConfig, 'utf8');
    const { ctx } = makeCtx(userConfig, false);
    const res = await run('all', ctx);
    expect(stripAnsi(res.message)).toContain('cancelled');
    expect(readFileSync(globalConfig, 'utf8')).toBe(before);
  });

  it('treats a null answer (cancel) as no-op', async () => {
    const { ctx } = makeCtx(userConfig, null);
    const res = await run('context', ctx);
    expect(stripAnsi(res.message)).toContain('cancelled');
    expect(written()).toEqual(userConfig);
  });

  it('resets a single section with a defaults-wins merge (extension keys kept)', async () => {
    const { ctx, store } = makeCtx(userConfig, true);
    const res = await run('context', ctx);
    expect(stripAnsi(res.message)).toContain('Reset 1 section');
    const cfg = written();
    // Factory values overwrite user values...
    expect(cfg.context.softThreshold).toBe(0.75);
    // ...but extension keys inside the section survive.
    expect(cfg.context.myCustom).toBe('keep-me');
    // Other sections are untouched.
    expect(cfg.tools.maxIterations).toBe(7);
    expect(cfg.autonomy.autoProceedDelayMs).toBe(99_999);
    // In-memory store received the same patch.
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.any(Object) }),
    );
  });

  it('reset all materializes factory defaults and keeps identity', async () => {
    const { ctx } = makeCtx(userConfig, true);
    const res = await run('all', ctx);
    expect(stripAnsi(res.message)).toContain('Reset 17 section');
    const cfg = written();
    // Behavior defaults materialized.
    expect(cfg.tools.maxIterations).toBe(0);
    expect(cfg.autonomy.autoProceedMaxIterations).toBe(0);
    expect(cfg.autonomy.autoProceedDelayMs).toBe(15_000);
    expect(cfg.autonomy.enhanceLanguage).toBe('english');
    expect(cfg.yolo).toBe(true);
    expect(cfg.maxConcurrent).toBe(10);
    expect(cfg.context.softThreshold).toBe(0.75);
    expect(cfg.log.level).toBe('warn');
    expect(cfg.session.auditLevel).toBe('full');
    expect(cfg.systemPrompt.variant).toBe('pro');
    expect(cfg.modelRuntime.reasoning).toEqual({
      mode: 'auto',
      effort: 'medium',
      preserve: false,
    });
    expect(cfg.Sage.inject.taskAware).toBe(true);
    // Identity and routing survive.
    expect(cfg.provider).toBe('p1');
    expect(cfg.model).toBe('m1');
    expect(cfg.providers.p1.apiKeys[0].apiKey).toBe('secret-key');
    expect(cfg.mcpServers.context7.url).toBe('https://mcp.example/mcp');
    expect(cfg.fallbackProfiles.default).toEqual(['p1/m1']);
    expect(cfg.configScope).toBe('global');
    // Extension keys inside reset sections survive.
    expect(cfg.tools.nextsteps.enabled).toBe(true);
    expect(cfg.context.myCustom).toBe('keep-me');
  });
});
