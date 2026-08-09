import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretScrubber, DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthMenuDeps, probeLocalLlm, runAuthLocal } from '../src/auth-menu/index.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * Health-probe behavior for `wstack auth local`.
 *
 * The probe hits `GET <baseUrl>/models` (the OpenAI-compatible models
 * endpoint that all three target servers implement). On any failure
 * the user is asked to confirm before saving.
 *
 * These tests focus on three things:
 *   1. The probe correctly classifies each kind of failure (ok,
 *      unreachable, timeout, http_error, invalid_response).
 *   2. The "save anyway?" prompt fires on a failed probe and honors
 *      a No answer.
 *   3. Every log line that could echo a Bearer token is run through
 *      the SecretScrubber before reaching the renderer.
 */

// --- Test helpers ----------------------------------------------------------

async function mkTempDir(prefix = 'wstack-auth-local-probe-'): Promise<string> {
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
  secretScrubber?: DefaultSecretScrubber;
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
    ...(opts.secretScrubber ? { secretScrubber: opts.secretScrubber } : {}),
  };
  return { deps, configPath, tmpDir };
}

/**
 * Build a mock fetch that returns canned responses keyed by URL
 * substring. Default response is the OpenAI-format `/v1/models`
 * shape so most tests get `ok` by default.
 */
function buildFetch(responder: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return responder(url);
  }) as never as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Extract the captured text from `renderer.write` mock calls. */
function capturedWrite(deps: AuthMenuDeps): string {
  return (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .join('');
}

// --- probeLocalLlm unit tests ---------------------------------------------

describe('probeLocalLlm', () => {
  const baseScrubber = new DefaultSecretScrubber();

  it('returns ok with modelCount when the server returns the OpenAI shape', async () => {
    const fetchImpl = buildFetch(() =>
      jsonResponse({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }),
    );
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(result.status).toBe('ok');
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(3);
    expect(result.httpStatus).toBe(200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts the Ollama-native `models` array (also returned on /v1/models)', async () => {
    const fetchImpl = buildFetch(() =>
      jsonResponse({ models: [{ name: 'llama3:8b' }, { name: 'qwen2.5:7b' }] }),
    );
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(result.status).toBe('ok');
    expect(result.modelCount).toBe(2);
  });

  it('appends /models when the base URL is the chat completions endpoint', async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = buildFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ data: [] });
    });
    await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(capturedUrl).toBe('http://localhost:11434/v1/models');
  });

  it('does not double-append /models when the base URL already ends in /models', async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = buildFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ data: [] });
    });
    await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1/models',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(capturedUrl).toBe('http://localhost:11434/v1/models');
  });

  it('omits the Authorization header for noAuth presets (Ollama)', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_input: unknown, init: { headers: unknown } | undefined) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers as never).entries());
      return jsonResponse({ data: [] });
    }) as never as typeof fetch;
    await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'should-be-ignored',
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(capturedHeaders['authorization']).toBeUndefined();
  });

  it('sends a Bearer header for vLLM / LM Studio when a key is provided', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_input: unknown, init: { headers: unknown } | undefined) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers as never).entries());
      return jsonResponse({ data: [] });
    }) as never as typeof fetch;
    await probeLocalLlm({
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'sk-local-vllm-abc',
      noAuth: false,
      presetLabel: 'vLLM',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(capturedHeaders['authorization']).toBe('Bearer sk-local-vllm-abc');
  });

  it('omits the Authorization header when noAuth is false but the key is empty', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (_input: unknown, init: { headers: unknown } | undefined) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers as never).entries());
      return jsonResponse({ data: [] });
    }) as never as typeof fetch;
    await probeLocalLlm({
      baseUrl: 'http://localhost:8000/v1',
      apiKey: '',
      noAuth: false,
      presetLabel: 'vLLM',
      scrubber: baseScrubber,
      fetchImpl,
    });
    // No key + auth not strictly required → no header (avoids
    // accidentally sending "Bearer " with an empty value).
    expect(capturedHeaders['authorization']).toBeUndefined();
  });

  it('classifies a network error as unreachable', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:11434');
    }) as never as typeof fetch;
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(result.status).toBe('unreachable');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('classifies a timeout as timeout', async () => {
    // Simulate the AbortSignal.timeout path by throwing a TimeoutError
    // — the AbortController.timeout() in Node 22+ raises `TimeoutError`
    // with `name === 'TimeoutError'`.
    const fetchImpl = (async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }) as never as typeof fetch;
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
      timeoutMs: 50,
    });
    expect(result.status).toBe('timeout');
    expect(result.detail).toContain('50');
  });

  it('classifies a non-2xx response as http_error', async () => {
    const fetchImpl = buildFetch(() => new Response('forbidden', { status: 403 }));
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'sk-local',
      noAuth: false,
      presetLabel: 'vLLM',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(result.status).toBe('http_error');
    expect(result.httpStatus).toBe(403);
    expect(result.detail).toBe('forbidden');
  });

  it('classifies a JSON response with neither `data` nor `models` as invalid_response', async () => {
    const fetchImpl = buildFetch(() => jsonResponse({ weird: 'shape' }));
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(result.status).toBe('invalid_response');
  });

  it('classifies a non-JSON response as invalid_response', async () => {
    const fetchImpl = buildFetch(() => new Response('<html>not json</html>', { status: 200 }));
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: undefined,
      noAuth: true,
      presetLabel: 'Ollama',
      scrubber: baseScrubber,
      fetchImpl,
    });
    expect(result.status).toBe('invalid_response');
  });

  it('scrubs the Bearer token out of an error-page body before reporting', async () => {
    // A misconfigured proxy might echo the Authorization header in its
    // error body. The probe must scrub that before formatting the
    // http_error detail.
    const leakyBody = `Invalid request: Bearer sk-leaked-from-proxy-1234567890abcdef`;
    const fetchImpl = buildFetch(() => new Response(leakyBody, { status: 500 }));
    const result = await probeLocalLlm({
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'sk-leaked-from-proxy-1234567890abcdef',
      noAuth: false,
      presetLabel: 'vLLM',
      scrubber: new DefaultSecretScrubber(),
      fetchImpl,
    });
    expect(result.status).toBe('http_error');
    expect(result.detail).toBeDefined();
    expect(result.detail).not.toContain('sk-leaked-from-proxy-1234567890abcdef');
    expect(result.detail).toContain('[REDACTED:');
  });
});

// --- runAuthLocal probe integration ---------------------------------------

describe('runAuthLocal — health probe integration', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('saves the provider without prompting when the probe succeeds', async () => {
    globalThis.fetch = buildFetch(() =>
      jsonResponse({ data: [{ id: 'llama3.1:8b' }] }),
    ) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect(saved['ollama']).toBeDefined();
    // The renderer was told the probe passed.
    expect(capturedWrite(deps)).toContain('health probe ok');
  });

  it('auto-saves a keyless gateway (Ollama) on a failed probe without the "Save anyway?" prompt', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:11434');
    }) as typeof fetch;
    // No prompt lines supplied: a keyless (noAuth) preset must save on a
    // failed probe without asking, so readLine is never reached.
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect(saved['ollama']).toBeDefined();
    expect(capturedWrite(deps)).toContain('unreachable');
    // The "Save anyway?" prompt must NOT have been shown.
    expect(deps.reader.readLine).not.toHaveBeenCalled();
    expect(capturedWrite(deps)).not.toContain('Save anyway');
  });

  it('auto-saves OmniRoute (keyless gateway) on a failed probe without prompting', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:20128');
    }) as typeof fetch;
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'omniroute' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect(saved['omniroute']).toBeDefined();
    expect((saved['omniroute'] as { baseUrl: string }).baseUrl).toBe('http://localhost:20128/v1');
    expect(deps.reader.readLine).not.toHaveBeenCalled();
  });

  it('prompts "Save anyway?" and cancels on `n` (default) when the server is unreachable', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8000');
    }) as typeof fetch;
    // Empty answer → default N → don't save
    const { deps, tmpDir } = await setupDeps({ lines: [''], secrets: [''] });
    const code = await runAuthLocal(deps, { name: 'vllm' });
    expect(code).toBe(0);
    // No config file written
    const configPath = path.join(tmpDir, 'config.json');
    await expect(fs.access(configPath)).rejects.toThrow();
    expect(capturedWrite(deps)).toContain('Cancelled');
  });

  it('saves on `yes` (long form) when the probe fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const { deps, configPath } = await setupDeps({ lines: ['yes'], secrets: [''] });
    const code = await runAuthLocal(deps, { name: 'vllm' });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect(saved['vllm']).toBeDefined();
  });

  it('does not call fetch when --no-probe is set (scripting path)', async () => {
    const fetchImpl = vi.fn();
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, {
      name: 'ollama',
      noProbe: true,
      fetchImpl: fetchImpl as never as typeof fetch,
    });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    const saved = await readSaved(configPath);
    expect(saved['ollama']).toBeDefined();
  });

  it('does not save and reports the probe result when --probe-only is set', async () => {
    globalThis.fetch = buildFetch(() => jsonResponse({ data: [{ id: 'm1' }] })) as typeof fetch;
    const { deps, tmpDir } = await setupDeps({});
    const code = await runAuthLocal(deps, {
      name: 'ollama',
      probeOnly: true,
    });
    expect(code).toBe(0);
    // Nothing was saved → no config file.
    const configPath = path.join(tmpDir, 'config.json');
    await expect(fs.access(configPath)).rejects.toThrow();
    expect(capturedWrite(deps)).toContain('health probe ok');
  });

  it('uses the configured secretScrubber to redact any echoed key in the probe detail', async () => {
    const scrubSpy = vi.spyOn(DefaultSecretScrubber.prototype, 'scrub');
    globalThis.fetch = buildFetch(
      () =>
        new Response('invalid: Bearer sk-very-secret-key-1234567890abc', {
          status: 500,
        }),
    ) as typeof fetch;

    // Empty secret = skip the vLLM key prompt so the probe runs.
    const { deps } = await setupDeps({ lines: ['n'], secrets: [''] });
    // Explicit scrubber so the spy attaches to *our* instance.
    const myScrubber = new DefaultSecretScrubber();
    const spy = vi.spyOn(myScrubber, 'scrub');
    deps.secretScrubber = myScrubber;

    await runAuthLocal(deps, { name: 'vllm' });

    // The error body, which contains the Bearer token, must have been
    // scrubbed before reaching the renderer.
    expect(spy).toHaveBeenCalled();
    const allCalls = scrubSpy.mock.calls.flat();
    const everCalledWithBearer = allCalls.some(
      (arg) => typeof arg === 'string' && arg.includes('sk-very-secret-key-1234567890abc'),
    );
    // Some scrubber invocation had the raw token → prove it was passed
    // through (this is the input that *needs* redacting).
    expect(everCalledWithBearer).toBe(true);
    // And nothing reached the renderer with the raw token in it.
    expect(capturedWrite(deps)).not.toContain('sk-very-secret-key-1234567890abc');
  });
});

async function readSaved(configPath: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.providers as Record<string, unknown>;
}
