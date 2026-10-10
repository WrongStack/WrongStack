/**
 * End-to-end coverage for the Skill Companion speed bump through Agent.run().
 *
 * The host writes a recommendation into the leader's ctx.meta; the executor
 * must hold the next file change once, release it when the skill is loaded,
 * and let a deliberate retry through while recording the decline.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
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
import { markRequiredSkillLoaded } from '../../src/skills/required-skill-gate.js';
import {
  markRecommendedSkillLoaded,
  readSkillCompanionState,
  recommendSkills,
} from '../../src/skills/skill-speed-bump.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { ContentBlock, ToolResultBlock } from '../../src/types/blocks.js';
import { MockProvider, type ScriptedResponse } from '../helpers/mock-provider.js';
import { createMockTool } from '../helpers/test-harness.js';

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ScriptedResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' };
}

const DONE: ScriptedResponse = { content: [{ type: 'text', text: 'done' }] };

async function buildAgent(script: ScriptedResponse[]) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-skill-bump-'));
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );

  const edit = createMockTool({ name: 'edit', result: 'edited' });
  edit.mutating = true;
  const editSpy = vi.spyOn(edit, 'execute');
  const skill = createMockTool({ name: 'skill' });
  skill.execute = async (input, ctx, opts) => {
    const name = (input as { name: string }).name;
    markRequiredSkillLoaded(ctx, name, opts?.toolUseId);
    markRecommendedSkillLoaded(ctx, name);
    return `body of ${name}`;
  };
  const tools = new ToolRegistry();
  tools.register(edit);
  tools.register(skill);

  const provider = new MockProvider(script);
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
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
  const events = new EventBus();
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
    maxIterations: 10,
    toolExecutor,
  });
  return { agent, provider, editSpy, tmp, ctx };
}

function toolResults(provider: MockProvider): ToolResultBlock[] {
  const last = provider.receivedRequests.at(-1);
  return (last?.messages ?? []).flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : (message.content as ContentBlock[]).filter(
          (block): block is ToolResultBlock => block.type === 'tool_result',
        ),
  );
}

describe('Agent.run Skill Companion speed bump', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('holds the first edit once and releases it after the skill loads', async () => {
    const { agent, provider, editSpy, tmp, ctx } = await buildAgent([
      toolUse('e1', 'edit'),
      toolUse('s1', 'skill', { name: 'frontend-design' }),
      toolUse('e2', 'edit'),
      DONE,
    ]);
    dirs.push(tmp);
    recommendSkills(ctx, ctx.session.id, [{ name: 'frontend-design', reason: 'UI work' }]);

    await agent.run('Redesign the settings page.');

    expect(editSpy).toHaveBeenCalledTimes(1);
    const results = toolResults(provider);
    const held = results.find((result) => result.tool_use_id === 'e1');
    expect(held?.is_error).toBe(true);
    expect(String(held?.content)).toContain('held once by Skill Companion');
    expect(results.find((result) => result.tool_use_id === 'e2')?.is_error).toBe(false);
    expect(readSkillCompanionState(ctx)?.loaded).toEqual(['frontend-design']);
  });

  it('lets a deliberate retry through and declines the recommendation', async () => {
    const { agent, provider, editSpy, tmp, ctx } = await buildAgent([
      toolUse('e1', 'edit'),
      toolUse('e2', 'edit'),
      toolUse('e3', 'edit'),
      DONE,
    ]);
    dirs.push(tmp);
    recommendSkills(ctx, ctx.session.id, [{ name: 'frontend-design', reason: 'UI work' }]);

    await agent.run('Redesign the settings page.');

    expect(editSpy).toHaveBeenCalledTimes(2);
    const results = toolResults(provider);
    expect(results.find((result) => result.tool_use_id === 'e1')?.is_error).toBe(true);
    expect(results.find((result) => result.tool_use_id === 'e2')?.is_error).toBe(false);
    expect(readSkillCompanionState(ctx)?.declined).toEqual(['frontend-design']);
  });

  it('holds every edit of the held batch, not just the first', async () => {
    const batch: ScriptedResponse = {
      content: [
        { type: 'tool_use', id: 'b1', name: 'edit', input: {} },
        { type: 'tool_use', id: 'b2', name: 'edit', input: {} },
      ],
      stopReason: 'tool_use',
    };
    const { agent, provider, editSpy, tmp, ctx } = await buildAgent([batch, DONE]);
    dirs.push(tmp);
    recommendSkills(ctx, ctx.session.id, [{ name: 'frontend-design', reason: 'UI work' }]);

    await agent.run('Redesign the settings page.');

    expect(editSpy).not.toHaveBeenCalled();
    const results = toolResults(provider);
    expect(results.find((result) => result.tool_use_id === 'b1')?.is_error).toBe(true);
    expect(results.find((result) => result.tool_use_id === 'b2')?.is_error).toBe(true);
    expect(readSkillCompanionState(ctx)?.declined).toEqual([]);
  });

  it('does nothing without a recommendation', async () => {
    const { agent, editSpy, tmp } = await buildAgent([toolUse('e1', 'edit'), DONE]);
    dirs.push(tmp);

    await agent.run('Redesign the settings page.');

    expect(editSpy).toHaveBeenCalledTimes(1);
  });
});
