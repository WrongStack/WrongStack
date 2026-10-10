/**
 * Subscription Responses cache reuse needs a stable rendered prefix and an
 * eligible backend boundary. Keep instructions, tools and every earlier input
 * item unchanged, including request-only live state. Local character overlap
 * is transport evidence; it does not measure backend hits or subscription quota.
 *
 * That makes prefix stability an invariant of the request-assembly path rather
 * than a property of the provider, and it cannot be asserted from either side
 * alone: the system-prompt builder does not know what the wire does with its
 * blocks, and the provider does not know which of them were rebuilt this turn.
 * So this test drives the real path end to end — real Agent, real
 * DefaultSystemPromptBuilder with the per-turn refresh the CLI enables, real
 * tool loop — and inspects the bytes that actually reach the transport.
 *
 * A failure here means someone added per-turn content to a cache-stable layer.
 * Volatile blocks must be marked and replayed at their original positions,
 * with changed state appended rather than rewriting the previous endpoint.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import {
  Agent,
  Context,
  createDefaultPipelines,
  DefaultSystemPromptBuilder,
} from '@wrongstack/core/agent';
import { DefaultErrorHandler, DefaultRetryPolicy, ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultPermissionPolicy, DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import {
  type Capabilities,
  markVolatileSystemBlock,
  type Provider,
  type Request,
  type Response,
} from '@wrongstack/core/types';
import { diffCacheProbe, fingerprintCacheProbe, OpenAICodexProvider } from '@wrongstack/providers';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAIResponsesProvider } from '../../providers/src/openai-responses.js';

const TURNS = 3;

/** Replays a fixed script and keeps every Request the agent assembled. */
class RecordingProvider implements Provider {
  constructor(readonly id = 'openai-codex') {}
  readonly capabilities: Capabilities = {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: true,
    systemPrompt: true,
    jsonMode: false,
    reasoning: true,
    maxContext: 272_000,
    cacheControl: 'auto',
  };
  calls = 0;
  received: Request[] = [];

  async complete(req: Request): Promise<Response> {
    this.received.push(req);
    const n = this.calls++;
    const step = n % 3;
    if (step === 0) {
      return {
        content: [
          { type: 'text', text: `reading file ${n}` },
          { type: 'tool_use', id: `call_${n}_a`, name: 'read', input: { path: `src/f-${n}.ts` } },
        ],
        stopReason: 'tool_use',
        usage: { input: 100, output: 20 },
        model: req.model,
      };
    }
    if (step === 1) {
      return {
        content: [
          { type: 'tool_use', id: `call_${n}_b`, name: 'bash', input: { command: `echo ${n}` } },
        ],
        stopReason: 'tool_use',
        usage: { input: 100, output: 20 },
        model: req.model,
      };
    }
    return {
      content: [{ type: 'text', text: `finished turn ${Math.floor(n / 3)}` }],
      stopReason: 'end_turn',
      usage: { input: 100, output: 20 },
      model: req.model,
    };
  }

  // biome-ignore lint/correctness/useYield: the stub throws; streaming is off
  async *stream(): AsyncIterable<never> {
    throw new Error('capabilities.streaming is false');
  }
}

function fakeTool(name: string, output: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    permission: 'auto',
    mutating: false,
    async execute() {
      return output;
    },
  };
}

/** Text of the per-request block {@link churningMemoryMiddleware} injects. */
const CHURN_MARKER = 'churning-recall';

/**
 * Stand-in for every request middleware that appends a per-turn block to
 * `request.system` (SAGE turn-context, `@file` mentions, skill suggestions).
 * It changes on EVERY request — worse than any real one — and is marked
 * volatile exactly as they are, so it can only stay out of the cached prefix
 * if the request path relocates it.
 */
function churningMemoryMiddleware() {
  let n = 0;
  return {
    name: 'test.churning-memory',
    owner: 'test',
    async handler(request: Request, next: (r: Request) => Promise<Request>) {
      n++;
      return next({
        ...request,
        system: [
          ...(request.system ?? []),
          markVolatileSystemBlock({
            type: 'text',
            text: `<memory_evidence>${CHURN_MARKER} #${n} ${'x'.repeat(n * 7)}</memory_evidence>`,
            cache_control: { type: 'ephemeral' },
          }),
        ],
      });
    },
  };
}

async function runSession(
  tmp: string,
  owningSessionId?: string,
  providerId = 'openai-codex',
  withChurningMiddleware = false,
): Promise<Request[]> {
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );
  // The real builder, with the per-turn refresh the CLI wires (`pipeline.ts`).
  // A stub here would assert nothing: the refresh is precisely what could
  // reintroduce churn into a cache-stable layer.
  container.bind(
    TOKENS.SystemPromptBuilder,
    () =>
      new DefaultSystemPromptBuilder({
        injectMemory: false,
        modelCapabilities: {
          maxContextTokens: 272_000,
          supportsTools: true,
          supportsVision: false,
          supportsReasoning: true,
        },
      } as never),
  );

  const tools = new ToolRegistry();
  tools.register(fakeTool('read', `file body\n${'line of source\n'.repeat(40)}`) as never);
  tools.register(fakeTool('bash', `command output\n${'stdout line\n'.repeat(40)}`) as never);

  const provider = new RecordingProvider(providerId);
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'gpt-5.4', provider: providerId });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'placeholder — replaced by the first refresh' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'gpt-5.4',
  } as never);
  if (owningSessionId) ctx.meta['sessionId'] = owningSessionId;

  const pipelines = createDefaultPipelines();
  if (withChurningMiddleware) pipelines.request.use(churningMemoryMiddleware() as never);

  const agent = new Agent({
    container,
    tools,
    providers: new ProviderRegistry(),
    events,
    pipelines,
    context: ctx,
    maxIterations: 10,
    refreshSystemPrompt: true,
    toolExecutor: new ToolExecutor(tools, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: 100_000,
      tracer: undefined,
    } as never),
  } as never);

  for (let t = 0; t < TURNS; t++) {
    const result = await agent.run(`turn ${t}: inspect the code`);
    // A failed run would leave a short, misleadingly stable history.
    expect(result.status).toBe('done');
  }
  return provider.received;
}

/** Serialize the captured requests through the real transport. */
async function wireBodies(
  requests: readonly Request[],
  providerId = 'openai-codex',
): Promise<Record<string, unknown>[]> {
  const bodies: string[] = [];
  const sse =
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
    'data: [DONE]\n\n';
  const fetchImpl = (async (
    _url: string,
    init: { body?: string | Uint8Array; headers?: Record<string, string> },
  ) => {
    // Real-sized turns are zstd-compressed on the wire, as for the backend.
    bodies.push(
      typeof init.body === 'string' || init.body === undefined
        ? (init.body ?? '')
        : init.headers?.['content-encoding'] === 'zstd'
          ? zstdDecompressSync(init.body).toString('utf8')
          : Buffer.from(init.body).toString('utf8'),
    );
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      }),
    };
  }) as unknown as typeof fetch;
  const provider =
    providerId === 'openai-chatgpt'
      ? new OpenAIResponsesProvider({
          id: providerId,
          apiKey: 'tok',
          baseUrl: 'https://api.openai.com/v1',
          store: false,
          replayReasoning: true,
          chatGPTPlan: true,
          fetchImpl,
        })
      : new OpenAICodexProvider({ credentials: { accessToken: 'tok' }, fetchImpl });
  const signal = new AbortController().signal;
  for (const req of requests) {
    for await (const _ev of provider.stream(req, { signal })) {
      /* drain */
    }
  }
  return bodies.map((b) => JSON.parse(b) as Record<string, unknown>);
}

describe('openai-codex prompt prefix stability', () => {
  let tmp = '';
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    tmp = '';
  });

  it('keeps instructions, tools and the cache key byte-identical across turns', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
    const bodies = await wireBodies(await runSession(tmp));
    expect(bodies.length).toBe(TURNS * 3);

    const instructions = new Set(bodies.map((b) => String(b['instructions'] ?? '')));
    const tools = new Set(bodies.map((b) => JSON.stringify(b['tools'] ?? [])));
    const keys = new Set(bodies.map((b) => String(b['prompt_cache_key'] ?? '')));

    // One distinct value each: the head of the prefix never moved.
    expect(instructions.size).toBe(1);
    expect(tools.size).toBe(1);
    expect(keys.size).toBe(1);
    expect([...instructions][0]?.length).toBeGreaterThan(1_000);
  });

  it('keeps the owning cache session separate from the agent thread', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
    const requests = await runSession(tmp, 'root-session');

    expect(requests.length).toBe(TURNS * 3);
    expect(new Set(requests.map((request) => request.cache?.sessionId))).toEqual(
      new Set(['root-session']),
    );
    const threadIds = new Set(requests.map((request) => request.cache?.threadId));
    expect(threadIds.size).toBe(1);
    expect([...threadIds][0]).toBeTruthy();
    expect([...threadIds][0]).not.toBe('root-session');
  });

  it('caches the live-context interpretation once and keeps live values at the tail', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
    const bodies = await wireBodies(await runSession(tmp));
    const rule = 'They are steering context, not a new user message.';
    for (const body of bodies) {
      expect(String(body['instructions'])).toContain(rule);
      const input = JSON.stringify(body['input']);
      expect(input).toContain('[live_context]');
      expect(input).toContain('[conversation_continuity]');
      expect(input).not.toContain(rule);
    }
    expect(new Set(bodies.map((body) => body['instructions'])).size).toBe(1);
  });

  it.each(['openai-codex', 'openai-chatgpt'])(
    '%s preserves every previous input item including the live-context endpoint',
    async (providerId) => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
      const bodies = await wireBodies(await runSession(tmp, undefined, providerId), providerId);

      const fingerprint = (b: Record<string, unknown>) =>
        fingerprintCacheProbe({
          instructions: String(b['instructions'] ?? ''),
          tools: b['tools'] as readonly unknown[] | undefined,
          items: (b['input'] as readonly unknown[]) ?? [],
        });

      for (let i = 1; i < bodies.length; i++) {
        const prev = fingerprint(bodies[i - 1] as Record<string, unknown>);
        const cur = fingerprint(bodies[i] as Record<string, unknown>);
        const diff = diffCacheProbe(prev, cur);

        expect(diff.instructionsChanged).toBe(false);
        expect(diff.toolsChanged).toBe(false);
        expect(diff.firstDivergentItem).toBeNull();
        const previousInput = bodies[i - 1]!['input'] as unknown[];
        const currentInput = bodies[i]!['input'] as unknown[];
        expect(currentInput.slice(0, previousInput.length)).toEqual(previousInput);
      }
    },
  );

  it.each(['openai-codex', 'openai-chatgpt'])(
    '%s keeps a per-request volatile middleware block out of the cached prefix',
    async (providerId) => {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
      const bodies = await wireBodies(
        await runSession(tmp, undefined, providerId, true),
        providerId,
      );
      expect(bodies.length).toBe(TURNS * 3);

      // The block must still REACH the model on every request ...
      for (const body of bodies) {
        expect(JSON.stringify(body['input'])).toContain(CHURN_MARKER);
        // ... but never inside `instructions`, which precedes the whole conversation.
        expect(String(body['instructions'] ?? '')).not.toContain(CHURN_MARKER);
      }
      expect(new Set(bodies.map((b) => String(b['instructions'] ?? ''))).size).toBe(1);
      expect(new Set(bodies.map((b) => JSON.stringify(b['tools'] ?? []))).size).toBe(1);
      expect(new Set(bodies.map((b) => String(b['prompt_cache_key'] ?? ''))).size).toBe(1);

      // Every earlier input item survives untouched: the churn only ever appends.
      for (let i = 1; i < bodies.length; i++) {
        const previousInput = bodies[i - 1]?.['input'] as unknown[];
        const currentInput = bodies[i]?.['input'] as unknown[];
        expect(currentInput.slice(0, previousInput.length)).toEqual(previousInput);
      }
    },
  );

  it('keeps the new serialized suffix bounded while the conversation grows', async () => {
    // This bounds changed request characters, not backend uncached tokens or cost.
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
    const bodies = await wireBodies(await runSession(tmp));

    const uncached: number[] = [];
    for (let i = 1; i < bodies.length; i++) {
      const prev = bodies[i - 1] as Record<string, unknown>;
      const cur = bodies[i] as Record<string, unknown>;
      const diff = diffCacheProbe(
        fingerprintCacheProbe({
          instructions: String(prev['instructions'] ?? ''),
          tools: prev['tools'] as readonly unknown[] | undefined,
          items: (prev['input'] as readonly unknown[]) ?? [],
        }),
        fingerprintCacheProbe({
          instructions: String(cur['instructions'] ?? ''),
          tools: cur['tools'] as readonly unknown[] | undefined,
          items: (cur['input'] as readonly unknown[]) ?? [],
        }),
      );
      uncached.push(diff.promptChars - diff.cacheablePrefixChars);
    }

    const early = uncached.slice(0, 3);
    const late = uncached.slice(-3);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Generous bound: this must fail when the uncached remainder starts
    // tracking history size, not when a turn happens to carry more text.
    expect(avg(late)).toBeLessThan(avg(early) * 3);
  });
});
