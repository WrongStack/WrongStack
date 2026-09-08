/**
 * The openai-codex wire has no cache breakpoints: `instructions` + `tools` +
 * the input array form ONE prefix, matched from the front. A block rebuilt per
 * turn anywhere in the first two segments therefore re-bills the third — which,
 * by the time it matters, is the entire conversation. There is no partial
 * credit and no error message; the only symptom is a quota that drains faster
 * than it should.
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
 * The fix is to tag the block volatile (`markVolatileSystemBlock` /
 * `EPOCH_VOLATILE_SOURCES`) so it rides after the conversation, not to relax
 * the assertion.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
import type { Capabilities, Provider, Request, Response } from '@wrongstack/core/types';
import { diffCacheProbe, fingerprintCacheProbe, OpenAICodexProvider } from '@wrongstack/providers';
import { afterEach, describe, expect, it } from 'vitest';

const TURNS = 3;

/** Replays a fixed script and keeps every Request the agent assembled. */
class RecordingProvider implements Provider {
  readonly id = 'openai-codex';
  readonly capabilities: Capabilities = {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: true,
    systemPrompt: true,
    jsonMode: false,
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

async function runSession(tmp: string): Promise<Request[]> {
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

  const provider = new RecordingProvider();
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'gpt-5.4', provider: 'openai-codex' });

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

  const agent = new Agent({
    container,
    tools,
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
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
async function wireBodies(requests: readonly Request[]): Promise<Record<string, unknown>[]> {
  const bodies: string[] = [];
  const sse =
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
    'data: [DONE]\n\n';
  const provider = new OpenAICodexProvider({
    credentials: { accessToken: 'tok' },
    fetchImpl: (async (_url: string, init: { body?: string }) => {
      bodies.push(init.body ?? '');
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
    }) as unknown as typeof fetch,
  });
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

  it('grows the input array by appending, never by rewriting history', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-codex-prefix-'));
    const bodies = await wireBodies(await runSession(tmp));

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
      // The one sanctioned rewrite: the live-context tail rides the trailing
      // message of a request and is absent from the durable history, so the
      // last item of the PREVIOUS request legitimately differs. Anything
      // deeper than that is history being rewritten under the cache.
      if (diff.firstDivergentItem !== null) {
        expect(diff.firstDivergentItem).toBeGreaterThanOrEqual(prev.items.length - 1);
      }
    }
  });

  it('holds the per-request uncached cost flat while the conversation grows', async () => {
    // The real guarantee is not "the prefix matches" but "the part that does
    // not match stops growing" — that is what makes the hit ratio climb toward
    // the cost of one turn instead of tracking the size of the history.
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
