import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretScrubber, DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthMenuDeps,
  type ProbeResult,
  resolveModelList,
  runAuthLocal,
} from '../src/auth-menu/index.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * `--model` flag behavior for `wstack auth local`.
 *
 * The flag has four shapes, all resolved by `resolveModelList`:
 *   - omitted       → don't touch `cfg.models`
 *   - `'first'`     → take just the first probe id
 *   - `<positive N>`→ take the first N probe ids
 *   - `'<csv>'`     → literal list, ignore the probe
 *   - `''`          → explicit clear (write empty list)
 *
 * The integration tests cover the full flow: probe → resolver →
 * save → load. The unit tests on `resolveModelList` cover edge cases
 * in isolation.
 */

// --- Test helpers ----------------------------------------------------------

async function mkTempDir(prefix = 'wstack-auth-local-models-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
}

function makeReader(lines: string[], secrets: string[] = []): ReadlineInputReader {
  let li = 0;
  let si = 0;
  return {
    readLine: vi.fn(async () => {
      if (li >= lines.length) throw new Error('EOF');
      return lines[li++] ?? '';
    }),
    readSecret: vi.fn(async () => {
      if (si >= secrets.length) throw new Error('EOF (secret)');
      return secrets[si++] ?? '';
    }),
    close: vi.fn(async () => {}),
  } as never as ReadlineInputReader;
}

function makeModelsRegistry(): ModelsRegistry {
  return {
    getProvider: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => []),
    suggestModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as never as ModelsRegistry;
}

async function setupDeps(opts: {
  lines?: string[];
  secrets?: string[];
  preExisting?: object;
}): Promise<{ deps: AuthMenuDeps; configPath: string; tmpDir: string }> {
  const tmpDir = await mkTempDir();
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const deps: AuthMenuDeps = {
    renderer: makeRenderer(),
    reader: makeReader(opts.lines ?? [], opts.secrets ?? []),
    modelsRegistry: makeModelsRegistry(),
    vault,
    profileConfigPath: configPath,
  };
  return { deps, configPath, tmpDir };
}

async function readSaved(configPath: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.providers as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildFetch(responder: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return responder(url);
  }) as never as typeof fetch;
}

function capturedWrite(deps: AuthMenuDeps): string {
  return (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .join('');
}

/** Build a fake successful probe result with the given model ids. */
function okProbe(modelIds: string[]): ProbeResult {
  return {
    ok: true,
    status: 'ok',
    httpStatus: 200,
    elapsedMs: 42,
    modelCount: modelIds.length,
    modelIds,
  };
}

/** Build a fake failed probe result (network error). */
function unreachableProbe(): ProbeResult {
  return { ok: false, status: 'unreachable', elapsedMs: 100, detail: 'ECONNREFUSED' };
}

// --- resolveModelList unit tests ------------------------------------------

describe('resolveModelList', () => {
  const scrubber = new DefaultSecretScrubber();

  describe('omitted (undefined)', () => {
    it('returns null — caller should not touch cfg.models', () => {
      expect(resolveModelList(undefined, okProbe(['m1', 'm2']), scrubber)).toBeNull();
      expect(resolveModelList(undefined, undefined, scrubber)).toBeNull();
    });
  });

  describe("'first' shape", () => {
    it('returns the first probe id', () => {
      expect(resolveModelList('first', okProbe(['llama3:8b', 'qwen2.5:7b']), scrubber)).toEqual([
        'llama3:8b',
      ]);
    });

    it('returns null when the probe failed (no fallback to literal — `first` is unambiguous)', () => {
      expect(resolveModelList('first', unreachableProbe(), scrubber)).toBeNull();
    });

    it('returns null when the probe succeeded but returned an empty list', () => {
      expect(resolveModelList('first', okProbe([]), scrubber)).toBeNull();
    });
  });

  describe("'<N>' shape (positive integer)", () => {
    it('returns the first N probe ids', () => {
      expect(resolveModelList('3', okProbe(['a', 'b', 'c', 'd', 'e']), scrubber)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('caps at the available list size when N is larger', () => {
      expect(resolveModelList('100', okProbe(['x', 'y']), scrubber)).toEqual(['x', 'y']);
    });

    it('returns null when the probe failed (N is not a literal list)', () => {
      expect(resolveModelList('5', unreachableProbe(), scrubber)).toBeNull();
    });
  });

  describe("'<csv>' shape (literal list)", () => {
    it('splits, trims, and deduplicates', () => {
      expect(
        resolveModelList('llama3:8b, qwen2.5:7b ,llama3:8b,mistral:7b', undefined, scrubber),
      ).toEqual(['llama3:8b', 'qwen2.5:7b', 'mistral:7b']);
    });

    it('returns the literal list even when the probe succeeded (user override wins)', () => {
      expect(
        resolveModelList('custom-model', okProbe(['server-model-a', 'server-model-b']), scrubber),
      ).toEqual(['custom-model']);
    });

    it('drops empty entries from the literal list', () => {
      expect(resolveModelList('a,,b,  ,c', undefined, scrubber)).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty array for an empty literal (`--model ""` clears)', () => {
      expect(resolveModelList('', okProbe(['a']), scrubber)).toEqual([]);
      expect(resolveModelList('   ', okProbe(['a']), scrubber)).toEqual([]);
    });

    it('scrubs each entry through the SecretScrubber (defense-in-depth)', () => {
      const scrubSpy = vi.spyOn(scrubber, 'scrub');
      // A value that contains a recognizable credential pattern. The
      // scrubber should redact it; we just need the resolver to
      // call scrub on every entry.
      resolveModelList('sk-1234567890abcdef,clean-model', okProbe([]), scrubber);
      // The literal-list path calls scrub exactly once per entry.
      expect(scrubSpy).toHaveBeenCalled();
    });
  });
});

// --- runAuthLocal integration: --model + probe -----------------------------

describe('runAuthLocal — --model + probe integration', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('saves the first probe id when --model first is passed', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5:7b' }, { id: 'mistral:7b' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama', models: 'first' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual(['llama3.1:8b']);
  });

  it('saves the first N probe ids when --model N is passed', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama', models: '2' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual(['a', 'b']);
  });

  it('saves a literal csv when --model <csv> is passed (probe ignored)', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'server-default' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, {
      name: 'ollama',
      models: 'my-custom-model-a,my-custom-model-b',
    });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual([
      'my-custom-model-a',
      'my-custom-model-b',
    ]);
  });

  it("does not touch cfg.models when --model is omitted (probe's models are ignored)", async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'server-model' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models?: string[] }).models).toBeUndefined();
  });

  it('overwrites a pre-existing models list when --model is passed (explicit win)', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'new-server-model' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          ollama: {
            type: 'ollama',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            models: ['old-model-a', 'old-model-b'],
          },
        },
      },
    });
    const code = await runAuthLocal(deps, { name: 'ollama', models: 'first' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual(['new-server-model']);
  });

  it('preserves a pre-existing models list when --model is omitted', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'server-model' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          ollama: {
            type: 'ollama',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            models: ['old-model-a'],
          },
        },
      },
    });
    const code = await runAuthLocal(deps, { name: 'ollama' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual(['old-model-a']);
  });

  it("uses literal csv when --model is passed but the probe didn't run (--no-probe)", async () => {
    const fetchImpl = vi.fn();
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, {
      name: 'ollama',
      noProbe: true,
      models: 'llama3.1:8b,qwen2.5:7b',
      fetchImpl: fetchImpl as never as typeof fetch,
    });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
  });

  it('writes no models when --model first is passed but the probe failed (keyless preset auto-saves)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    // ollama is a keyless (noAuth) gateway: a failed probe auto-saves
    // without a "Save anyway?" prompt. `--model first` has no probe ids to
    // resolve, so cfg.models must NOT be written.
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama', models: 'first' });
    expect(code).toBe(0);
    // Provider saved, but with no models (probe gave nothing to resolve).
    const saved = await readSaved(configPath);
    expect(saved['ollama']).toBeDefined();
    expect((saved['ollama'] as { models?: string[] }).models).toBeUndefined();
    // No prompt was shown.
    expect(deps.reader.readLine).not.toHaveBeenCalled();
  });

  it('writes no models when --model 3 is passed but the probe failed (keyless preset auto-saves)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama', models: '3' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect(saved['ollama']).toBeDefined();
    expect((saved['ollama'] as { models?: string[] }).models).toBeUndefined();
    expect(deps.reader.readLine).not.toHaveBeenCalled();
  });

  it("clears an existing models list when --model '' (empty) is passed", async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'server-model' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          ollama: {
            type: 'ollama',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            models: ['old-model-a', 'old-model-b'],
          },
        },
      },
    });
    const code = await runAuthLocal(deps, { name: 'ollama', models: '' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual([]);
  });

  it('includes the picked model id in the Launch: hint after --model first', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1:8b' }] }),
    ) as typeof fetch;
    const { deps } = await setupDeps({});
    await runAuthLocal(deps, { name: 'ollama', models: 'first' });
    // The hint should mention the picked id (cyan-highlighted), not
    // the <model-id> placeholder.
    const allWrite = capturedWrite(deps);
    expect(allWrite).toContain('qwen2.5-coder:7b');
    expect(allWrite).toContain('wstack --provider ollama --model qwen2.5-coder:7b');
  });

  it('uses the <model-id> placeholder when --model was not passed', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'server-model' }] }),
    ) as typeof fetch;
    const { deps } = await setupDeps({});
    await runAuthLocal(deps, { name: 'ollama' });
    expect(capturedWrite(deps)).toContain('--model <model-id>');
  });
});
