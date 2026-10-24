/**
 * The host's skill gates (required-skill gate, Skill Companion speed bump)
 * do not bind an agent that keeps its own context. An ACP or WrongForge leader
 * calls WrongStack's tools through `AcpLeaderHost.runTool`, which runs a
 * synthesized `acp_fleet_*` use that never enters ctx.messages, and it loads
 * skills with its own tools — so a gate there could never open and every
 * mutating call was refused, YOLO+ included.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import {
  armRequiredSkills,
  markRequiredSkillLoaded,
} from '../../src/skills/required-skill-gate.js';
import { recommendSkills } from '../../src/skills/skill-speed-bump.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider } from '../helpers/mock-provider.js';
import { createMockTool } from '../helpers/test-harness.js';

const dirs: string[] = [];
// Each setup() opens a session writer whose FileHandle must be closed
// explicitly: left for GC, Bun raises ERR_INVALID_STATE ("closed during
// garbage collection") as an uncaught error that fails the whole run.
const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function setup(keepsOwnContext: boolean) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prove-ext-leader-'));
  dirs.push(tmp);
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
  const provider = new MockProvider([]);
  if (keepsOwnContext) {
    (provider as unknown as { capabilities: Record<string, unknown> }).capabilities = {
      ...provider.capabilities,
      keepsOwnContext: true,
    };
  }
  const store = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await store.create({ id: '', model: 'm', provider: 'mock' });
  sessions.push(session);
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 't' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: tmp,
    projectRoot: tmp,
    model: 'm',
  });
  const executor = new ToolExecutor(tools, {
    permissionPolicy: new DefaultPermissionPolicy({
      trustFile: path.join(tmp, 'trust.json'),
      yolo: true,
    }),
    secretScrubber: new DefaultSecretScrubber(),
    events: new EventBus(),
    confirmAwaiter: undefined,
    iterationTimeoutMs: 60_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });
  // Exactly what AcpLeaderHost.runTool does: a synthesized use on the session ctx.
  let n = 0;
  const runTool = async (name: string, input: Record<string, unknown> = {}) => {
    const use = { type: 'tool_use' as const, id: `acp_fleet_${++n}`, name, input };
    const batch = await executor.executeBatch([use], ctx, 'sequential');
    const result = batch.outputs[0]?.result;
    return result && 'content' in result ? String(result.content) : '';
  };
  return { ctx, runTool, editSpy };
}

describe('external-agent leader vs host skill gates', () => {
  it('required-skill gate: edit runs after the leader loaded the skill through the gateway', async () => {
    const { ctx, runTool, editSpy } = await setup(true);
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills bug-hunter -->');
    await runTool('skill', { name: 'bug-hunter' });
    const r = await runTool('edit');
    expect(r).not.toContain('requires skills');
    expect(editSpy).toHaveBeenCalledTimes(1);
  });

  it('required-skill gate: edit runs even when the agent loaded the skill with its own tool', async () => {
    const { ctx, runTool, editSpy } = await setup(true);
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills bug-hunter -->');
    const r = await runTool('edit');
    expect(r).not.toContain('requires skills');
    expect(editSpy).toHaveBeenCalledTimes(1);
  });

  it('speed bump: a companion recommendation does not hold the leader edit', async () => {
    const { ctx, runTool, editSpy } = await setup(true);
    recommendSkills(ctx, ctx.session.id, [{ name: 'frontend-design', reason: 'UI' }]);
    const r = await runTool('edit');
    expect(r).not.toContain('frontend-design');
    expect(editSpy).toHaveBeenCalledTimes(1);
  });

  it('control: a WrongStack-run model is still gated', async () => {
    const { ctx, runTool, editSpy } = await setup(false);
    armRequiredSkills(ctx, '<!-- wrongstack:required-skills bug-hunter -->');
    const r = await runTool('edit');
    expect(r).toContain('requires skills');
    expect(editSpy).not.toHaveBeenCalled();
  });
});
