/**
 * End-to-end malformed-tool-call recovery: the full feedback loop the
 * repair pipeline promises. A model sends garbage arguments, the executor
 * rejects them with a SPECIFIC `is_error` tool_result (never crashing the
 * run), the model reads that error from the conversation and self-corrects,
 * and the fixed call executes — with one lossless coercion pass silently
 * fixing "right content, wrong type" arguments along the way.
 *
 * The unit layers (parseToolInput ladder, coerceAgainstSchema, executor
 * validation gate) each have their own tests; this file pins the CHAIN so
 * a regression in the wiring between them — not just in a layer — fails.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { ContentBlock } from '@wrongstack/contracts/types/blocks';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
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
import { MockProvider } from '../helpers/mock-provider.js';

async function buildAgent(provider: MockProvider, extraTools: Tool[] = []) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-malformed-'));
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
  const session = await sessionStore.create({ id: '', model: 'test-model', provider: 'mock' });

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
    maxIterations: 25,
    toolExecutor,
  });
  return { agent, ctx, tmp };
}

describe('malformed tool call → specific error feedback → model retry (E2E)', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('delivers contextual Kit advice before the first request and after an ad hoc call', async () => {
    const create = vi.fn(async () => ({
      initialNote: '[PROJECT KIT — task candidates]\nsettings.parity',
      afterTools: () =>
        '[PROJECT KIT — possible ad hoc duplication]\nInspect settings.parity before another copy.',
    }));
    const metadataExecute = vi.fn(async () => 'metadata');
    const kitTool: Tool = {
      name: 'project_kit',
      description: 'Project Kit discovery',
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object' },
      execute: metadataExecute,
      turnGuidance: { permissionInput: { action: 'list' }, create },
    };
    const write = vi.fn(async () => 'written');
    const writer: Tool = {
      name: 'write',
      description: 'Write files',
      permission: 'auto',
      mutating: true,
      inputSchema: { type: 'object' },
      execute: write,
    };
    const provider = new MockProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'kit-write',
            name: 'write',
            input: { path: '.temp_files/settings.mjs', content: '// settings parity' },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [kitTool, writer]);
    cleanupDirs.push(tmp);
    expect((await agent.run('Check settings parity', { inputOrigin: 'user' })).status).toBe('done');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'Check settings parity', projectRoot: tmp }),
    );
    expect(JSON.stringify(provider.receivedRequests[0]?.messages)).toContain(
      '[PROJECT KIT — task candidates]',
    );
    expect(JSON.stringify(provider.receivedRequests[1]?.messages)).toContain(
      '[PROJECT KIT — possible ad hoc duplication]',
    );
    expect(metadataExecute).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not load Kit metadata when the shared Tool Coach switch is off', async () => {
    const create = vi.fn(async () => ({ initialNote: 'must not appear', afterTools: () => null }));
    const kitTool: Tool = {
      name: 'project_kit',
      description: 'Project Kit discovery',
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object' },
      execute: async () => 'ok',
      turnGuidance: { permissionInput: { action: 'list' }, create },
    };
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider, [kitTool]);
    cleanupDirs.push(tmp);
    ctx.meta.featureToolCoach = false;
    await agent.run('Check settings parity', { inputOrigin: 'user' });
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.receivedRequests)).not.toContain('must not appear');
  });

  it('recovers across three turns: sentinel garbage → wrong fields → coerced success', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, data: 'file contents' });
    const readTool: Tool = {
      name: 'read',
      description: 'read a file',
      usageHint: 'read({ path, limit? })',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'integer' } },
        required: ['path'],
      },
      permission: 'auto',
      mutating: false,
      execute,
    };

    const provider = new MockProvider([
      // Turn 1: unrecoverable streamed garbage — exactly what parseToolInput
      // produces when its whole repair ladder fails: the __raw sentinel.
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { __raw: '{"pa' } }],
        stopReason: 'tool_use',
      },
      // Turn 2: parseable but invalid — required field missing.
      {
        content: [{ type: 'tool_use', id: 'u2', name: 'read', input: { limit: 5 } }],
        stopReason: 'tool_use',
      },
      // Turn 3: correct call, except limit arrives as a string — the
      // executor's coercion pass must fix it without another round-trip.
      {
        content: [
          { type: 'tool_use', id: 'u3', name: 'read', input: { path: 'a.ts', limit: '5' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done reading' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider, [readTool]);
    cleanupDirs.push(tmp);

    const result = await agent.run('read a.ts', { maxIterations: 10, inputOrigin: 'user' });

    // The run never crashed — every malformed turn became an is_error
    // tool_result and the loop kept going to completion.
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('done reading');
    expect(provider.calls).toBe(4);
    expect(JSON.stringify(provider.receivedRequests[0]?.messages)).toContain('[TOOL COACH');
    expect(JSON.stringify(provider.receivedRequests[1]?.messages)).toContain(
      'Do not repeat the same call unchanged',
    );

    // The tool executed exactly once, with the COERCED input.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { path: 'a.ts', limit: 5 },
      expect.anything(),
      expect.anything(),
    );

    // The model-facing feedback is in the conversation and is SPECIFIC:
    // the sentinel error echoes the raw payload, the validation error names
    // the exact missing field with its expected type.
    const toolResults = ctx.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    const errorTexts = toolResults
      .filter((r) => r.is_error)
      .map((r) => (typeof r.content === 'string' ? r.content : JSON.stringify(r.content)));
    expect(errorTexts).toHaveLength(2);
    expect(
      ctx.messages.some(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === 'text' && block.text.includes('[TOOL COACH'),
          ),
      ),
    ).toBe(true);
    expect(errorTexts[0]).toContain('not a valid JSON object');
    expect(errorTexts[0]).toContain('{"pa'); // raw payload echoed back
    expect(errorTexts[1]).toContain('path: required property missing (expected string)');
    // The first failure carries the registered contract; the second, with that
    // copy still in view, points back to it instead of repeating it.
    expect(errorTexts[0]).toContain('Usage: read({ path, limit? })');
    expect(errorTexts[0]).toContain('Input schema:');
    expect(errorTexts[0]).toContain('"required":["path"]');
    expect(errorTexts[1]).not.toContain('Input schema:');
    expect(errorTexts[1]).toContain('earlier failed call');

    // And exactly one successful tool_result followed.
    expect(toolResults.filter((r) => !r.is_error)).toHaveLength(1);
  });

  it('does not inject Tool Coach notes when the feature is off', async () => {
    const readTool: Tool = {
      name: 'read',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      execute: async () => 'ok',
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'off-1', name: 'read', input: { path: 'a.ts' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider, [readTool]);
    cleanupDirs.push(tmp);
    ctx.meta['featureToolCoach'] = false;

    await agent.run('Read a.ts', { inputOrigin: 'user' });

    expect(provider.calls).toBe(2);
    expect(JSON.stringify(provider.receivedRequests)).not.toContain('[TOOL COACH');
  });
});
