import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainArbiter } from '../../src/brain/brain.js';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { HUMAN_APPROVAL_TIMEOUT_MS } from '../../src/core/agent-tools.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { createApprovalRegistry } from '../../../hq/src/approval-bridge.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
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

  it.each(['always-exact', 'always-command', 'always-tool'] as const)(
    'persists %s through the event confirmation path',
    async (decision) => {
      const execute = vi.fn(async () => 'ok');
      const tool: Tool = {
        name: 'exec',
        description: 'test executor',
        inputSchema: { type: 'object' },
        permission: 'confirm',
        subjectKey: 'command',
        mutating: true,
        execute,
      };
      const provider = new MockProvider([
        {
          content: [
            {
              type: 'tool_use',
              id: 'scoped-1',
              name: 'exec',
              input: { command: 'uv', args: ['run', 'pytest'] },
            },
          ],
          stopReason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
      ]);
      const { agent, events, tmp } = await buildHeadlessAgent(provider, [tool]);
      cleanupDirs.push(tmp);
      const persisted = vi.fn();
      events.on('trust.persisted', persisted);
      events.on('tool.confirm_needed', (event) => event.resolve(decision));
      expect((await agent.run('verify')).status).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(await fs.readFile(path.join(tmp, 'trust.json'), 'utf8'));
      expect(persisted).toHaveBeenCalledWith(
        expect.objectContaining({
          pattern: saved.exec.allow[0],
          scope: decision.slice('always-'.length),
          displayPattern: expect.any(String),
        }),
      );
      expect(saved.exec.allow[0]).toContain(
        `wrongstack-approval:v1:${decision.slice('always-'.length)}`,
      );
    },
  );

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
    // expect.poll defaults to 1s — a cold first run() under coverage load
    // reaches the confirm later than that. Bounded by the 10s test timeout.
    await expect.poll(() => sawConfirm, { timeout: 8_000 }).toBe(true);
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

  it('a headless auto-deny refuses the call without writing a permanent deny rule', async () => {
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
      { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
    ]);
    const { agent, events, tmp } = await buildHeadlessAgent(provider, [danger]);
    cleanupDirs.push(tmp);
    const persisted = vi.fn();
    events.on('trust.persisted', persisted);

    expect((await agent.run('do the dangerous thing')).finalText).toBe('recovered');
    expect(persisted).not.toHaveBeenCalled();
    const trust = await fs.readFile(path.join(tmp, 'trust.json'), 'utf8').catch(() => '{}');
    expect(JSON.parse(trust)).not.toHaveProperty('danger');
  }, 10_000);

  describe('YOLO asking about a rule the user wrote', () => {
    async function setup(brain?: BrainArbiter) {
      const execute = vi.fn(async () => 'ran');
      const sh: Tool = {
        name: 'sh',
        description: 'shell',
        inputSchema: { type: 'object' },
        permission: 'confirm',
        subjectKey: 'command',
        mutating: true,
        execute,
      } as Tool;
      const provider = new MockProvider([
        {
          content: [{ type: 'tool_use', id: 'u-rule', name: 'sh', input: { command: 'git push' } }],
          stopReason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'continued' }], stopReason: 'end_turn' },
      ]);
      const built = await buildHeadlessAgent(provider, [sh], brain);
      cleanupDirs.push(built.tmp);
      await fs.writeFile(
        path.join(built.tmp, 'trust.json'),
        JSON.stringify({ sh: { deny: ['git push*'] } }),
      );
      built.ctx.meta['yolo'] = true;
      return { ...built, execute };
    }

    it('an unanswered question stays refused: the Brain is never asked', async () => {
      const brain: BrainArbiter = {
        decide: vi.fn(async () => ({
          type: 'answer' as const,
          optionId: 'approve',
          text: 'Approve this tool call once',
        })),
      };
      const { agent, events, execute } = await setup(brain);
      let source: string | undefined;
      let seen: (() => void) | undefined;
      const confirmSeen = new Promise<void>((r) => {
        seen = r;
      });
      events.on('tool.confirm_needed', (e) => {
        source = e.decisionSource;
        seen?.();
      });
      const resolved = vi.fn();
      events.on('tool.confirm_resolved', resolved);

      const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
      let fire: (() => void) | undefined;
      const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((h, ms, ...args) => {
        const t = nativeSetTimeout(h, ms, ...args);
        if (ms === HUMAN_APPROVAL_TIMEOUT_MS && typeof h === 'function') fire = () => h(...args);
        return t;
      });
      try {
        const run = agent.run('push it');
        await confirmSeen;
        expect(source).toBe('yolo_user_rule');
        fire?.();
        expect((await run).finalText).toBe('continued');
      } finally {
        spy.mockRestore();
      }
      expect(brain.decide).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(resolved).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'no', source: 'brain_timeout' }),
      );
    }, 10_000);

    it('"always allow" runs the call once and writes no allow rule — the deny rule stays', async () => {
      const { agent, events, execute, tmp } = await setup();
      const persisted = vi.fn();
      events.on('trust.persisted', persisted);
      events.on('tool.confirm_needed', (e) => e.resolve('always-tool'));

      expect((await agent.run('push it')).finalText).toBe('continued');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(persisted).not.toHaveBeenCalled();
      const saved = JSON.parse(await fs.readFile(path.join(tmp, 'trust.json'), 'utf8'));
      expect(saved).toEqual({ sh: { deny: ['git push*'] } });
    }, 10_000);
  });
});
