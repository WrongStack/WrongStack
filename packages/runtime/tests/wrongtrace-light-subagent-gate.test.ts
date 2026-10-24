/**
 * Runtime-package light-subagent WrongTrace gate threading contract test.
 *
 * Mirrors packages/webui-server/tests/wrongtrace-webui-gate.test.ts: builds a
 * REAL core HookRegistry/HookRunner carrying the shared @wrongstack/wrongtrace
 * hook pair — the exact runner webui-server's backend-services hands into
 * `makeLightSubagentFactory` deps (`LightSubagentFactoryDeps.hookRunner`, which
 * the factory threads into every spawned subagent's ToolExecutor). We then
 * (a) prove the factory ACCEPTS the runner (a light subagent spawns cleanly
 * with it threaded), and (b) assert deny/allow/claim/release against the live
 * daemon through that same runner. Every lock assertion degrades gracefully
 * offline, so green proves the wiring contract, not daemon liveness — same
 * "green ≠ live" rule documented in docs/wrongtrace.md §8.
 */

import { resolve } from 'node:path';
import { Container, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, Provider, SessionWriter, Tool } from '@wrongstack/contracts/types';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import {
  createWrongTraceHookPair,
  getWrongTrace,
  resetWrongTraceGate,
} from '@wrongstack/wrongtrace';
import { afterAll, describe, expect, it } from 'vitest';
import { makeLightSubagentFactory } from '../src/index.js';

const PROBE = `__runtime_light_gate_probe_${Date.now()}__`;
// The hooks lock the file in the session's directory, not the relative name
// (a machine-wide daemon would otherwise share one lock across projects).
const PROBE_KEY = resolve(PROBE);
// The daemon lists an absolute path in its own canonical spelling (on Windows
// `d:/codebox/...`), so compare spellings, not strings.
const canonicalLockPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
const sameLockPath = (a: string, b: string) => canonicalLockPath(a) === canonicalLockPath(b);
const SESSION = 'runtime-light-subagent-gate-test';

/**
 * Probe `/api/health` once, at module load. The offline branches below used
 * to `return` quietly, so an offline run exited green and proved only the
 * fail-open contract — the lock paths were never exercised. Offline is now
 * reported as SKIPPED, which Vitest counts distinctly from passed, so green
 * always means the live deny/allow/claim/release paths actually ran.
 */
const DAEMON_UP = (await getWrongTrace()).isAvailable;
if (!DAEMON_UP) {
  console.warn(
    '[runtime-light-subagent-gate] daemon offline — live lock assertions are SKIPPED, not verified',
  );
}

/** WrongTrace-only runner identical to backend-services.ts → SDD-wizard deps. */
function buildSddStyleRunner(): HookRunner {
  const hooks = createWrongTraceHookPair(() => SESSION);
  const registry = new HookRegistry();
  registry.registerInProcess(
    'PreToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    hooks.preToolUse,
    'wrongtrace-gate',
  );
  registry.registerInProcess(
    'PostToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    hooks.postToolUse,
    'wrongtrace-gate',
  );
  return new HookRunner({ registry, sessionId: () => SESSION, allowNonPolicy: true });
}

// ── Light-subagent factory harness (mirrors light-subagent-factory.test.ts) ──

const noopProvider: Provider = {
  id: 'noop',
  capabilities: {
    streaming: false,
    tools: true,
    parallelTools: false,
    vision: false,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    reasoning: false,
    maxContext: 0,
    maxOutput: 0,
    cacheControl: 'none',
  },
  async complete() {
    return {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'noop',
    };
  },
  async *stream() {
    yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } };
  },
};

function providerFor(id: string): Provider {
  return {
    ...noopProvider,
    id,
    async complete() {
      return {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 0, output: 0 },
        model: id,
      };
    },
  };
}

const writeTool: Tool = {
  name: 'write',
  description: 'write',
  inputSchema: { type: 'object', properties: {} },
  permission: 'auto',
  mutating: true,
  capabilities: ['fs.write'],
  async execute() {
    return 'ok';
  },
};

function stubLogger(): unknown {
  const l: Record<string, unknown> = {};
  for (const m of ['debug', 'info', 'warn', 'error', 'trace', 'fatal']) l[m] = () => {};
  l.child = () => l;
  return l;
}

function sessionShim(): SessionWriter {
  return {
    id: 'parent',
    transcriptPath: '/tmp/parent.jsonl',
    traceId: 'parent-trace',
    get pendingToolUses() {
      return [];
    },
    append: async () => {},
    appendBatch: async () => {},
    flush: async () => {},
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  } satisfies SessionWriter;
}

function makeFactoryDeps(hookRunner: HookRunner) {
  const config = {
    version: 1,
    provider: 'noop',
    model: 'noop',
    providers: { noop: { type: 'noop' } },
    features: {},
    tools: {},
  } as never as Config;

  const container = new Container();
  container.bind(TOKENS.Logger, () => stubLogger() as never);
  container.bind(TOKENS.ConfigStore, () => new DefaultConfigStore(config));
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(
    TOKENS.TokenCounter,
    () =>
      ({
        count: () => 0,
        countMessages: () => 0,
        add: () => {},
        total: () => ({ input: 0, output: 0 }),
        estimateCost: () => ({ total: 0 }),
        reset: () => {},
      }) as never,
  );
  container.bind(
    TOKENS.SystemPromptBuilder,
    () =>
      ({
        build: async () => [{ type: 'text', text: 'system' }],
      }) as never,
  );
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register({
    type: 'noop',
    family: 'unsupported',
    create: () => providerFor('noop'),
  });

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(writeTool);

  return {
    container,
    providerRegistry,
    toolRegistry,
    session: sessionShim(),
    projectRoot: '/proj',
    // The contract under test: the SDD-wizard host threads its wrongtrace
    // runner into the factory, and the factory must accept it without
    // dropping it (every spawned ToolExecutor carries deps.hookRunner).
    hookRunner,
  };
}

afterAll(() => {
  resetWrongTraceGate();
});

// Daemon-independent wiring contract. Deliberately kept OUT of the skipIf
// describe below so it still runs — and still proves the threading contract —
// when the daemon is offline.
describe('runtime light-subagent factory threading (no daemon required)', () => {
  it('threads the hookRunner into a spawned light subagent', async () => {
    const runner = buildSddStyleRunner();
    const factory = makeLightSubagentFactory(makeFactoryDeps(runner));
    const built = await factory({ id: 'sdd-light', name: 'sdd-light', role: 'executor' });
    expect(built.agent).toBeDefined();
    expect(built.events).toBeDefined();
    // Mirror light-subagent-factory.test.ts isolation expectations — the
    // factory accepted the hookRunner, so construction succeeded with it.
  });
});

// Live-daemon contract — skipped (visibly) when the daemon is offline.
describe.skipIf(!DAEMON_UP)('runtime light-subagent WrongTrace gate (SDD-path)', () => {
  it('denies an edit while another owner holds the lock (through the runner)', async () => {
    const wt = await getWrongTrace();
    const runner = buildSddStyleRunner();
    const env = { cwd: process.cwd() };

    if (!wt.isAvailable) {
      const r = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
      expect(r.block).toBeFalsy(); // offline → allow
      return;
    }

    await wt.lockFile(PROBE_KEY, 'held by peer', { owner: 'peer-agent', ttlSeconds: 60 });
    try {
      const r = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
      expect(r.block).toBe(true);
      expect(r.reason).toContain('peer-agent');
      expect(r.reason).toContain('WrongTrace lock');
    } finally {
      await wt.unlockFile(PROBE_KEY);
    }
  });

  it('allows an unlocked edit, claims the lock, releases it post-tool', async () => {
    const wt = await getWrongTrace();
    const runner = buildSddStyleRunner();
    const env = { cwd: process.cwd() };

    const pre = await runner.preToolUse('edit', { path: PROBE }, env, { mutating: true });
    try {
      expect(pre.block).toBeFalsy();

      if (!wt.isAvailable) return;

      const locks = await wt.listLocks();
      const held = locks.find((l) => sameLockPath(l.path, PROBE_KEY));
      // The lock must actually be claimed; `if (held)` let a missing claim pass.
      expect(held?.owner).toBe(`wrongstack:${SESSION}`);
    } finally {
      // preToolUse has already claimed the lock with the hooks' default 900s
      // TTL, so a failing assertion above used to strand it on the daemon
      // where it would deny a real edit to PROBE. postToolUse is the
      // production release path — run it unconditionally.
      await runner.postToolUse('edit', { path: PROBE }, { content: '', isError: false }, env);
    }

    const after = (await wt.listLocks()).filter((l) => sameLockPath(l.path, PROBE_KEY));
    expect(after).toHaveLength(0);
  });
});
