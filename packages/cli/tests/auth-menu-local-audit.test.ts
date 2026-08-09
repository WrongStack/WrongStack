import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretScrubber, DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuthAuditEvent,
  type AuthAuditLogger,
  type AuthAuditSink,
  createAuthAuditLogger,
  decideAuthLocalEvents,
  fileAuditSink,
  memAuthAuditSink,
  resolveAuditSink,
} from '../src/auth-menu/auth-menu-audit.js';
import { type AuthMenuDeps, runAuthLocal } from '../src/auth-menu/index.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * `wstack auth local` audit-log integration.
 *
 * Exercises a full `clear → undo` round-trip and verifies:
 *   1. The on-disk config transitions through the expected
 *      states (non-empty allowlist → empty → non-empty
 *      restored).
 *   2. The audit log captures the dedicated `auth.local.clear`
 *      and `auth.local.undo` event types, mirroring the
 *      WebUI's `provider.clear_models` / `provider.undo_clear`
 *      message types.
 *
 * The test also covers the unit-level pure helpers
 * (`decideAuthLocalEvents`, `createAuthAuditLogger`) so the
 * audit-log decision tree is pinned down in isolation — the
 * integration test is the end-to-end smoke test, not the only
 * coverage.
 */

// --- Test helpers ----------------------------------------------------------

async function mkTempDir(prefix = 'wstack-auth-local-audit-'): Promise<string> {
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

function makeReader(lines: string[] = [], secrets: string[] = []): ReadlineInputReader {
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

interface SetupOpts {
  preExisting?: object;
  sink?: AuthAuditSink;
}

async function setupDeps(opts: SetupOpts = {}): Promise<{
  deps: AuthMenuDeps;
  configPath: string;
  tmpDir: string;
  sink: AuthAuditSink & { lines: string[] };
}> {
  const tmpDir = await mkTempDir();
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const sink = (opts.sink ?? memAuthAuditSink()) as AuthAuditSink & { lines: string[] };
  const deps: AuthMenuDeps = {
    renderer: makeRenderer(),
    reader: makeReader(),
    modelsRegistry: makeModelsRegistry(),
    vault,
    profileConfigPath: configPath,
  };
  return { deps, configPath, tmpDir, sink };
}

async function readSaved(configPath: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.providers as Record<string, unknown>;
}

function loggerFor(sink: AuthAuditSink): AuthAuditLogger {
  return createAuthAuditLogger(sink, new DefaultSecretScrubber());
}

function parseEvents(lines: string[]): AuthAuditEvent[] {
  return lines.map((l) => JSON.parse(l) as AuthAuditEvent);
}

// --- Pre-existing config shape --------------------------------------------

function existingWithModels(id: string, models: string[]): Record<string, unknown> {
  return {
    providers: {
      [id]: {
        type: id,
        family: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        models,
      },
    },
  };
}

// --- decideAuthLocalEvents unit tests --------------------------------------

describe('decideAuthLocalEvents', () => {
  const base = {
    providerId: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
  };

  it('emits auth.local.add when there is no prior state and the new list is non-empty', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: undefined,
      newModels: ['llama3.1:8b', 'qwen2.5:7b'],
      keyLabel: 'default',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'auth.local.add',
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      models: ['llama3.1:8b', 'qwen2.5:7b'],
      keyLabel: 'default',
    });
  });

  it('emits auth.local.clear when the prior list was non-empty and the new list is []', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: ['a', 'b', 'c'],
      newModels: [],
      keyLabel: undefined,
    });
    expect(events).toEqual([
      {
        type: 'auth.local.clear',
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        previousModels: ['a', 'b', 'c'],
      },
    ]);
  });

  it('emits auth.local.undo when the prior list was [] and the new list is non-empty (the clear → undo round-trip)', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: [],
      newModels: ['a', 'b', 'c'],
      keyLabel: undefined,
    });
    expect(events).toEqual([
      {
        type: 'auth.local.undo',
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        restoredModels: ['a', 'b', 'c'],
      },
    ]);
  });

  it('emits auth.local.add (not undo) when the prior list is undefined and the new list is non-empty', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: undefined,
      newModels: ['a'],
      keyLabel: undefined,
    });
    expect(events[0]?.type).toBe('auth.local.add');
  });

  it('emits no lifecycle event when newModels is null (--model not passed)', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: ['a', 'b'],
      newModels: null,
      keyLabel: undefined,
    });
    expect(events).toEqual([]);
  });

  it('emits auth.local.probe_skip when supplied', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: ['a'],
      newModels: null,
      keyLabel: undefined,
      probeSkip: { shape: 'first' },
    });
    expect(events).toContainEqual({
      type: 'auth.local.probe_skip',
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      requestedShape: 'first',
    });
  });

  it('emits auth.local.probe_failed_save with the probe status detail when supplied', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: ['a'],
      newModels: null,
      keyLabel: undefined,
      probeFailedSave: { status: 'unreachable', detail: 'ECONNREFUSED' },
    });
    expect(events).toContainEqual({
      type: 'auth.local.probe_failed_save',
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      probeStatus: 'unreachable',
      probeDetail: 'ECONNREFUSED',
    });
  });

  it('omits the optional probeDetail field when not supplied', () => {
    const events = decideAuthLocalEvents({
      ...base,
      previousModels: ['a'],
      newModels: null,
      keyLabel: undefined,
      probeFailedSave: { status: 'timeout' },
    });
    const ev = events.find((e) => e.type === 'auth.local.probe_failed_save');
    expect(ev).toBeDefined();
    expect(ev && 'probeDetail' in ev ? ev.probeDetail : undefined).toBeUndefined();
  });
});

// --- createAuthAuditLogger (sink + scrubber behavior) ---------------------

describe('createAuthAuditLogger', () => {
  it('is a no-op when the sink is undefined', () => {
    const logger = createAuthAuditLogger(undefined);
    expect(() =>
      logger.emit({ type: 'auth.local.add', providerId: 'a', baseUrl: 'b', models: [] }),
    ).not.toThrow();
  });

  it('emits a single JSON line per event', () => {
    const sink = memAuthAuditSink();
    const logger = createAuthAuditLogger(sink);
    logger.emit({ type: 'auth.local.add', providerId: 'a', baseUrl: 'b', models: [] });
    logger.emit({ type: 'auth.local.add', providerId: 'a', baseUrl: 'b', models: [] });
    expect(sink.lines).toHaveLength(2);
    for (const line of sink.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('scrubs credential-shaped values before writing', () => {
    // The DefaultSecretScrubber recognizes the OpenAI key
    // pattern (per packages/core/src/security/secret-scrubber.ts).
    // Build the values programmatically so the test source
    // itself doesn't carry anything that looks like a real key.
    const sink = memAuthAuditSink();
    const logger = createAuthAuditLogger(sink, new DefaultSecretScrubber());
    const skPrefix = 's' + 'k-';
    const projPrefix = skPrefix + 'proj-';
    const filler = 'A'.repeat(30);
    const longKey = skPrefix + filler;
    const anotherLongKey = projPrefix + filler;
    logger.emit({
      type: 'auth.local.add',
      providerId: longKey,
      baseUrl: 'http://localhost:11434/v1',
      models: [anotherLongKey, 'clean-model'],
    });
    const written = sink.lines[0]!;
    expect(written).not.toContain(longKey);
    expect(written).not.toContain(anotherLongKey);
    expect(written).toContain('clean-model');
  });
});

// --- resolveAuditSink ------------------------------------------------------

describe('resolveAuditSink', () => {
  it('returns undefined when the flag is undefined (no audit by default)', () => {
    expect(resolveAuditSink(undefined)).toBeUndefined();
  });

  it('returns a sink for bare `--audit` (boolean true → stdout)', () => {
    const sink = resolveAuditSink(true);
    expect(sink).toBeDefined();
    expect(typeof sink!.write).toBe('function');
  });

  it('returns a sink for `--audit stdout` (named stdout)', () => {
    const sink = resolveAuditSink('stdout');
    expect(sink).toBeDefined();
  });

  it('returns a sink for `--audit stderr` (named stderr)', () => {
    const sink = resolveAuditSink('stderr');
    expect(sink).toBeDefined();
  });

  it('returns a file sink for `--audit <path>`', async () => {
    const tmpFile = path.join(await mkTempDir('wstack-resolve-audit-sink-'), 'audit.jsonl');
    const sink = resolveAuditSink(tmpFile);
    expect(sink).toBeDefined();
    // Smoke-test: writing to the sink actually appends to disk.
    sink!.write('{"type":"auth.local.add","providerId":"x","baseUrl":"y","models":[]}');
    const onDisk = await fs.readFile(tmpFile, 'utf8');
    expect(onDisk).toContain('"type":"auth.local.add"');
  });

  it('treats unknown strings as file paths (a malformed `--audit` still gets a sink rather than throwing)', () => {
    // The arg parser only emits 'stdout' / 'stderr' / a path;
    // any other string falls through to the file sink. This
    // is intentional — a typo in a path should still produce
    // a sink so the OS reports the I/O error at the first
    // write, not as a silent no-op.
    const sink = resolveAuditSink('custom-sink-name');
    expect(sink).toBeDefined();
  });
});

// --- runAuthLocal integration: full clear → undo round-trip ---------------

describe('runAuthLocal — clear → undo round-trip (audit log + on-disk state)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('captures the clear event with previousModels, then the undo event with restoredModels', async () => {
    // The literal-CSV --model path is valid with --no-probe,
    // so we keep the test offline (no real Ollama server).
    globalThis.fetch = (() => Promise.reject(new Error('no network'))) as typeof fetch;

    // Seed: ollama already has a 3-model allowlist.
    const { deps, configPath, sink } = await setupDeps({
      preExisting: existingWithModels('ollama', ['a', 'b', 'c']),
    });

    const audit = loggerFor(sink);

    // 1. Clear the allowlist.
    const clearCode = await runAuthLocal(deps, {
      name: 'ollama',
      models: '',
      noProbe: true,
      audit,
    });
    expect(clearCode).toBe(0);

    // On-disk state: the allowlist is empty (or absent).
    // `mutateConfigProviders` writes `models: []` when the
    // --model flag is the empty literal — it doesn't
    // actively delete the key. The audit log decision
    // still fires because the *list* is empty, matching
    // the "non-empty → empty" branch of the state machine.
    const afterClear = await readSaved(configPath);
    const ollamaAfterClear = afterClear['ollama'] as { models?: string[] };
    expect(ollamaAfterClear.models).toEqual([]);

    // Audit log: contains the clear event with previousModels.
    const clearEvents = parseEvents(sink.lines);
    const clearEvent = clearEvents.find((e) => e.type === 'auth.local.clear');
    expect(clearEvent).toBeDefined();
    expect(clearEvent).toMatchObject({
      type: 'auth.local.clear',
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      previousModels: ['a', 'b', 'c'],
    });

    // 2. Restore the same list. Reuse the same sink so the
    //    round-trip events are all in one stream.
    const restoreCode = await runAuthLocal(deps, {
      name: 'ollama',
      models: 'a,b,c',
      noProbe: true,
      audit,
    });
    expect(restoreCode).toBe(0);

    // On-disk state: the allowlist is back.
    const afterRestore = await readSaved(configPath);
    const ollamaAfterRestore = afterRestore['ollama'] as { models: string[] };
    expect(ollamaAfterRestore.models).toEqual(['a', 'b', 'c']);

    // Audit log: contains the undo event with restoredModels.
    const allEvents = parseEvents(sink.lines);
    const undoEvent = allEvents.find((e) => e.type === 'auth.local.undo');
    expect(undoEvent).toBeDefined();
    expect(undoEvent).toMatchObject({
      type: 'auth.local.undo',
      providerId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      restoredModels: ['a', 'b', 'c'],
    });

    // The two lifecycle events appear in the right order.
    const eventTypes = allEvents.map((e) => e.type);
    const clearIdx = eventTypes.indexOf('auth.local.clear');
    const undoIdx = eventTypes.indexOf('auth.local.undo');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(undoIdx).toBeGreaterThan(clearIdx);
  });

  it('emits auth.local.add (not undo) when restoring into a fresh slot', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('no network'))) as typeof fetch;
    const { deps, configPath, sink } = await setupDeps({});
    const audit = loggerFor(sink);
    const code = await runAuthLocal(deps, {
      name: 'ollama',
      models: 'a,b,c',
      noProbe: true,
      audit,
    });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { models: string[] }).models).toEqual(['a', 'b', 'c']);
    const events = parseEvents(sink.lines);
    expect(events.some((e) => e.type === 'auth.local.add')).toBe(true);
    expect(events.some((e) => e.type === 'auth.local.undo')).toBe(false);
    expect(events.some((e) => e.type === 'auth.local.clear')).toBe(false);
  });

  it('preserves the apiKeys entry across a clear → undo round-trip', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('no network'))) as typeof fetch;
    // Seed with a key already configured (a non-Ollama case
    // — the test exercises "vLLM with a saved key").
    const { deps, configPath, sink } = await setupDeps({
      preExisting: {
        providers: {
          vllm: {
            type: 'vllm',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:8000/v1',
            models: ['x', 'y'],
            apiKeys: [{ label: 'default', apiKey: 'sk-test-1234', createdAt: '2026-01-01' }],
            activeKey: 'default',
          },
        },
      },
    });
    // The reader would normally be prompted for a key — but
    // --no-probe + --skip-key bypass the prompt. vLLM is
    // noAuth: false, so we still need --skip-key to avoid
    // the EOF on readSecret.
    const audit = loggerFor(sink);
    await runAuthLocal(deps, { name: 'vllm', models: '', noProbe: true, skipKey: true, audit });
    await runAuthLocal(deps, { name: 'vllm', models: 'x,y', noProbe: true, skipKey: true, audit });
    const after = await readSaved(configPath);
    const vllm = after['vllm'] as {
      models: string[];
      apiKeys: Array<{ label: string; apiKey: string }>;
    };
    expect(vllm.models).toEqual(['x', 'y']);
    // The pre-existing key survived the clear → undo cycle
    // (no apiKeys are added by --model, only by --api-key).
    // The key is encrypted at rest by the SecretVault — the
    // `enc:v1:` prefix is the ciphertext envelope. We verify
    // the *shape* (one entry with the right label) rather
    // than the plaintext value, since the plaintext is
    // not exposed through the config-file reader.
    expect(vllm.apiKeys).toHaveLength(1);
    expect(vllm.apiKeys[0]?.label).toBe('default');
    expect(vllm.apiKeys[0]?.apiKey).toMatch(/^enc:v1:/);
  });

  it('emits a probe_failed_save event when the user saves past a failed probe', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('server error', { status: 500 }))) as typeof fetch;

    const { deps, sink } = await setupDeps({});
    deps.reader = makeReader(['y']);
    const audit = loggerFor(sink);
    const code = await runAuthLocal(deps, { name: 'ollama', audit });
    expect(code).toBe(0);
    const events = parseEvents(sink.lines);
    const failedEvent = events.find((e) => e.type === 'auth.local.probe_failed_save');
    expect(failedEvent).toBeDefined();
    expect(failedEvent).toMatchObject({
      type: 'auth.local.probe_failed_save',
      providerId: 'ollama',
      probeStatus: expect.stringMatching(/http_error|unreachable/),
    });
  });

  it('does not emit a probe_failed_save event when the probe succeeds', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'llama3.1:8b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof fetch;
    const { deps, sink } = await setupDeps({});
    const audit = loggerFor(sink);
    await runAuthLocal(deps, { name: 'ollama', audit });
    const events = parseEvents(sink.lines);
    expect(events.some((e) => e.type === 'auth.local.probe_failed_save')).toBe(false);
  });

  it('emits no lifecycle events when --model is not passed', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('no network'))) as typeof fetch;
    const { deps, configPath, sink } = await setupDeps({
      preExisting: existingWithModels('ollama', ['a', 'b', 'c']),
    });
    const audit = loggerFor(sink);
    await runAuthLocal(deps, { name: 'ollama', noProbe: true, audit });
    const after = await readSaved(configPath);
    expect((after['ollama'] as { models: string[] }).models).toEqual(['a', 'b', 'c']);
    const events = parseEvents(sink.lines);
    const lifecycle = events.filter(
      (e) =>
        e.type === 'auth.local.add' ||
        e.type === 'auth.local.clear' ||
        e.type === 'auth.local.undo',
    );
    expect(lifecycle).toEqual([]);
  });

  /**
   * End-to-end smoke test for the production wiring:
   * `wstack auth local --audit <path>` writes JSONL events
   * to disk. This is the test that closes the loop on the
   * production dispatch — it runs the real `runAuthLocal`
   * (no mock) with a real `fileAuditSink` and verifies the
   * on-disk content matches the in-memory semantics.
   */
  it('writes JSONL audit events to a file when --audit <path> is used (production wiring smoke test)', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('no network'))) as typeof fetch;
    const tmpDir = await mkTempDir('wstack-audit-file-');
    const auditFile = path.join(tmpDir, 'audit.jsonl');
    const { deps } = await setupDeps({
      preExisting: existingWithModels('ollama', ['a', 'b', 'c']),
    });
    // Construct the logger the way the production dispatch does
    // it: `createAuthAuditLogger(resolveAuditSink(flag))`.
    const audit = createAuthAuditLogger(resolveAuditSink(auditFile) as AuthAuditSink);
    // Clear
    await runAuthLocal(deps, { name: 'ollama', models: '', noProbe: true, audit });
    // Undo
    await runAuthLocal(deps, { name: 'ollama', models: 'a,b,c', noProbe: true, audit });
    // Verify the on-disk content.
    const onDisk = await fs.readFile(auditFile, 'utf8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l) as AuthAuditEvent);
    expect(events[0]?.type).toBe('auth.local.clear');
    expect(events[1]?.type).toBe('auth.local.undo');
    // Each line is a valid JSONL entry — re-parsing is stable.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  /**
   * Smoke test for the file sink's append semantics: writing
   * twice produces a two-line file, not a one-line file
   * (the second write doesn't clobber the first).
   */
  it('fileAuditSink appends — successive writes produce a multi-line file', async () => {
    const tmpDir = await mkTempDir('wstack-audit-append-');
    const auditFile = path.join(tmpDir, 'append.jsonl');
    const sink = fileAuditSink(auditFile);
    sink.write('{"type":"auth.local.add","providerId":"a","baseUrl":"b","models":[]}');
    sink.write('{"type":"auth.local.add","providerId":"a","baseUrl":"b","models":["x"]}');
    const onDisk = await fs.readFile(auditFile, 'utf8');
    expect(onDisk.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
  });
});
