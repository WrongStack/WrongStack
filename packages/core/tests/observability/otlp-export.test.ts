/**
 * `observability.otlp`: when export turns on, and what a turn looks like at
 * the collector — one trace with the turn as its root and the provider and
 * tool calls under it, sent as soon as the turn ends.
 */
import * as fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { InMemoryMetricsSink } from '../../src/observability/metrics.js';
import { startOtlpExport } from '../../src/observability/otlp-setup.js';
import { startOtlpTraceExporter } from '../../src/observability/otlp-traces.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider } from '../helpers/mock-provider.js';

import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function collector(): Promise<{
  endpoint: string;
  spans: WireSpan[];
  requests: Array<{ path: string; headers: Record<string, unknown> }>;
}> {
  const spans: WireSpan[] = [];
  const requests: Array<{ path: string; headers: Record<string, unknown> }> = [];
  const server: Server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url ?? '', headers: req.headers });
    if (req.url === '/v1/traces') {
      const parsed = JSON.parse(body) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
      };
      for (const rs of parsed.resourceSpans)
        for (const ss of rs.scopeSpans) spans.push(...ss.spans);
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, spans, requests };
}

const attr = (span: WireSpan, key: string) =>
  span.attributes.find((a) => a.key === key)?.value['stringValue'];

describe('span nesting', () => {
  it('nests a turn’s calls under it, and a subagent run under the leader turn', async () => {
    const sent: Array<{ name: string; traceId: string; spanId: string; parentSpanId?: string }> =
      [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: typeof sent }> }>;
      };
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) sent.push(...ss.spans);
      return new Response('{}', { status: 200 });
    });
    const exp = startOtlpTraceExporter({ endpoint: 'http://x', fetchImpl: fetchImpl as never });
    const t = exp.tracer;
    const leader = t.startSpan('agent.run', { 'session.id': 's1' });
    t.startSpan('provider.complete', { 'session.id': 's1' }).end();
    const worker = t.startSpan('agent.run', { 'session.id': 's1', 'agent.session.id': 'w1' });
    t.startSpan('tool.read', { 'session.id': 's1', 'agent.session.id': 'w1' }).end();
    worker.end();
    t.startSpan('tool.grep', { 'session.id': 's2' }).end();
    t.startSpan('tool.bash').end();
    leader.end();
    await exp.stop();

    const one = (name: string) => sent.find((s) => s.name === name);
    const root = sent.find((s) => s.name === 'agent.run' && !s.parentSpanId);
    const sub = sent.find((s) => s.name === 'agent.run' && s.parentSpanId);
    expect(root).toBeDefined();
    expect(one('provider.complete')?.parentSpanId).toBe(root?.spanId);
    expect(sub?.parentSpanId).toBe(root?.spanId);
    expect(one('tool.read')?.parentSpanId).toBe(sub?.spanId);
    for (const span of [one('provider.complete'), sub, one('tool.read')]) {
      expect(span?.traceId).toBe(root?.traceId);
    }
    // Another tab's call and an unattributed span are traces of their own.
    expect(one('tool.grep')?.parentSpanId).toBeUndefined();
    expect(one('tool.bash')?.parentSpanId).toBeUndefined();
    expect(one('tool.grep')?.traceId).not.toBe(root?.traceId);
  });
});

describe('a real turn at the collector', () => {
  it('arrives as one trace, pushed when the turn ends', async () => {
    const otel = await collector();
    const exporter = startOtlpExport({ otlp: { endpoint: otel.endpoint } }, { env: {} });
    if (!exporter?.tracer) throw new Error('exporter did not start');
    cleanups.push(() => exporter.stop());
    const sink = new InMemoryMetricsSink();
    sink.counter('agent.runs.total');
    exporter.exportMetrics(sink);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-otlp-'));
    cleanups.push(() => removeProjectFixtureDirectory(tmp, { maxRetries: 5, retryDelay: 100 }));
    const container = new Container();
    container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
    container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
    container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
    container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
    container.bind(
      TOKENS.PermissionPolicy,
      () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
    );
    const echo: Tool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      execute: async () => 'echoed',
    };
    const tools = new ToolRegistry();
    tools.register(echo);
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'call-1', name: 'echo', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const events = new EventBus();
    const store = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
    cleanups.push(() => store.dispose());
    const session = await store.create({ id: '', model: 'm', provider: 'mock' });
    const context = new Context({
      systemPrompt: [{ type: 'text', text: 'test agent' }],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter: container.resolve(TOKENS.TokenCounter),
      cwd: tmp,
      projectRoot: tmp,
      model: 'm',
    });
    const agent = new Agent({
      container,
      tools,
      providers: new ProviderRegistry(),
      events,
      pipelines: createDefaultPipelines(),
      context,
      maxIterations: 5,
      tracer: exporter.tracer,
      toolExecutor: new ToolExecutor(tools, {
        permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
        secretScrubber: container.resolve(TOKENS.SecretScrubber),
        events,
        confirmAwaiter: undefined,
        iterationTimeoutMs: 60_000,
        perIterationOutputCapBytes: 100_000,
        tracer: exporter.tracer,
      }),
    });

    expect((await agent.run('use echo')).status).toBe('done');
    // No flush() and no timer tick: the finished turn goes out by itself.
    await vi.waitFor(() => expect(otel.spans.some((s) => s.name === 'agent.run')).toBe(true), {
      timeout: 3000,
    });

    const run = otel.spans.find((s) => s.name === 'agent.run');
    const providerCalls = otel.spans.filter((s) => s.name === 'provider.complete');
    const toolCall = otel.spans.find((s) => s.name === 'tool.echo');
    expect(providerCalls).toHaveLength(2);
    expect(toolCall).toBeDefined();
    for (const span of [...providerCalls, toolCall]) {
      expect(span?.traceId).toBe(run?.traceId);
      expect(span?.parentSpanId).toBe(run?.spanId);
    }
    expect(attr(run as WireSpan, 'session.id')).toBe(session.id);
    // Metrics leave with the turn too, not only on their 30 s timer.
    await vi.waitFor(() => expect(otel.requests.map((r) => r.path)).toContain('/v1/metrics'), {
      timeout: 3000,
    });
  });
});

describe('startOtlpExport', () => {
  const quiet = { info: vi.fn(), warn: vi.fn() };

  it('stays off unless the config asks, whatever the environment says', () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' };
    expect(startOtlpExport(undefined, { env })).toBeUndefined();
    expect(startOtlpExport({}, { env })).toBeUndefined();
    expect(startOtlpExport({ otlp: {} }, { env })).toBeUndefined();
    expect(startOtlpExport({ otlp: { endpoint: 'http://a', enabled: false } }, { env })).toBe(
      undefined,
    );
    expect(
      startOtlpExport({ otlp: { endpoint: 'http://a' } }, { env: { OTEL_SDK_DISABLED: 'true' } }),
    ).toBeUndefined();
  });

  it('takes the endpoint and headers from OTEL_* when the config enables export', async () => {
    const otel = await collector();
    const handle = startOtlpExport(
      { otlp: { enabled: true, headers: { 'x-team': 'mine' }, metrics: false } },
      {
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: otel.endpoint,
          OTEL_EXPORTER_OTLP_HEADERS: 'x-team=theirs,x-key=a%20b',
          OTEL_SERVICE_NAME: 'svc',
        },
      },
    );
    if (!handle?.tracer) throw new Error('not started');
    expect(handle.wantsMetrics).toBe(false);
    handle.tracer.startSpan('agent.run').end();
    await handle.stop();
    expect(otel.requests.at(-1)).toMatchObject({
      path: '/v1/traces',
      headers: { 'x-team': 'mine', 'x-key': 'a b' },
    });
  });

  it('warns about a bad endpoint instead of failing, and about the first failed push only', async () => {
    const warn = vi.fn();
    expect(
      startOtlpExport(
        { otlp: { endpoint: 'file:///tmp/x' } },
        { env: {}, logger: { ...quiet, warn } },
      ),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/must be http\(s\)/));

    warn.mockClear();
    const handle = startOtlpExport(
      { otlp: { endpoint: 'http://127.0.0.1:1' } },
      {
        env: {},
        logger: { ...quiet, warn },
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as never,
      },
    );
    handle?.tracer?.startSpan('agent.run').end();
    handle?.tracer?.startSpan('agent.run').end();
    await handle?.stop();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/OTLP export to .* failed: fetch failed/),
    );
  });
});
