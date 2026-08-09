import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { describe, expect, it, vi } from 'vitest';
import { buildContextCommand } from '../src/slash-commands/context.js';

function fakeRenderer() {
  const writes: string[] = [];
  return {
    writes,
    write: (s: string) => {
      writes.push(s);
    },
  };
}

function fakeCtx(overrides: Record<string, unknown> = {}): Context {
  const messages: unknown[] = [];
  const todos: unknown[] = [];
  return {
    messages,
    tools: [],
    todos,
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    systemPrompt: [{ type: 'text', text: 'sys' }],
    model: 'opus',
    cwd: '/wd',
    projectRoot: '/wd',
    meta: {} as Record<string, unknown>,
    state: {
      replaceMessages: vi.fn((m: unknown[]) => {
        messages.splice(0, messages.length, ...m);
      }),
    },
    ...overrides,
  } as never as Context;
}

describe('buildContextCommand', () => {
  it('default invocation prints the context summary', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx();
    const res = await cmd.run('', ctx);
    expect(res?.message).toContain('Context Window');
    expect(res?.message).toContain('messages:');
    expect(res?.message).toContain('mode:');
    expect(renderer.writes.length).toBeGreaterThan(0);
  });

  it('prints a cache-hit line when the token counter reports cached tokens', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx({
      tokenCounter: {
        cacheStats: () => ({
          readTokens: 12_000,
          writeTokens: 3_000,
          hitRatio: 0.4,
          savedUsd: 0.34,
        }),
      },
    });
    const res = await cmd.run('', ctx);
    expect(res?.message).toContain('cache-hit: 40.0%');
    expect(res?.message).toContain('read 12,000');
    expect(res?.message).toContain('write 3,000');
    expect(res?.message).toContain('saved ~$0.34');
  });

  it('omits the cache-hit line when nothing has been cached', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx({
      tokenCounter: { cacheStats: () => ({ readTokens: 0, writeTokens: 0, hitRatio: 0 }) },
    });
    const res = await cmd.run('', ctx);
    expect(res?.message).not.toContain('cache-hit');
  });

  it('"detail" adds model/cwd/projectRoot/mtimes/file list when files present', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx();
    ctx.readFiles.add('/a/b.ts');
    ctx.fileMtimes.set('/a/b.ts', 1);
    const res = await cmd.run('detail', ctx);
    expect(res?.message).toContain('model:');
    expect(res?.message).toContain('cwd:');
    expect(res?.message).toContain('projectRoot:');
    expect(res?.message).toContain('file mtimes:');
    expect(res?.message).toContain('file list:');
    expect(res?.message).toContain('/a/b.ts');
  });

  it('"cache" reports hit ratio, savings, mechanism, and per-provider split', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx({
      provider: { id: 'openai', capabilities: { cacheControl: 'auto' } },
      tokenCounter: {
        cacheStats: () => ({
          readTokens: 20_000,
          writeTokens: 1_000,
          hitRatio: 0.5,
          savedUsd: 0.42,
        }),
      },
      meta: {
        providerCacheLedger: {
          perProvider: () => [
            { provider: 'openai', cacheRead: 15_000, cacheWrite: 800, hitRatio: 0.6 },
            { provider: 'anthropic', cacheRead: 5_000, cacheWrite: 200, hitRatio: 0.3 },
          ],
        },
      },
    });
    const res = await cmd.run('cache', ctx);
    expect(res?.message).toContain('Prompt Cache Report');
    expect(res?.message).toContain('hit ratio: 50.0%');
    expect(res?.message).toContain('saved:     ~$0.42');
    expect(res?.message).toContain('prompt_cache_key routing');
    expect(res?.message).toContain('openai');
    expect(res?.message).toContain('anthropic');
  });

  it('"cache" reports the Gemini mechanism from the provider id', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx({
      provider: { id: 'google', capabilities: { cacheControl: 'none' } },
      tokenCounter: {
        cacheStats: () => ({ readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 }),
      },
    });
    const res = await cmd.run('cache', ctx);
    expect(res?.message).toContain('cachedContents');
    expect(res?.message).toContain('No cached tokens yet');
  });

  it('"mode" lists all context modes', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx();
    const res = await cmd.run('mode', ctx);
    expect(res?.message).toContain('Context Window Modes');
  });

  it('"modes" alias also lists modes', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const res = await cmd.run('modes', fakeCtx());
    expect(res?.message).toContain('Context Window Modes');
  });

  it('"mode <unknown>" reports unknown mode', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const res = await cmd.run('mode bogus-mode', fakeCtx());
    expect(res?.message).toContain('Unknown context mode');
  });

  it('"mode <valid>" switches the context window mode and stores policy on meta', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx();
    const res = await cmd.run('mode balanced', ctx);
    expect(res?.message).toContain('Context mode set');
    expect(ctx.meta['contextWindowMode']).toBe('balanced');
    expect(ctx.meta['contextWindowPolicy']).toBeDefined();
  });

  it('readPolicy round-trips: after `mode <id>`, default summary shows that mode name', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx();
    await cmd.run('mode frugal', ctx);
    const res = await cmd.run('', ctx);
    expect(res?.message).toContain('frugal');
  });

  it('sets the effective context limit for the current session', async () => {
    const renderer = fakeRenderer();
    let liveLimit = 0;
    const cmd = buildContextCommand({
      renderer,
      onContextLimit: vi.fn((tokens?: number) => {
        if (tokens !== undefined) liveLimit = tokens;
        return liveLimit;
      }),
    } as never);
    const ctx = fakeCtx();
    const res = await cmd.run('limit 220k', ctx);
    expect(res?.message).toMatch(/220[,.]000/);
    expect(ctx.meta['effectiveMaxContext']).toBe(220_000);
    expect(liveLimit).toBe(220_000);
  });

  it('persists the effective context limit when --persist is used', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-context-'));
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ version: 1, context: { mode: 'balanced' } }));
    const configStore = new DefaultConfigStore({
      version: 1,
      provider: 'openai',
      model: 'gpt-test',
      context: {
        mode: 'balanced',
        warnThreshold: 0.6,
        softThreshold: 0.75,
        hardThreshold: 0.9,
        autoCompact: true,
        preserveK: 10,
        eliseThreshold: 2000,
      },
      tools: {
        defaultExecutionStrategy: 'smart',
        maxIterations: 100,
        iterationTimeoutMs: 300_000,
        sessionTimeoutMs: 1_800_000,
        perIterationOutputCapBytes: 100_000,
      },
      log: { level: 'info' },
      features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    } as never);
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({
      renderer,
      paths: { globalConfig: configPath, profileConfig: () => configPath },
      configStore,
      onContextLimit: vi.fn((tokens?: number) => tokens ?? 0),
    } as never);

    const res = await cmd.run('limit 220k --persist', fakeCtx());
    expect(res?.message).toContain('persisted');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(persisted.context.effectiveMaxContext).toBe(220_000);
    expect(configStore.get().context.effectiveMaxContext).toBe(220_000);
  });

  it('sets custom context compaction thresholds for the current session', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx();
    const res = await cmd.run('thresholds 50% 70% 85%', ctx);
    expect(res?.message).toContain('Context thresholds set');
    expect(ctx.meta['contextWindowPolicy']).toMatchObject({
      thresholds: { warn: 0.5, soft: 0.7, hard: 0.85 },
    });
  });

  it('rejects invalid threshold ordering', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const res = await cmd.run('thresholds 80% 70% 90%', fakeCtx());
    expect(res?.message).toContain('warn < soft < hard');
  });

  it('"repair" reports no orphans when messages are well-formed', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    const res = await cmd.run('repair', ctx);
    expect(res?.message).toContain('no orphan');
  });

  it('"repair" reports counts when an orphan tool_use is removed', async () => {
    const renderer = fakeRenderer();
    const cmd = buildContextCommand({ renderer } as never);
    const ctx = fakeCtx({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'going' },
            { type: 'tool_use', id: 't1', name: 'read', input: {} },
          ],
        },
      ],
    });
    const res = await cmd.run('repair', ctx);
    expect(res?.message).toContain('Context repaired');
    expect(res?.message).toContain('tool_use');
    expect(ctx.state.replaceMessages).toHaveBeenCalled();
  });
});
