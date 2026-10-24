import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { installDesignTurnGate } from '../../src/execution/design-turn-gate.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { ExtensionRegistry } from '../../src/extension/registry.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider } from '../helpers/mock-provider.js';
import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

/**
 * The beforeTurnEnd extension point, driven through a real Agent loop with a
 * scripted provider: a guard can hold a turn by returning a steer, the steer
 * reaches the next request, and the loop bounds how often a run is held. The
 * design turn gate is exercised end to end on top of it.
 */

const dirs: string[] = [];
// Session writers hold a file handle; close them before removing the dirs.
const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    await removeProjectFixtureDirectory(d, { maxRetries: 10, retryDelay: 50 });
});

async function buildAgent(
  provider: MockProvider,
  tools: Tool[],
  extensions = new ExtensionRegistry(),
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-turnend-'));
  dirs.push(tmp);
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
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const events = new EventBus();
  const pipelines = createDefaultPipelines();
  const session = await new DefaultSessionStore({ dir: path.join(tmp, 'sessions') }).create({
    id: '',
    model: 'test',
    provider: 'mock',
  });
  sessions.push(session);
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
  const toolExecutor = new ToolExecutor(registry, {
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
    tools: registry,
    providers: new ProviderRegistry(),
    events,
    pipelines,
    context: ctx,
    maxIterations: 12,
    toolExecutor,
    extensions,
  });
  return { agent, ctx, tmp, pipelines, registry, extensions };
}

const text = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
  stopReason: 'end_turn' as const,
});
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  content: [{ type: 'tool_use' as const, id, name, input }],
  stopReason: 'tool_use' as const,
});
const sent = (provider: MockProvider, index: number) =>
  JSON.stringify(provider.receivedRequests[index]?.messages);

describe('beforeTurnEnd extension point', () => {
  it('holds the turn with a steer the next request carries', async () => {
    const provider = new MockProvider([text('Done.'), text('Checked and done.')]);
    const extensions = new ExtensionRegistry();
    let asked = 0;
    extensions.register({
      name: 'guard',
      beforeTurnEnd: () => (asked++ === 0 ? '[guard] check the thing first' : undefined),
    });
    const { agent } = await buildAgent(provider, [], extensions);
    const result = await agent.run('do it');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('Checked and done.');
    expect(provider.calls).toBe(2);
    expect(sent(provider, 1)).toContain('[guard] check the thing first');
  });

  it('lets a run be held at most three times', async () => {
    const provider = new MockProvider([text('1'), text('2'), text('3'), text('4'), text('5')]);
    const extensions = new ExtensionRegistry();
    extensions.register({ name: 'stubborn', beforeTurnEnd: () => '[stubborn] not yet' });
    const { agent } = await buildAgent(provider, [], extensions);
    const result = await agent.run('do it');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(4);
    expect(result.finalText).toBe('4');
  });

  it('treats a throwing guard as permission to end', async () => {
    const provider = new MockProvider([text('Done.')]);
    const extensions = new ExtensionRegistry();
    extensions.register({
      name: 'broken',
      beforeTurnEnd: () => {
        throw new Error('boom');
      },
    });
    const { agent } = await buildAgent(provider, [], extensions);
    expect((await agent.run('do it')).status).toBe('done');
    expect(provider.calls).toBe(1);
  });
});

describe('design turn gate', () => {
  const write: Tool = {
    name: 'write',
    description: 'write a file',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: true,
    async execute() {
      return 'written';
    },
  };
  /** Stands in for design_reference: replies with the scripted report header. */
  function inspectTool(reports: string[]): Tool {
    return {
      name: 'design_reference',
      description: 'inspect',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return reports.shift() ?? 'Surface: page · viewports 1440px · 0 FAIL · 0 WARN';
      },
    };
  }

  async function gated(provider: MockProvider, tools: Tool[], gateJson?: object) {
    const built = await buildAgent(provider, tools);
    installDesignTurnGate({
      pipelines: built.pipelines,
      extensions: built.extensions,
      hasTool: (name) => built.registry.get(name) !== undefined,
    });
    if (gateJson) {
      await fs.mkdir(path.join(built.tmp, '.design'), { recursive: true });
      await fs.writeFile(path.join(built.tmp, '.design', 'gate.json'), JSON.stringify(gateJson));
    }
    return built;
  }

  it('holds an uninspected UI change, then a failing inspect, and releases on 0 FAIL', async () => {
    const url = 'http://localhost:5173/';
    const provider = new MockProvider([
      call('w1', 'write', { path: 'src/App.tsx', content: 'x' }),
      text('UI done.'),
      call('i1', 'design_reference', { action: 'inspect', url }),
      text('Inspected.'),
      call('i2', 'design_reference', { action: 'inspect', url }),
      text('Fixed and inspected.'),
    ]);
    const reports = [
      'Surface: page · viewports 1440px · 2 FAIL · 1 WARN',
      'Surface: page · viewports 1440px · 0 FAIL · 1 WARN',
    ];
    const { agent } = await gated(provider, [write, inspectTool(reports)], { url });
    const result = await agent.run('build the page');
    expect(result.finalText).toBe('Fixed and inspected.');
    expect(provider.calls).toBe(6);
    expect(sent(provider, 2)).toContain('[design-gate] You changed UI file(s) (src/App.tsx)');
    expect(sent(provider, 4)).toContain('still reports 2 FAIL');
  });

  it('stays silent without a known URL, for non-UI files, and when inspect is unavailable', async () => {
    const noUrl = new MockProvider([call('w1', 'write', { path: 'src/App.tsx' }), text('Done.')]);
    await (await gated(noUrl, [write, inspectTool([])])).agent.run('build');
    expect(noUrl.calls).toBe(2);

    const backend = new MockProvider([
      call('w1', 'write', { path: 'src/server.go' }),
      text('Done.'),
    ]);
    await (
      await gated(backend, [write, inspectTool([])], { url: 'http://localhost:3000/' })
    ).agent.run('x');
    expect(backend.calls).toBe(2);

    const noTool = new MockProvider([call('w1', 'write', { path: 'src/App.tsx' }), text('Done.')]);
    await (await gated(noTool, [write], { url: 'http://localhost:3000/' })).agent.run('x');
    expect(noTool.calls).toBe(2);
  });

  it('holds a static page with no URL known and points the inspect at the file', async () => {
    const provider = new MockProvider([
      call('w1', 'write', { path: 'site/index.html', content: '<h1>x</h1>' }),
      text('Page written.'),
      call('i1', 'design_reference', { action: 'inspect', file: 'site/index.html' }),
      text('Inspected the page.'),
    ]);
    const { agent } = await gated(provider, [write, inspectTool([])]);
    const result = await agent.run('build the page');
    expect(result.finalText).toBe('Inspected the page.');
    expect(provider.calls).toBe(4);
    // The sent payload is JSON, so the steer's quotes arrive escaped.
    expect(sent(provider, 2)).toContain(
      'design_reference {action:\\"inspect\\", file:\\"site/index.html\\"}',
    );
    expect(sent(provider, 2)).toContain('no dev server is needed');
  });

  it('can be switched off per project', async () => {
    const provider = new MockProvider([
      call('w1', 'write', { path: 'src/App.tsx' }),
      text('Done.'),
    ]);
    const { agent } = await gated(provider, [write, inspectTool([])], {
      mode: 'off',
      url: 'http://localhost:5173/',
    });
    await agent.run('build');
    expect(provider.calls).toBe(2);
  });
});
