/**
 * Tests for the CLI prompt-journal recorder middleware
 * (`packages/cli/src/wiring/prompt-journal-recorder.ts`), which records every
 * submitted user prompt (raw or refined) and the session system prompt into
 * `<projectRoot>/.wrongstack/prompts/` from the agent's userInput pipeline.
 *
 * Writes are fire-and-forget by design, so tests poll the journal on disk
 * instead of relying on the handler promise having flushed.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, Context, createDefaultPipelines } from '@wrongstack/core/agent';
import { DefaultErrorHandler, DefaultRetryPolicy, ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { getPromptJournalEntries } from '@wrongstack/core/prompts';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultPermissionPolicy, DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type {
  Capabilities,
  ContentBlock,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createPromptJournalRecorder,
  createPromptJournalToolCallRecorder,
  PROMPT_JOURNAL_RAW_MARKER,
} from '../src/wiring/prompt-journal-recorder.js';

async function waitFor<T>(
  probe: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fakePayload(over: {
  text: string;
  projectRoot: string;
  sessionId?: string;
  model?: string;
  providerId?: string;
  tools?: string[];
  systemPrompt?: string;
  meta?: Record<string, unknown>;
}) {
  const tools = over.tools ?? ['read', 'write'];
  return {
    content: [{ type: 'text', text: over.text }],
    text: over.text,
    ctx: {
      projectRoot: over.projectRoot,
      session: { id: over.sessionId ?? 'sess-1' },
      model: over.model ?? 'test-model',
      provider: { id: over.providerId ?? 'test-provider' },
      tools: tools.map((name) => ({ name })),
      systemPrompt: over.systemPrompt
        ? [{ type: 'text', text: over.systemPrompt }]
        : [{ type: 'text', text: 'You are a helpful agent.' }],
      meta: over.meta ?? {},
    },
  };
}

describe('createPromptJournalRecorder', () => {
  it('returns middleware with the unique name PromptJournalRecorder', () => {
    expect(createPromptJournalRecorder().name).toBe('PromptJournalRecorder');
  });

  it('passes the payload through to next() unchanged', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-rec-'));
    try {
      const mw = createPromptJournalRecorder();
      const payload = fakePayload({ text: 'hello', projectRoot: tempDir });
      const next = vi.fn().mockResolvedValue(payload);
      const result = await mw.handler(payload as never, next);
      expect(result).toBe(payload);
      expect(next).toHaveBeenCalledWith(payload);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('records raw_user with session/model/provider/activeTools metadata', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-rec-raw-'));
    try {
      const mw = createPromptJournalRecorder();
      const payload = fakePayload({
        text: 'Add phone number to the user table',
        projectRoot: tempDir,
        sessionId: 'sess_auth',
        model: 'gemini-2.5-pro',
        providerId: 'google',
        tools: ['read', 'edit', 'bash'],
      });
      await mw.handler(payload as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.some((e) => e.category === 'raw_user'),
      );
      const raw = entries.find((e) => e.category === 'raw_user');
      expect(raw).toBeDefined();
      expect(raw?.content).toBe('Add phone number to the user table');
      expect(raw?.sessionId).toBe('sess_auth');
      expect(raw?.metadata.model).toBe('gemini-2.5-pro');
      expect(raw?.metadata.provider).toBe('google');
      expect(raw?.metadata.activeTools).toEqual(['read', 'edit', 'bash']);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('records refined_user with rawContent when the raw marker is stamped', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-rec-refined-'));
    try {
      const mw = createPromptJournalRecorder();
      const payload = fakePayload({
        text: '[Context: schema] Refined: add phone column',
        projectRoot: tempDir,
        meta: { [PROMPT_JOURNAL_RAW_MARKER]: 'add phone number to the user table' },
      });
      await mw.handler(payload as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.some((e) => e.category === 'refined_user'),
      );
      const refined = entries.find((e) => e.category === 'refined_user');
      expect(refined).toBeDefined();
      expect(refined?.content).toBe('[Context: schema] Refined: add phone column');
      expect(refined?.rawContent).toBe('add phone number to the user table');
      // The marker is consumed so a later turn is not mislabeled.
      expect(payload.ctx.meta).not.toHaveProperty(PROMPT_JOURNAL_RAW_MARKER);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('records the system prompt once per session', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-rec-sys-'));
    try {
      const mw = createPromptJournalRecorder();
      const payload = fakePayload({
        text: 'first turn',
        projectRoot: tempDir,
        sessionId: 'sess_sys',
        systemPrompt: 'You are the leader agent.',
      });
      await mw.handler(payload as never, (v) => Promise.resolve(v));
      await mw.handler({ ...payload, text: 'second turn' } as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.filter((e) => e.category === 'system_prompt').length === 1,
      );
      const system = entries.filter((e) => e.category === 'system_prompt');
      expect(system).toHaveLength(1);
      expect(system[0]?.content).toBe('You are the leader agent.');
      expect(system[0]?.sessionId).toBe('sess_sys');
      expect(entries.filter((e) => e.category === 'raw_user')).toHaveLength(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('skips recording entirely when there is no project root', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-rec-noroot-'));
    try {
      const mw = createPromptJournalRecorder();
      const payload = fakePayload({ text: 'hello', projectRoot: '' });
      await mw.handler(payload as never, (v) => Promise.resolve(v));
      // Nothing was written anywhere — the temp dir stays empty.
      const files = await fs.readdir(tempDir);
      expect(files).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

function fakeToolCallPayload(over: {
  toolName: string;
  input?: Record<string, unknown>;
  projectRoot: string;
  sessionId?: string;
}) {
  return {
    toolUse: { name: over.toolName, input: over.input ?? {} },
    result: { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
    ctx: {
      projectRoot: over.projectRoot,
      session: { id: over.sessionId ?? 'sess-1' },
      model: 'test-model',
      provider: { id: 'test-provider' },
      tools: [{ name: 'read' }, { name: 'write' }],
      meta: {},
    },
  };
}

describe('createPromptJournalToolCallRecorder', () => {
  it('records clarify_interaction with the question when the clarify tool runs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-tc-clarify-'));
    try {
      const mw = createPromptJournalToolCallRecorder();
      const payload = fakeToolCallPayload({
        toolName: 'clarify',
        input: {
          question: 'Should the index be unique or composite?',
          context: 'index performance trade-off',
        },
        projectRoot: tempDir,
      });
      await mw.handler(payload as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.some((e) => e.category === 'clarify_interaction'),
      );
      const entry = entries.find((e) => e.category === 'clarify_interaction');
      expect(entry).toBeDefined();
      expect(entry?.content).toBe('Should the index be unique or composite?');
      expect(entry?.metadata.decisionReason).toBe('index performance trade-off');
      expect(entry?.metadata.activeTools).toEqual(['read', 'write']);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('records subagent_delegation with the task and role when the delegate tool runs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-tc-delegate-'));
    try {
      const mw = createPromptJournalToolCallRecorder();
      const payload = fakeToolCallPayload({
        toolName: 'delegate',
        input: { task: 'Review the auth middleware for token leaks', role: 'bug-hunter' },
        projectRoot: tempDir,
      });
      await mw.handler(payload as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.some((e) => e.category === 'subagent_delegation'),
      );
      const entry = entries.find((e) => e.category === 'subagent_delegation');
      expect(entry).toBeDefined();
      expect(entry?.content).toBe('Review the auth middleware for token leaks');
      expect(entry?.metadata.decisionReason).toBe('delegated to bug-hunter');
      expect(entry?.sessionId).toBe('sess-1');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('records autonomous_next_step when continue_to_next_iteration is called', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-tc-continue-'));
    try {
      const mw = createPromptJournalToolCallRecorder();
      const payload = fakeToolCallPayload({
        toolName: 'continue_to_next_iteration',
        projectRoot: tempDir,
      });
      await mw.handler(payload as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.some((e) => e.category === 'autonomous_next_step'),
      );
      const entry = entries.find((e) => e.category === 'autonomous_next_step');
      expect(entry).toBeDefined();
      expect(entry?.content).toContain('continue to the next iteration');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('does not record for tools outside the mapped set', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-tc-other-'));
    try {
      const mw = createPromptJournalToolCallRecorder();
      const payload = fakeToolCallPayload({ toolName: 'bash', projectRoot: tempDir });
      await mw.handler(payload as never, (v) => Promise.resolve(v));

      const entries = await waitFor(
        () => getPromptJournalEntries(tempDir),
        (list) => list.length > 0,
        1500,
      );
      expect(entries).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

// ── Agent-loop text-marker path ──────────────────────────────────────────
// `autonomous_next_step` is also emitted by the agent loop itself when it
// consumes a text-marker continue directive (`[continue]` / `[next step]` /
// `[proceed]`) WITHOUT the `continue_to_next_iteration` tool call — see
// `recordAutonomousContinue` in packages/core/src/core/agent-loop.ts. That
// path is loop-level (not a pipeline middleware), so it is covered by driving
// a full `Agent.run()` with a scripted provider whose first response is the
// marker text and whose second response ends the turn.

/** Minimal scripted provider: first call returns the marker text, then a final answer. */
class TextMarkerProvider implements Provider {
  readonly id = 'mock';
  readonly capabilities: Capabilities = {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    reasoning: false,
    maxContext: 200_000,
    cacheControl: 'none',
  };
  calls = 0;
  constructor(private readonly marker: string) {}
  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
    this.calls++;
    const content: ContentBlock[] =
      this.calls === 1
        ? [{ type: 'text', text: this.marker }]
        : [{ type: 'text', text: 'final answer' }];
    return {
      content,
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
      model: req.model,
    };
  }

  // biome-ignore lint/correctness/useYield: stub throws intentionally
  async *stream(_req: Request, _opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    throw new Error('stream not used — capabilities.streaming is false');
  }
}

/** Build a full Agent whose provider scripts one marker turn then a final answer. */
async function buildMarkerAgent(
  marker: string,
  tmp: string,
): Promise<{ agent: Agent; provider: TextMarkerProvider }> {
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );

  const tools = new ToolRegistry();
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model: 'test-model', provider: 'mock' });

  const provider = new TextMarkerProvider(marker);
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'test agent' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });

  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber: container.resolve(TOKENS.SecretScrubber),
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
    maxIterations: 5,
    toolExecutor,
  });
  return { agent, provider };
}

describe('agent-loop text-marker autonomous continue', () => {
  it.each(['[continue]', '[next step]', '[proceed]'])(
    'records autonomous_next_step when the loop consumes %s without the tool call',
    async (marker) => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-marker-'));
      try {
        const { agent, provider } = await buildMarkerAgent(marker, tmp);

        const result = await agent.run('go', { autonomousContinue: true });
        expect(result.status).toBe('done');
        expect(provider.calls).toBe(2);

        const entries = await waitFor(
          () => getPromptJournalEntries(tmp),
          (list) => list.some((e) => e.category === 'autonomous_next_step'),
        );
        const entry = entries.find((e) => e.category === 'autonomous_next_step');
        expect(entry).toBeDefined();
        expect(entry?.content).toContain(marker);
        expect(entry?.metadata.decisionReason).toBe('text-marker autonomous continue');
        expect(entry?.metadata.model).toBe('test-model');
        expect(entry?.metadata.provider).toBe('mock');
        expect(entry?.sessionId).toBeTruthy();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    },
  );

  it('writes no autonomous_next_step entry for the [done] stop directive', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-marker-done-'));
    try {
      const { agent, provider } = await buildMarkerAgent('[done]', tmp);

      const result = await agent.run('go', { autonomousContinue: true });
      expect(result.status).toBe('done');
      // `[done]` maps to directive 'stop' — the loop returns immediately,
      // so the provider is only called once and nothing is journaled.
      expect(provider.calls).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const entries = await getPromptJournalEntries(tmp);
      expect(entries.filter((e) => e.category === 'autonomous_next_step')).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
