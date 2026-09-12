import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainArbiter } from '../../src/coordination/brain.js';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { HUMAN_APPROVAL_TIMEOUT_MS } from '../../src/core/agent-tools.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { createApprovalRegistry } from '../../src/hq/approval-bridge.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { Container } from '../../src/kernel/container.js';
import { EventBus } from '../../src/kernel/events.js';
import { TOKENS } from '../../src/kernel/tokens.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { Tool } from '../../src/types/tool.js';
import { MockProvider } from '../helpers/mock-provider.js';

/**
 * P1 #4 (before-release.md): when DefaultPermissionPolicy.evaluate() returns
 * `permission: 'confirm'` and the ToolExecutor has neither a confirmAwaiter
 * nor any UI layer subscribed to `tool.confirm_needed`, the pending confirm
 * promise hangs forever — the tool neither executes nor fails, and the agent
 * appears stuck.
 *
 * Fix: waitForConfirm() in agent-tools.ts now checks
 * `events.listenerCount('tool.confirm_needed')` before emitting. Zero
 * subscribers ⇒ deny immediately so the tool surfaces an error instead of
 * deadlocking. This test builds an agent with confirmAwaiter: undefined and
 * NO tool.confirm_needed listener — the exact headless/CI/test shape — and
 * asserts the run resolves (does not hang) with the denied tool result.
 */

async function buildHeadlessAgent(
  provider: MockProvider,
  extraTools: Tool[] = [],
  brain?: BrainArbiter,
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-headless-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  if (brain) container.bind(TOKENS.BrainArbiter, () => brain);
  // YOLO off — destructive ops must go through confirm. This is what produces
  // the pending confirm result that would deadlock without the listener check.
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: false }),
  );

  const tools = new ToolRegistry();
  for (const t of extraTools) tools.register(t);
  const providers = new ProviderRegistry();
  // Fresh EventBus with NO tool.confirm_needed subscriber — headless.
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });

  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
    events,
    // confirmAwaiter omitted — no inline REPL prompt path.
    confirmAwaiter: undefined,
    iterationTimeoutMs: 300_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });

  const agent = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines,
    context: ctx,
    maxIterations: 10,
    toolExecutor,
  });
  return { agent, ctx, events, tmp, sessionStore };
}

describe('Headless confirm fallback (P1 #4)', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('auto-denies a confirm-required tool when no UI listener is attached (no deadlock)', async () => {
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op requiring confirm',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        return 'should-not-reach';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'recovered after denial' }], stopReason: 'end_turn' },
    ]);
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger]);
    cleanupDirs.push(tmp);

    // Headless precondition: no listener for tool.confirm_needed.
    expect(events.listenerCount('tool.confirm_needed')).toBe(0);

    // The run must resolve — NOT hang. Before the fix this awaited forever.
    const result = await agent.run('do the dangerous thing');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('recovered after denial');

    // The tool was never executed (denied before execute()).
    expect(provider.calls).toBe(2);
  }, 10_000);

  it('still resolves via the event when a listener IS attached (regression guard)', async () => {
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op requiring confirm',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        return 'did the thing';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger]);
    cleanupDirs.push(tmp);

    // Attach a listener that approves — simulates a TUI/WebUI confirm handler.
    events.on(
      'tool.confirm_needed',
      (e: { resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void }) => e.resolve('yes'),
    );
    expect(events.listenerCount('tool.confirm_needed')).toBe(1);

    const result = await agent.run('do the dangerous thing');
    expect(result.status).toBe('done');
    // Tool executed because the listener approved.
    expect(result.finalText).toBe('ok');
  }, 10_000);

  it('still auto-denies when the ONLY listener is the passive HQ mirror', async () => {
    // HQ mirrors prompts a local surface raised; it can never answer on its
    // own. Counting it as a listener would silently convert this instant
    // denial into a 120-second wait for a human who is not there — a safety
    // regression with no visible cause, triggered purely by a dashboard
    // happening to be connected.
    let executed = false;
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op requiring confirm',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        executed = true;
        return 'should-not-reach';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'recovered after denial' }], stopReason: 'end_turn' },
    ]);
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger]);
    cleanupDirs.push(tmp);

    const registry = createApprovalRegistry(events);
    try {
      expect(events.listenerCount('tool.confirm_needed')).toBe(1);

      const result = await agent.run('do the dangerous thing');
      expect(result.status).toBe('done');
      expect(result.finalText).toBe('recovered after denial');
      expect(executed).toBe(false);
    } finally {
      registry.dispose();
    }
  }, 10_000);

  it('announces an ordinary human answer as tool.confirm_resolved', async () => {
    // A prompt is now shown on more than one surface at once. Without an event
    // on the ORDINARY path (this used to fire only for abort and the Brain
    // timeout), HQ would keep offering buttons for a decision already made at
    // the keyboard.
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op requiring confirm',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        return 'did the thing';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger]);
    cleanupDirs.push(tmp);

    const resolved: Array<{ toolUseId: string; decision: string; source: string }> = [];
    events.on('tool.confirm_resolved', (e) => resolved.push(e as never));
    events.on(
      'tool.confirm_needed',
      (e: { resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void }) => e.resolve('yes'),
    );

    const result = await agent.run('do the dangerous thing');
    expect(result.status).toBe('done');
    expect(resolved).toEqual([
      expect.objectContaining({ toolUseId: 'u1', decision: 'yes', source: 'user' }),
    ]);
  }, 10_000);

  it('unblocks a pending confirm when the run is aborted (/interrupt path)', async () => {
    let executed = false;
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op requiring confirm',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        executed = true;
        return 'should-not-reach';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'never reached' }], stopReason: 'end_turn' },
    ]);
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger]);
    cleanupDirs.push(tmp);

    // A listener IS attached but never answers — the confirm panel is "on
    // screen" while the user reaches for /interrupt instead. Before the
    // abort-awareness fix in waitForConfirm this awaited forever.
    let sawConfirm = false;
    events.on('tool.confirm_needed', () => {
      sawConfirm = true;
    });

    const ctrl = new AbortController();
    const pending = agent.run('do the dangerous thing', { signal: ctrl.signal });
    await expect.poll(() => sawConfirm).toBe(true);
    ctrl.abort('user interrupt (/interrupt)');

    const result = await pending;
    expect(result.status).toBe('aborted');
    // The tool must never have executed — the confirm was aborted, not approved.
    expect(executed).toBe(false);
  }, 10_000);

  it('waits exactly 120 seconds, then delegates the unanswered approval to Brain', async () => {
    let executed = false;
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op requiring confirm',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        executed = true;
        return 'brain-approved';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u-timeout', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'continued' }], stopReason: 'end_turn' },
    ]);
    const brain: BrainArbiter = {
      decide: vi.fn(async () => ({
        type: 'answer' as const,
        optionId: 'approve',
        text: 'Approve this tool call once',
      })),
    };
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger], brain);
    cleanupDirs.push(tmp);
    let deadlineAt: number | undefined;
    let markConfirmSeen: (() => void) | undefined;
    const confirmSeen = new Promise<void>((resolve) => {
      markConfirmSeen = resolve;
    });
    const resolved = vi.fn();
    events.on('tool.confirm_needed', (event) => {
      deadlineAt = event.deadlineAt;
      markConfirmSeen?.();
    });
    events.on('tool.confirm_resolved', resolved);

    const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
    let fireApprovalTimeout: (() => void) | undefined;
    const timeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler, timeout, ...args) => {
        const scheduled = nativeSetTimeout(handler, timeout, ...args);
        if (timeout === HUMAN_APPROVAL_TIMEOUT_MS && typeof handler === 'function') {
          fireApprovalTimeout = () => handler(...args);
        }
        return scheduled;
      });
    try {
      const startedAt = Date.now();
      const run = agent.run('do the dangerous thing');
      await confirmSeen;

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), HUMAN_APPROVAL_TIMEOUT_MS);
      expect(deadlineAt).toBeGreaterThanOrEqual(startedAt + HUMAN_APPROVAL_TIMEOUT_MS);
      expect(brain.decide).not.toHaveBeenCalled();
      expect(executed).toBe(false);

      fireApprovalTimeout?.();
      const result = await run;
      expect(brain.decide).toHaveBeenCalledTimes(1);
      expect(executed).toBe(true);
      expect(result.finalText).toBe('continued');
      expect(resolved).toHaveBeenCalledWith(
        expect.objectContaining({
          toolUseId: 'u-timeout',
          decision: 'yes',
          source: 'brain_timeout',
        }),
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
