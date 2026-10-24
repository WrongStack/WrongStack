/**
 * A tool call made from inside another tool (`ctx.nestedToolCall`, what
 * `tool_script` uses) goes through the same gate as one the model made:
 * permission, confirmation, the `tool.executed` event and the journal.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { NextFn } from '@wrongstack/contracts/kernel/pipeline';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { NestedToolCallResult } from '@wrongstack/contracts/types/context';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { globTool } from '../../../tools/src/glob.js';
import { grepTool } from '../../../tools/src/grep.js';
import { readTool } from '../../../tools/src/read.js';
import { toolScriptTool } from '../../../tools/src/tool-script.js';
import { toolSearchTool } from '../../../tools/src/tool-search.js';
import { toolUseTool } from '../../../tools/src/tool-use.js';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import type { ToolCallPipelinePayload } from '../../src/core/agent-types.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { wstackGlobalRoot } from '../../src/utils/wstack-paths.js';
import { MockProvider } from '../helpers/mock-provider.js';

import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

const dirs: string[] = [];
const spoolFiles: string[] = [];
afterEach(async () => {
  for (const file of spoolFiles.splice(0)) await fs.rm(file, { force: true });
  for (const dir of dirs.splice(0))
    await removeProjectFixtureDirectory(dir, { maxRetries: 10, retryDelay: 50 });
});

const ran: string[] = [];

function tool(name: string, permission: Tool['permission']): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    permission,
    mutating: false,
    async execute() {
      ran.push(name);
      return `${name} ran`;
    },
  };
}

/** Calls `risky` then `echo` through the nested gate and reports both. */
const composer: Tool = {
  name: 'composer',
  description: '',
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute(_input, ctx, opts) {
    const call = ctx.nestedToolCall;
    if (!call) throw new Error('no gate');
    const results: NestedToolCallResult[] = [];
    let index = 0;
    for (const name of ['risky', 'echo']) {
      index += 1;
      results.push(await call({ name, input: {}, parentToolUseId: opts.toolUseId ?? 'x', index }));
    }
    return JSON.stringify(results);
  },
};

async function buildAgent(
  provider: MockProvider,
  extraTools: Tool[] = [],
  limits: { maxIterations?: number; outputCapBytes?: number } = {},
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-nested-'));
  dirs.push(tmp);
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: false }),
  );
  const registry = new ToolRegistry();
  for (const t of [tool('echo', 'auto'), tool('risky', 'confirm'), composer, ...extraTools])
    registry.register(t);
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });
  const append = vi.spyOn(session, 'append');
  const appendBatch = vi.spyOn(session, 'appendBatch');
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'test' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });
  const pipelines = createDefaultPipelines();
  const agent = new Agent({
    container,
    tools: registry,
    providers: new ProviderRegistry(),
    events,
    pipelines,
    context: ctx,
    maxIterations: limits.maxIterations ?? 10,
    toolExecutor: new ToolExecutor(registry, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: limits.outputCapBytes ?? 100_000,
      tracer: undefined,
    }),
  });
  const journal = () =>
    [...append.mock.calls.map(([e]) => e), ...appendBatch.mock.calls.flatMap(([batch]) => batch)]
      .filter((e) => e.type === 'tool_use' || e.type === 'tool_result')
      .map((e) => ({
        type: e.type,
        id: (e as { id: string }).id,
        ...(e.type === 'tool_result'
          ? { settlement: (e as { settlement?: string }).settlement }
          : {}),
      }));
  return { agent, events, ctx, journal, registry, pipelines };
}

const turn = {
  content: [{ type: 'tool_use' as const, id: 'u-comp', name: 'composer', input: {} }],
  stopReason: 'tool_use' as const,
};
const done = { content: [{ type: 'text' as const, text: 'ok' }], stopReason: 'end_turn' as const };

describe('a tool call made from inside a tool', () => {
  it('refuses declined, invalid and unsupported structured requests without executing their bodies', async () => {
    const execute = vi.fn(async () => ({ count: 1 }));
    const structured: Tool = {
      ...tool('structured', 'confirm'),
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
      },
      outputSchema: { type: 'object' },
      execute,
    };
    const unsupported = { ...tool('legacy', 'auto'), execute };
    const script = `let refused = 0; for (const [name, input] of [['structured', {}], ['structured', {count: 1}], ['legacy', {}]]) {
      try { await tools.data(name, input); } catch { refused++; }
    } return { refused };`;
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'data-refusals', name: 'tool_script', input: { script } },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, events } = await buildAgent(provider, [
      structured,
      unsupported,
      toolScriptTool,
    ]);
    events.on('tool.confirm_needed', (event) => event.resolve('no'));
    await agent.run('Check refusals');
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(ctx.messages)).toContain('refused');
    expect(JSON.stringify(ctx.messages)).toContain('3');
  });

  it('does not retry a mutation whose declared output contract fails', async () => {
    const execute = vi.fn(async () => ({ count: 'invalid' }));
    const structured: Tool = {
      ...tool('structured', 'auto'),
      mutating: true,
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
      execute,
    };
    const script = `try { await tools.data('structured', {}); } catch (error) { return error.message; }`;
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'data-invalid-output', name: 'tool_script', input: { script } },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, events } = await buildAgent(provider, [structured, toolScriptTool]);
    events.on('tool.confirm_needed', (event) => event.resolve('yes'));
    await agent.run('Run once');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ctx.messages)).toContain('outputSchema');
  });
  it('reads actual file JSON and search metadata through structured ToolFlow without parsing display headers', async () => {
    const script = `
      const file = await tools.data('read', { path: 'package.json' });
      if (file.truncated || file.raw_text === undefined) throw new Error('not full content');
      const manifest = JSON.parse(file.raw_text);
      const listing = await tools.data('glob', { pattern: '*.json' });
      const matches = await tools.data('grep', { pattern: 'fixture-root', path: 'package.json' });
      return { name: manifest.name, files: listing.files.length, hits: matches.count };
    `;
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'structured-files', name: 'tool_script', input: { script } },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, journal } = await buildAgent(provider, [
      readTool,
      globTool,
      grepTool,
      toolScriptTool,
    ]);
    await fs.writeFile(
      path.join(ctx.cwd, 'package.json'),
      JSON.stringify({ name: 'fixture-root', details: 'RAW_PRIVATE_DETAILS' }),
    );
    await agent.run('Inspect manifest');
    const output = ctx.messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === 'tool_result');
    expect(output).toHaveLength(1);
    expect(output[0]?.content).toContain('"name": "fixture-root"');
    expect(output[0]?.content).toContain('"files": 1');
    expect(output[0]?.content).toContain('"hits": 1');
    expect(output[0]?.content).not.toContain('RAW_PRIVATE_DETAILS');
    expect(journal().filter((event) => event.type === 'tool_result')).toHaveLength(4);
  });

  it('keeps confirmation, redaction and journal behavior on structured nested calls', async () => {
    const execute = vi.fn(async () => ({ count: 7, secret: 'sk-' + 'X'.repeat(40) }));
    const structured: Tool = {
      ...tool('structured', 'confirm'),
      outputSchema: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer' }, secret: { type: 'string' } },
      },
      execute,
    };
    const script = `const result = await tools.data('structured', {}); return { count: result.count, redacted: !result.secret.includes('XXXX') };`;
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'structured-confirm', name: 'tool_script', input: { script } },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, events, journal } = await buildAgent(provider, [
      structured,
      toolScriptTool,
    ]);
    events.on('tool.confirm_needed', (event) => event.resolve('yes'));
    await agent.run('Inspect structured value');
    expect(execute).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(ctx.messages);
    expect(serialized).toContain('redacted');
    expect(serialized).toContain('true');
    expect(serialized).not.toContain('X'.repeat(40));
    expect(
      journal().find((event) => event.id === 'structured-confirm~1' && event.type === 'tool_result')
        ?.settlement,
    ).toBe('completed');
  });

  it('refuses structured access after a content-changing result policy without re-executing the tool', async () => {
    const execute = vi.fn(async () => ({ privateValue: 'not-for-programs' }));
    const structured: Tool = {
      ...tool('structured', 'auto'),
      outputSchema: { type: 'object' },
      execute,
    };
    const script = `try { await tools.data('structured', {}); return 'leaked'; } catch (error) { return error.message; }`;
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'structured-policy', name: 'tool_script', input: { script } },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, pipelines } = await buildAgent(provider, [structured, toolScriptTool]);
    pipelines.toolCall.use({
      name: 'redact-result',
      async handler(input: ToolCallPipelinePayload, next: NextFn<ToolCallPipelinePayload>) {
        if (input.toolUse.name === 'structured') input.result.content = '[redacted by policy]';
        return next(input);
      },
    });
    await agent.run('Inspect result');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ctx.messages)).toContain('unavailable after result policies');
    expect(JSON.stringify(ctx.messages)).not.toContain('not-for-programs');
  });
  it('compares sequential, batched, direct, deferred, discovered and passthrough ToolFlow contributions', async () => {
    const fixture: Tool<{ id: number }, string> = {
      name: 'fixture_read',
      description: 'Read a fixture',
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      async execute(input) {
        return JSON.stringify({ id: input.id, detail: 'RAW_DETAIL_'.repeat(1000) });
      },
    };
    const uses = Array.from({ length: 50 }, (_, id) => ({
      type: 'tool_use' as const,
      id: `fixture-${id}`,
      name: 'fixture_read',
      input: { id },
    }));
    const script = `let sum = 0; for (let start = 0; start < 50; start += 5) {
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => tools.fixture_read({ id: start + i })));
      for (const result of results) sum += JSON.parse(result).id;
    } return { count: 50, sum };`;
    const passthrough = `const results = []; for (let start = 0; start < 50; start += 5) {
      results.push(...await Promise.all(Array.from({ length: 5 }, (_, i) => tools.fixture_read({ id: start + i }))));
    } return results.map(text => JSON.parse(text));`;
    const flow = { type: 'tool_use' as const, id: 'flow', name: 'tool_script', input: { script } };
    const deferred = {
      ...flow,
      name: 'tool_use',
      input: { tool: 'tool_script', input: { script } },
    };
    const toolTurn = (content: ToolUseBlock[]) => ({ content, stopReason: 'tool_use' as const });
    const scenarios = [
      { name: 'sequential', turns: uses.map((use) => toolTurn([use])) },
      { name: 'batched', turns: [toolTurn(uses)] },
      { name: 'toolflow', turns: [toolTurn([flow])] },
      { name: 'deferred', turns: [toolTurn([deferred])] },
      {
        name: 'discovered',
        turns: [
          toolTurn([
            { type: 'tool_use', id: 'discover', name: 'tool_search', input: { query: 'ToolFlow' } },
          ]),
          toolTurn([deferred]),
        ],
      },
      { name: 'passthrough', turns: [toolTurn([{ ...flow, input: { script: passthrough } }])] },
    ];
    const measurements: Array<{
      scenario: string;
      providerRequests: number;
      fixtureReads: number;
      conversationResults: number;
      toolResultBytes: number;
      journaledResults: number;
      scriptProducedBytes: number | null;
    }> = [];
    for (const scenario of scenarios) {
      const provider = new MockProvider([...scenario.turns, done]);
      provider.capabilities.maxContext = 2_000_000;
      let scriptProducedBytes: number | null = null;
      const measuredScript = {
        ...toolScriptTool,
        async execute(...args: Parameters<typeof toolScriptTool.execute>) {
          const result = await toolScriptTool.execute(...args);
          scriptProducedBytes = Buffer.byteLength(result);
          return result;
        },
      };
      const { agent, ctx, events, journal } = await buildAgent(
        provider,
        [fixture, measuredScript, toolUseTool, toolSearchTool],
        { maxIterations: 100, outputCapBytes: 2_000_000 },
      );
      let fixtureReads = 0;
      events.on('tool.confirm_needed', (e) => e.resolve('yes'));
      events.on('tool.executed', (e) => {
        if (e.name === 'fixture_read') fixtureReads++;
      });
      await agent.run('Summarize the fixture IDs');
      const results = ctx.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === 'tool_result');
      if (scenario.name === 'passthrough') {
        const preview = String((results[0] as { content: string }).content);
        const artifact = /\[full tool output: \d+ bytes at (.+?); read\/grep/.exec(preview)?.[1];
        expect(artifact).toBeDefined();
        expect(path.dirname(path.resolve(artifact!))).toBe(
          path.resolve(wstackGlobalRoot(), 'tool-output'),
        );
        spoolFiles.push(artifact!);
        expect((await fs.stat(artifact!)).size).toBe(scriptProducedBytes);
      }
      expect(results.every((result) => !('is_error' in result) || !result.is_error)).toBe(true);
      expect(fixtureReads).toBe(50);
      if (['toolflow', 'deferred', 'discovered'].includes(scenario.name)) {
        const reduced = String((results.at(-1) as { content: string }).content);
        expect(reduced).toContain('1225');
        expect(reduced).not.toContain('RAW_DETAIL');
      }
      measurements.push({
        scenario: scenario.name,
        providerRequests: provider.calls,
        fixtureReads,
        conversationResults: results.length,
        toolResultBytes: results.reduce(
          (sum, result) => sum + Buffer.byteLength(String((result as { content: string }).content)),
          0,
        ),
        journaledResults: journal().filter((event) => event.type === 'tool_result').length,
        scriptProducedBytes,
      });
    }
    const [sequential, batched, direct, deferredResult, discovered, raw] = measurements;
    expect(sequential?.providerRequests).toBe(51);
    expect(batched?.providerRequests).toBe(2);
    expect(direct?.providerRequests).toBe(2);
    expect(deferredResult?.providerRequests).toBe(2);
    expect(discovered?.providerRequests).toBe(3);
    expect(sequential?.toolResultBytes).toBe(batched?.toolResultBytes);
    expect(batched?.toolResultBytes).toBeGreaterThan(500_000);
    expect(direct?.toolResultBytes).toBeLessThan(150);
    expect(deferredResult?.toolResultBytes).toBeLessThan(400);
    expect(discovered?.toolResultBytes).toBeLessThan(batched!.toolResultBytes / 10);
    // Returning raw data is not reduction: the normal executor spools the
    // oversized result and sends a preview, which is not the computed answer.
    expect(raw!.scriptProducedBytes).toBeGreaterThan(batched!.toolResultBytes);
    expect(raw!.toolResultBytes).toBeGreaterThan(direct!.toolResultBytes * 10);
    expect(raw!.scriptProducedBytes).toBeGreaterThan(raw!.toolResultBytes);
    if (process.env['WRONGSTACK_TOOLFLOW_REPORT'] === '1') {
      const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
      const reportDir = path.join(repoRoot, '.reports/toolflow');
      await fs.mkdir(reportDir, { recursive: true });
      const report = {
        schemaVersion: 1,
        generatedAtUTC: new Date().toISOString(),
        method:
          'Real Agent/ToolExecutor with a scripted provider; no live model, timing, tokens or billing measurements',
        configuration: {
          fixtureReads: 50,
          rawDetailCharactersPerRead: 11000,
          outputCapBytes: 2000000,
          maxContext: 2000000,
        },
        measurements,
      };
      await fs.writeFile(
        path.join(reportDir, 'contribution.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      await fs.writeFile(
        path.join(repoRoot, 'website/src/data/toolflow-contribution.json'),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      await fs.writeFile(
        path.join(reportDir, 'contribution.md'),
        `# ToolFlow contribution fixture\n\n${report.method}.\n\n| Scenario | Provider requests | Fixture reads | Context result blocks | Context result bytes | Journaled results | Script bytes before executor |\n|---|---:|---:|---:|---:|---:|---:|\n${measurements.map((row) => `| ${row.scenario} | ${row.providerRequests} | ${row.fixtureReads} | ${row.conversationResults} | ${row.toolResultBytes} | ${row.journaledResults} | ${row.scriptProducedBytes ?? '—'} |`).join('\n')}\n\nCounts include the final answer request. Byte counts include result wrappers and ToolFlow diagnostics, but exclude prompts, tool schemas, inputs, transport framing and journal storage. Discovery adds a schema result and a provider request. Passthrough returns raw data; the normal executor spools it and sends a preview, not a computed answer. Its preview bytes can vary with the temporary artifact path. Deferred envelope bytes can vary with executionMs.\n`,
      );
    }
  }, 30_000);

  it('summarizes real manifest files through the built-in read tool', async () => {
    const script = `const paths = ['package.json', 'packages/tools/package.json'];
      const findings = await Promise.all(paths.map(async path => {
        try {
          const text = await tools.read({ path });
          const numbered = text.split(/\\r?\\n/).filter(line => /^\\d+→/.test(line));
          if (!numbered.length || /\\btruncated=true\\b/.test(text.split('\\n')[0])) throw new Error('Incomplete file');
          const manifest = JSON.parse(numbered.map(line => line.replace(/^\\d+→/, '')).join('\\n'));
          return { path, name: manifest.name, version: manifest.version };
        } catch (error) { return { path, error: error.message }; }
      })); return findings;`;
    const provider = new MockProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'manifests',
            name: 'tool_script',
            input: { description: 'Summarize package versions', script },
          },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx } = await buildAgent(provider, [readTool, toolScriptTool]);
    await fs.mkdir(path.join(ctx.cwd, 'packages', 'tools'), { recursive: true });
    await fs.writeFile(
      path.join(ctx.cwd, 'package.json'),
      JSON.stringify({ name: 'fixture-root', version: '1.2.3', private: true }),
    );
    await fs.writeFile(
      path.join(ctx.cwd, 'packages', 'tools', 'package.json'),
      JSON.stringify({
        name: 'fixture-tools',
        version: '4.5.6',
        scripts: { test: 'large raw fixture metadata' },
      }),
    );
    await agent.run('Summarize package versions');
    const results = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(1);
    const output = String((results[0] as { content: string }).content);
    expect(output).toContain('fixture-root');
    expect(output).toContain('1.2.3');
    expect(output).toContain('fixture-tools');
    expect(output).toContain('4.5.6');
    expect(output).not.toContain('large raw fixture metadata');
    expect(output).not.toContain('"error"');
  });
  it('ToolFlow cannot discover or execute a user-disabled tool', async () => {
    ran.length = 0;
    const script = `if (tools.names().includes('echo')) throw new Error('disabled tool leaked');
      try { await tools.call('echo', {}); } catch { return 'disabled call refused'; }
      throw new Error('disabled tool ran');`;
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'flow-disabled', name: 'tool_script', input: { script } },
        ],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, registry } = await buildAgent(provider, [toolScriptTool]);
    registry.disable('echo', 'user');
    await agent.run('go');
    expect(ran).toEqual([]);
    const results = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    expect(String((results[0] as { content: string }).content)).toContain('disabled call refused');
  });
  it.each(['tool_script', 'tool_use'])(
    'ToolFlow through %s reduces 50 gated results to one conversation result',
    async (route) => {
      const fixture: Tool<{ id: number }, string> = {
        name: 'fixture_read',
        description: 'Read a fixture',
        permission: 'auto',
        mutating: false,
        inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        async execute(input) {
          return JSON.stringify({ id: input.id, detail: 'RAW_DETAIL_'.repeat(1000) });
        },
      };
      const script = `let sum = 0;
      for (let start = 0; start < 50; start += 5) {
        const results = await Promise.all(Array.from({ length: 5 }, (_, i) => tools.fixture_read({ id: start + i })));
        for (const result of results) sum += JSON.parse(result).id;
      }
      return { count: 50, sum };`;
      const use = {
        type: 'tool_use' as const,
        id: 'flow-1',
        name: route,
        input: route === 'tool_script' ? { script } : { tool: 'tool_script', input: { script } },
      };
      const provider = new MockProvider([{ content: [use], stopReason: 'tool_use' }, done]);
      const { agent, ctx, events, journal } = await buildAgent(provider, [
        toolScriptTool,
        toolUseTool,
        fixture,
      ]);
      events.on('tool.confirm_needed', (e) => e.resolve('yes'));
      const executed: string[] = [];
      events.on('tool.executed', (e) => executed.push(e.name));
      await agent.run('Summarize all fixture IDs with ToolFlow');
      const results = ctx.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b.type === 'tool_result');
      expect(results).toHaveLength(1);
      const output = String((results[0] as { content: string }).content);
      expect(output).toContain('1225');
      expect(output).toContain('ToolFlow bytes:');
      expect(output).not.toContain('RAW_DETAIL');
      expect(output.length).toBeLessThan(400);
      expect(executed.filter((name) => name === 'fixture_read')).toHaveLength(50);
      // tool_use runs its target through the same gate, so the script is
      // journaled as a call of its own (`flow-1~1`) next to its 50 calls.
      expect(journal().filter((e) => e.type === 'tool_result')).toHaveLength(
        route === 'tool_use' ? 52 : 51,
      );
    },
  );

  it('ToolFlow preserves schema validation and a declined confirmation', async () => {
    ran.length = 0;
    const strictRead: Tool = {
      ...tool('strict_read', 'auto'),
      inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    };
    const script = `const failures = [];
      for (const name of ['strict_read', 'risky']) {
        try { await tools.call(name, {}); } catch (e) { failures.push(name); }
      }
      return failures;`;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'flow-denied', name: 'tool_script', input: { script } }],
        stopReason: 'tool_use',
      },
      done,
    ]);
    const { agent, ctx, events } = await buildAgent(provider, [toolScriptTool, strictRead]);
    const asked: string[] = [];
    events.on('tool.confirm_needed', (e) => {
      asked.push(e.toolUseId);
      e.resolve('no');
    });
    await agent.run('go');
    expect(asked).toEqual(['flow-denied~2']);
    expect(ran).toEqual([]);
    const results = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(String((results[0] as { content: string }).content)).toContain('(2 failed)');
  });

  it('is confirmed, reported and journaled like a direct call', async () => {
    ran.length = 0;
    const provider = new MockProvider([turn, done]);
    const { agent, events, journal, ctx } = await buildAgent(provider);
    const asked: string[] = [];
    events.on('tool.confirm_needed', (e) => {
      asked.push(e.toolUseId);
      e.resolve('no');
    });
    const executed: Array<{ id?: string | undefined; settlement?: string | undefined }> = [];
    events.on('tool.executed', (e) => executed.push({ id: e.id, settlement: e.settlement }));

    await agent.run('go');

    // `risky` needed a confirmation and was refused; it never ran.
    expect(asked).toEqual(['u-comp~1']);
    expect(ran).toEqual(['echo']);
    expect(executed).toEqual(
      expect.arrayContaining([
        { id: 'u-comp~1', settlement: 'declined' },
        { id: 'u-comp~2', settlement: 'completed' },
        { id: 'u-comp', settlement: 'completed' },
      ]),
    );
    expect(journal()).toEqual(
      expect.arrayContaining([
        { type: 'tool_use', id: 'u-comp~1' },
        { type: 'tool_result', id: 'u-comp~1', settlement: 'declined' },
        { type: 'tool_use', id: 'u-comp~2' },
        { type: 'tool_result', id: 'u-comp~2', settlement: 'completed' },
      ]),
    );
    // The composer got the refusal as a failed result, not a silent success.
    const result = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 'u-comp');
    const reported = JSON.parse(String((result as { content: string }).content)) as Array<{
      isError: boolean;
      content: string;
    }>;
    expect(reported[0]).toMatchObject({
      isError: true,
      content: expect.stringContaining('denied'),
    });
    expect(reported[1]).toEqual({ isError: false, content: 'echo ran' });
    // Only the composer's own result reached the conversation.
    const ids = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(ids).toEqual(['u-comp']);
  });

  it('runs a confirmed call once it is approved', async () => {
    ran.length = 0;
    const { agent, events } = await buildAgent(new MockProvider([turn, done]));
    events.on('tool.confirm_needed', (e) => e.resolve('yes'));
    await agent.run('go');
    expect(ran).toEqual(['risky', 'echo']);
  });

  // #409: a confirm tool reached through tool_use (the route for a tool the
  // token-saving tier withheld) was refused with "call it directly".
  it('asks for and runs a confirm tool reached through tool_use', async () => {
    ran.length = 0;
    const viaToolUse = {
      content: [
        {
          type: 'tool_use' as const,
          id: 'u-use',
          name: 'tool_use',
          input: { tool: 'risky', input: {} },
        },
      ],
      stopReason: 'tool_use' as const,
    };
    const { agent, events, ctx, journal } = await buildAgent(new MockProvider([viaToolUse, done]), [
      toolUseTool,
    ]);
    const asked: string[] = [];
    events.on('tool.confirm_needed', (e) => {
      asked.push(e.toolUseId);
      e.resolve('yes');
    });

    await agent.run('go');

    expect(asked).toContain('u-use~1');
    expect(ran).toEqual(['risky']);
    expect(journal()).toEqual(
      expect.arrayContaining([
        { type: 'tool_use', id: 'u-use~1' },
        { type: 'tool_result', id: 'u-use~1', settlement: 'completed' },
      ]),
    );
    const result = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 'u-use') as
      | { content: string; is_error?: boolean }
      | undefined;
    expect(result?.is_error).toBeFalsy();
    expect(String(result?.content)).toContain('risky ran');
  });

  it('reports a declined confirm tool reached through tool_use as a failure', async () => {
    ran.length = 0;
    const viaToolUse = {
      content: [
        {
          type: 'tool_use' as const,
          id: 'u-use',
          name: 'tool_use',
          input: { tool: 'risky', input: {} },
        },
      ],
      stopReason: 'tool_use' as const,
    };
    const { agent, events, ctx } = await buildAgent(new MockProvider([viaToolUse, done]), [
      toolUseTool,
    ]);
    events.on('tool.confirm_needed', (e) => e.resolve(e.toolUseId === 'u-use' ? 'yes' : 'no'));

    await agent.run('go');

    expect(ran).toEqual([]);
    const result = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 'u-use') as
      | { content: string; is_error?: boolean }
      | undefined;
    expect(result?.is_error).toBe(true);
    expect(String(result?.content)).toContain('denied');
    expect(String(result?.content)).not.toContain('call it directly');
  });
});
