/**
 * Raw mailbox mail is request-scoped: it must reach the model on the next
 * request and never enter the durable conversation.
 *
 * Regression for a prompt-cache breaker seen live (WebUI, MiniMax): mail was
 * folded into the LAST user message — exactly where the previous request
 * closed its cached prefix — and removed again after the response. The
 * removal rewrote that boundary message, so the next request reported a
 * `history` cache breaker and re-wrote the turn's history every time mail
 * arrived.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Capabilities } from '@wrongstack/contracts/types/provider';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { setBtwNote } from '../../src/core/btw.js';
import { Context } from '../../src/core/context.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { getRequestResidency } from '../../src/utils/request-layout.js';
import { MockProvider } from '../helpers/mock-provider.js';

import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

/** Explicit-breakpoint wire, so the live tail rides behind the cache boundary. */
class ExplicitCacheProvider extends MockProvider {
  override readonly capabilities: Capabilities = {
    ...new MockProvider([]).capabilities,
    cacheControl: 'native',
  };
}

/** Automatic-prefix wire (Codex/OpenAI): live context is replayed in place. */
class AutomaticCacheProvider extends MockProvider {
  override readonly capabilities: Capabilities = {
    ...new MockProvider([]).capabilities,
    cacheControl: 'auto',
  };
}

const MAIL = '[MAILBOX BTW] fleet@explore: indexing finished, 0 errors';

async function buildAgent(provider: MockProvider): Promise<{ agent: Agent; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mail-tail-'));
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );
  const tools = new ToolRegistry();
  const events = new EventBus();
  const session = await new DefaultSessionStore({ dir: path.join(tmp, 'sessions') }).create({
    id: '',
    model: 'test-model',
    provider: 'mock',
  });
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
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 5,
    toolExecutor,
  });
  return { agent, tmp };
}

describe('mailbox mail rides the live-context tail', () => {
  let tmpDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tmpDirs)
      await removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 100 });
    tmpDirs = [];
  });

  it.each([
    ['explicit', ExplicitCacheProvider],
    ['automatic', AutomaticCacheProvider],
  ] as const)(
    '%s wire: reaches the model once, never enters history or the replay, keeps the prefix',
    async (_wire, Wire) => {
      const provider = new Wire([
        { content: [{ type: 'text', text: 'first answer' }] },
        { content: [{ type: 'text', text: 'second answer' }] },
      ]);
      const { agent, tmp } = await buildAgent(provider);
      tmpDirs.push(tmp);

      setBtwNote(agent.ctx, MAIL);
      await agent.run('first question');
      await agent.run('second question');

      const [first, second] = provider.receivedRequests;
      expect(JSON.stringify(first?.messages)).toContain('indexing finished');
      // Delivered to exactly one request…
      expect(JSON.stringify(second?.messages)).not.toContain('indexing finished');
      // …and never part of the durable conversation.
      expect(JSON.stringify(agent.ctx.messages)).not.toContain('indexing finished');

      // The first request accounted the mail as its own request-scoped segment.
      // (Checked via the second request's residency below; the first one is
      // the baseline the second is compared against.)
      // The second request reuses the first one's history byte for byte.
      const residency = getRequestResidency(agent.ctx);
      expect(residency?.breakers.map((b) => b.kind)).not.toContain('history');
      expect(residency?.segments.find((s) => s.kind === 'history-prior')?.count).toBeGreaterThan(0);
    },
  );
});
