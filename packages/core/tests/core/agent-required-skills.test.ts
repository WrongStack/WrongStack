/**
 * End-to-end coverage for the required-skill gate through Agent.run().
 *
 * The Proof-Driven Bug Hunter declares its playbook skills with a
 * `wrongstack:required-skills` marker. A `$mention` alone only asks the model
 * to load them, so this pins the host-side half: the user turn arms the gate,
 * a file-changing tool is refused until the `skill` tool delivers each skill,
 * and a turn without the marker is not gated at all.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { ContentBlock, ToolResultBlock } from '@wrongstack/contracts/types/blocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { markRequiredSkillLoaded } from '../../src/skills/required-skill-gate.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider, type ScriptedResponse } from '../helpers/mock-provider.js';
import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';
import { createMockTool } from '../helpers/test-harness.js';

const MARKER = '<!-- wrongstack:required-skills bug-hunter -->';

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ScriptedResponse {
  return { content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' };
}

const DONE: ScriptedResponse = { content: [{ type: 'text', text: 'done' }] };

async function buildAgent(script: ScriptedResponse[]) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-required-skills-'));
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
  return { agent, provider, editSpy, tmp };
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

describe('Agent.run required-skill gate', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 50 });
    }
  });

  it('refuses edits until the marked skill is loaded, then lets them through', async () => {
    const { agent, provider, editSpy, tmp } = await buildAgent([
      toolUse('e1', 'edit'),
      toolUse('s1', 'skill', { name: 'bug-hunter' }),
      toolUse('e2', 'edit'),
      DONE,
    ]);
    dirs.push(tmp);

    await agent.run(`Hunt one bug.\n${MARKER}`, { inputOrigin: 'user' });

    expect(editSpy).toHaveBeenCalledTimes(1);
    const results = toolResults(provider);
    const refused = results.find((result) => result.tool_use_id === 'e1');
    expect(refused?.is_error).toBe(true);
    expect(String(refused?.content)).toContain('removed from context: bug-hunter');
    expect(JSON.stringify(provider.receivedRequests[1]?.messages)).toContain(
      '[TOOL COACH — edit was denied]',
    );
    expect(results.find((result) => result.tool_use_id === 'e2')?.is_error).toBe(false);
  });

  it('closes again in a later round once compaction has dropped the skill', async () => {
    const { agent, provider, editSpy, tmp } = await buildAgent([
      toolUse('s1', 'skill', { name: 'bug-hunter' }),
      toolUse('e1', 'edit'),
      DONE,
      // Round 2, after compaction folded round 1 into a digest.
      toolUse('e2', 'edit'),
      toolUse('s2', 'skill', { name: 'bug-hunter' }),
      toolUse('e3', 'edit'),
      DONE,
    ]);
    dirs.push(tmp);

    await agent.run(`Hunt one bug.\n${MARKER}`, { inputOrigin: 'user' });
    expect(editSpy).toHaveBeenCalledTimes(1);

    agent.ctx.state.replaceMessages([
      { role: 'system', content: '[prior_turns_digest: round 1; tool I/O omitted]' },
    ]);
    await agent.run("This is round 2/3; we're continuing the bug hunt.", {
      inputOrigin: 'continuation',
    });

    expect(editSpy).toHaveBeenCalledTimes(2);
    const results = toolResults(provider);
    expect(results.find((result) => result.tool_use_id === 'e2')?.is_error).toBe(true);
    expect(results.find((result) => result.tool_use_id === 'e3')?.is_error).toBe(false);
  });

  it('does not gate a turn without the marker', async () => {
    const { agent, editSpy, tmp } = await buildAgent([toolUse('e1', 'edit'), DONE]);
    dirs.push(tmp);

    await agent.run('Load $bug-hunter and fix the bug.', { inputOrigin: 'user' });

    expect(editSpy).toHaveBeenCalledTimes(1);
  });
});
