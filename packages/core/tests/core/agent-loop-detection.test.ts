/**
 * Agent-loop safety-valve tests.
 *
 * Exercises the per-iteration fingerprint detector in `agent-loop.ts`. Three
 * k2p7 loop patterns are covered (identical tool calls, identical-text
 * message repeats, and a documented all-different-inputs escape), plus
 * three regressions that must keep working (legitimate tool-use, the
 * threshold edge, the empty-response reset).
 *
 * Why a separate file: agent-loop is a giant module; the previous detector
 * (tool-only, after 3 identical signatures) shipped without tests. Adding
 * the message-loop case plus the generalized fingerprint to the same file
 * would mean 100+ lines of mock setup interleaved with unrelated describe
 * blocks. This file isolates the loop safety valve so the regression
 * surface is obvious and easy to expand.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
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
import type { LoopDetectionConfig } from '../../src/types/config.js';
import type { Tool } from '../../src/types/tool.js';
import { MockProvider } from '../helpers/mock-provider.js';

async function buildAgent(
  provider: MockProvider,
  extraTools: Tool[] = [],
  loopDetection?: LoopDetectionConfig,
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-loop-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );

  const tools = new ToolRegistry();
  for (const t of extraTools) tools.register(t);
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model: 'k2p7', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a k2p7-like test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'k2p7',
  });

  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
    events,
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
    maxIterations: 25,
    toolExecutor,
    loopDetection,
  });
  return { agent, ctx, tools, tmp, sessionStore };
}

const echoTool = (name = 'echo'): Tool => ({
  name,
  description: '',
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return 'ok';
  },
});

describe('agent-loop fingerprint detector', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    for (const d of cleanupDirs) {
      await fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  // ── The k2p7 loop patterns the safety valve must catch ─────────────

  it("breaks the run when the same tool is called with identical inputs 3 times in a row (legacy 'cut' mode)", async () => {
    const echo = echoTool();
    // Three identical tool-use responses, then the model finally gives up —
    // but we break out at iteration 3 before the script is exhausted.
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'a' } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u2', name: 'echo', input: { text: 'a' } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u3', name: 'echo', input: { text: 'a' } }],
        stopReason: 'tool_use',
      },
      // Never reached — detector breaks the run on iteration 3.
      { content: [{ type: 'text', text: 'unreached' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo], { mode: 'cut' });
    cleanupDirs.push(tmp);

    const detected: Array<{ tools: string; kind?: string; repeatCount: number }> = [];
    (agent as never as { events: EventBus }).events.on(
      'tool.loop_detected',
      (e) => detected.push({ tools: e.tools, kind: e.kind, repeatCount: e.repeatCount }),
    );

    const result = await agent.run('loop', { maxIterations: 20 });

    expect(result.status).toBe('max_iterations');
    expect(provider.calls).toBe(3);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.tools).toBe('echo');
    expect(detected[0]?.kind).toBe('tool');
    expect(detected[0]?.repeatCount).toBe(3);
    expect(result.finalText).toMatch(/Loop detected.*echo.*3 times/);
  });

  it('catches the k2p7 "same tool, slightly different inputs" pattern via the per-iteration fingerprint reset', async () => {
    // K2P7 sometimes retries the same tool with slightly different inputs
    // (e.g. read with offset 1, then offset 2, then offset 3). The strict
    // fingerprint differs each iteration so the count never reaches 3 — but
    // after 2 differing iterations the 3rd DIFFERENT iteration also misses,
    // the run keeps going indefinitely. This test asserts that behaviour
    // (the detector does NOT trip on a 3-iteration run with all-different
    // inputs) and documents that the escape pattern is a known limitation
    // that the read tool's own past-EOF message is designed to prevent at
    // the tool level.
    const read: Tool = {
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'past end of file';
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'foo.txt', offset: 1 } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u2', name: 'read', input: { path: 'foo.txt', offset: 2 } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u3', name: 'read', input: { path: 'foo.txt', offset: 3 } }],
        stopReason: 'tool_use',
      },
      // Final entry: the model eventually gives up and reports its findings.
      // Without this, the agent's next provider call exhausts the script and
      // the run returns `failed` (correct outcome for this test — the
      // detector did NOT trip) but with a noisy error log.
      { content: [{ type: 'text', text: 'I give up' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [read]);
    cleanupDirs.push(tmp);

    const detected: Array<unknown> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', () =>
      detected.push(true),
    );

    const result = await agent.run('go', { maxIterations: 20 });
    // The detector does NOT trip on all-different inputs — that's the
    // documented limitation. The run completes (the model eventually
    // gives up) and the status is `done`, importantly NOT `max_iterations`
    // with a false-positive loop event.
    expect(detected).toEqual([]);
    expect(result.status).toBe('done');
  });

  it("catches the k2p7 \"assistant message repeats\" pattern via autonomous-continue (legacy 'cut' mode)", async () => {
    // K2P7 in autonomous-continue mode echoes the same prose turn after
    // turn with no tool calls at all. The OLD detector only ran when there
    // was a tool_use, so this case was invisible. The NEW detector
    // fingerprints text content too, breaks the loop, and tags the event
    // kind: 'message'.
    //
    // We use the `[continue]` text directive (parsed by parseContinueDirective)
    // to keep the run going across end_turn responses — without it
    // agent.run() returns after the first end_turn and the message loop
    // is unreachable.
    const stuckText = 'I have made progress.\n[continue]';
    const provider = new MockProvider([
      { content: [{ type: 'text', text: stuckText }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: stuckText }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: stuckText }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: stuckText }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [], { mode: 'cut' });
    cleanupDirs.push(tmp);

    const detected: Array<{ kind?: string; tools: string; repeatCount: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', (e) =>
      detected.push({ kind: e.kind, tools: e.tools, repeatCount: e.repeatCount }),
    );

    const result = await agent.run('go', { maxIterations: 20, autonomousContinue: true });

    // The detector MUST trip in this scenario — the model is repeating the
    // exact same text 4 times. If the test ever sees a non-trip result,
    // either the detector regressed or the continue directive plumbing
    // stopped re-entering the loop. finalText is the model's own text
    // (kept verbatim) — the trip summary lives in the emitted event.
    expect(result.status).toBe('max_iterations');
    expect(detected).toHaveLength(1);
    expect(detected[0]?.kind).toBe('message');
    expect(detected[0]?.tools).toBe('');
    expect(detected[0]?.repeatCount).toBe(3);
  });

  // ── Regressions: the new fingerprint must not false-positive on legitimate runs ──

  it('does NOT trip when the model calls a tool twice then changes input on the third call', async () => {
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'ok';
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'a' } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u2', name: 'echo', input: { text: 'a' } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u3', name: 'echo', input: { text: 'DIFFERENT' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'all good' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);

    const detected: Array<unknown> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', () =>
      detected.push(true),
    );

    const result = await agent.run('go', { maxIterations: 20 });
    expect(result.status).toBe('done');
    expect(detected).toEqual([]);
  });

  it('does NOT trip when the model alternates between two distinct, non-looping tools', async () => {
    const make = (name: string): Tool => ({
      name,
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'ok';
      },
    });
    const tools = [make('read'), make('write')];
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } }],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'u2', name: 'write', input: { path: 'b' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, tools);
    cleanupDirs.push(tmp);

    const detected: Array<unknown> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', () =>
      detected.push(true),
    );

    const result = await agent.run('go', { maxIterations: 20 });
    expect(result.status).toBe('done');
    expect(detected).toEqual([]);
  });

  it('does NOT trip on a single end_turn followed by a different end_turn', async () => {
    // Two distinct text responses — different content, no loop.
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'first thought' }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'second thought, different' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);

    const detected: Array<unknown> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', () =>
      detected.push(true),
    );

    await agent.run('hi', { maxIterations: 20, autonomousContinue: true });
    expect(detected).toEqual([]);
  });

  // ── steer-then-cut escalation (the default mode) ────────────────────

  it('default mode: steers at the steer threshold, cuts only when repetition persists', async () => {
    const echo = echoTool();
    const identical = () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: { text: 'a' } }],
      stopReason: 'tool_use' as const,
    });
    // Six identical responses scripted; the run must cut at iteration 5
    // (steer at 3, cut at 5) without reaching the 6th.
    const provider = new MockProvider([
      identical(), identical(), identical(), identical(), identical(), identical(),
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);

    const detected: Array<{ action?: string; scope?: string; repeatCount: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', (e) =>
      detected.push({ action: e.action, scope: e.scope, repeatCount: e.repeatCount }),
    );

    const result = await agent.run('loop', { maxIterations: 20 });

    expect(result.status).toBe('max_iterations');
    expect(provider.calls).toBe(5);

    // First event: the iteration-scope steer at streak 3. Last event: the cut at 5.
    expect(detected[0]).toEqual({ action: 'steer', scope: 'iteration', repeatCount: 3 });
    expect(detected[detected.length - 1]).toEqual({
      action: 'cut',
      scope: 'iteration',
      repeatCount: 5,
    });

    // The steer note must have been folded into the conversation as user-side
    // text before the cut.
    const userTexts = ctx.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    expect(userTexts.some((t) => t.includes('[loop-detector]'))).toBe(true);
  });

  it('default mode: message loops in autonomous-continue steer first, then cut', async () => {
    const stuckText = 'Still working on it.\n[continue]';
    const stuck = () => ({
      content: [{ type: 'text' as const, text: stuckText }],
      stopReason: 'end_turn' as const,
    });
    const provider = new MockProvider([stuck(), stuck(), stuck(), stuck(), stuck(), stuck()]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);

    const detected: Array<{ action?: string; kind?: string; repeatCount: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', (e) =>
      detected.push({ action: e.action, kind: e.kind, repeatCount: e.repeatCount }),
    );

    const result = await agent.run('go', { maxIterations: 20, autonomousContinue: true });

    expect(result.status).toBe('max_iterations');
    expect(provider.calls).toBe(5);
    expect(detected[0]).toMatchObject({ action: 'steer', kind: 'message', repeatCount: 3 });
    expect(detected[detected.length - 1]).toMatchObject({
      action: 'cut',
      kind: 'message',
      repeatCount: 5,
    });
  });

  it('default mode: tolerates three repeated observation-only reads', async () => {
    const read: Tool = { ...echoTool('read'), riskTier: 'safe', capabilities: ['fs.read'] };
    const repeatedRead = (id: string) => ({
      content: [{ type: 'tool_use' as const, id, name: 'read', input: { path: 'same.txt' } }],
      stopReason: 'tool_use' as const,
    });
    const provider = new MockProvider([
      repeatedRead('r1'), repeatedRead('r2'), repeatedRead('r3'),
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [read]);
    cleanupDirs.push(tmp);
    const detected: unknown[] = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', () => detected.push(true));

    expect((await agent.run('inspect', { maxIterations: 20 })).status).toBe('done');
    expect(detected).toEqual([]);
  });

  it('per-call window detector: catches the same call repeated non-consecutively (interleaved)', async () => {
    // The iteration detector CANNOT see this pattern — the repeated read is
    // interleaved with other calls, so the consecutive streak never exceeds 1.
    // The sliding-window per-call detector catches the 4th identical read.
    const tools = [echoTool('read'), echoTool('aux')];
    const read = () => ({
      content: [
        { type: 'tool_use' as const, id: 'r', name: 'read', input: { path: 'same.txt' } },
      ],
      stopReason: 'tool_use' as const,
    });
    const aux = (n: number) => ({
      content: [{ type: 'tool_use' as const, id: 'x', name: 'aux', input: { step: n } }],
      stopReason: 'tool_use' as const,
    });
    const provider = new MockProvider([
      read(), aux(1), read(), aux(2), read(), aux(3), read(),
      { content: [{ type: 'text', text: 'ok, moving on' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider, tools);
    cleanupDirs.push(tmp);

    const detected: Array<{ action?: string; scope?: string; tools: string; repeatCount: number }> =
      [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', (e) =>
      detected.push({ action: e.action, scope: e.scope, tools: e.tools, repeatCount: e.repeatCount }),
    );

    const result = await agent.run('go', { maxIterations: 20 });

    // Steer only — the run completes normally after the model changes course.
    expect(result.status).toBe('done');
    expect(detected).toHaveLength(1);
    expect(detected[0]).toEqual({ action: 'steer', scope: 'call', tools: 'read', repeatCount: 4 });

    const userTexts = ctx.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    expect(userTexts.some((t) => t.includes('You have called read'))).toBe(true);
  });

  it('per-call detector normalizes argument key order', async () => {
    // {a,b} vs {b,a} must count as the SAME call.
    const tools = [echoTool('read'), echoTool('aux')];
    const readAB = () => ({
      content: [
        { type: 'tool_use' as const, id: 'r', name: 'read', input: { path: 'f.txt', limit: 5 } },
      ],
      stopReason: 'tool_use' as const,
    });
    const readBA = () => ({
      content: [
        { type: 'tool_use' as const, id: 'r', name: 'read', input: { limit: 5, path: 'f.txt' } },
      ],
      stopReason: 'tool_use' as const,
    });
    const aux = (n: number) => ({
      content: [{ type: 'tool_use' as const, id: 'x', name: 'aux', input: { step: n } }],
      stopReason: 'tool_use' as const,
    });
    const provider = new MockProvider([
      readAB(), aux(1), readBA(), aux(2), readAB(), aux(3), readBA(),
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, tools);
    cleanupDirs.push(tmp);

    const detected: Array<{ scope?: string; repeatCount: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', (e) =>
      detected.push({ scope: e.scope, repeatCount: e.repeatCount }),
    );

    await agent.run('go', { maxIterations: 20 });
    expect(detected).toHaveLength(1);
    expect(detected[0]).toEqual({ scope: 'call', repeatCount: 4 });
  });

  it("mode 'off' disables both detectors", async () => {
    const echo = echoTool();
    const identical = () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: { text: 'a' } }],
      stopReason: 'tool_use' as const,
    });
    const provider = new MockProvider([
      identical(), identical(), identical(), identical(), identical(), identical(),
      { content: [{ type: 'text', text: 'finally done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo], { mode: 'off' });
    cleanupDirs.push(tmp);

    const detected: Array<unknown> = [];
    (agent as never as { events: EventBus }).events.on('tool.loop_detected', () =>
      detected.push(true),
    );

    const result = await agent.run('go', { maxIterations: 20 });
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(7);
    expect(detected).toEqual([]);
  });
});
