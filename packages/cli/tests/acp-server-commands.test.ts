/**
 * WrongStack's slash commands over ACP: what `available_commands_update`
 * lists, and that each listed command runs against the host an ACP session
 * gives it (no fleet, a per-session agent) instead of failing on a missing piece.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAcpServerCommands } from '../src/acp-server-commands.js';

let projectRoot: string;
beforeAll(async () => {
  projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-cmds-'));
});
afterAll(async () => {
  await fsp.rm(projectRoot, { recursive: true, force: true });
});

const agentIn = (root: string) =>
  ({
    container: { safeResolve: () => undefined },
    ctx: { projectRoot: root, meta: {}, messages: [], todos: [] },
    tools: undefined,
    permission: undefined,
  }) as unknown as Agent;

const turn = (api?: { requestPermission: ReturnType<typeof vi.fn> }) => {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    ctx: {
      signal: new AbortController().signal,
      api: api as never,
      emit: (u: unknown) => updates.push(u as Record<string, unknown>),
    },
  };
};

describe('the ACP server’s slash commands', () => {
  it('lists canonical names with hints, and none of the fleet commands', async () => {
    const list = await createAcpServerCommands({ projectRoot }).list();
    const names = list.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['init', 'git', 'tuneup', 'permissions']));
    for (const fleet of ['spawn', 'delegate', 'director', 'supervisor', 'ensemble']) {
      expect(names).not.toContain(fleet);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(list.find((c) => c.name === 'git')?.input?.hint).toMatch(/status/);
    for (const command of list) expect(command.description.length).toBeGreaterThan(0);
  });

  it('runs every listed command against a session host without a missing-piece failure', async () => {
    const commands = createAcpServerCommands({ projectRoot });
    const agent = agentIn(projectRoot);
    const hostFailure = /Cannot read propert|is not a function|undefined is not|of undefined/;
    // Approved, so the gated commands run too; the ones that write or reach the
    // network even for `help` are covered by the approval tests below.
    const sideEffects = new Set([
      'init',
      'commit',
      'push',
      'prune',
      'skill-install',
      'skill-import',
      'skill-update',
      'skill-uninstall',
      'sync',
      'skill-gen',
      'prompt-gen',
    ]);
    const allow = {
      requestPermission: vi.fn(async () => ({ outcome: 'selected', optionId: 'allow_once' })),
    };
    for (const { name } of await commands.list()) {
      if (sideEffects.has(name)) continue;
      const result = await commands.run(agent, 's1', { name, args: 'help' }, turn(allow).ctx);
      expect(result, name).toBeDefined();
      expect(result?.message ?? '', name).not.toMatch(hostFailure);
      expect(result?.message ?? '', name).not.toMatch(/was not run/);
    }
  }, 120_000);

  it('runs read-only commands without asking and asks before every other one', async () => {
    // An ACP prompt can be model-written (WrongStack's own ACP client sends a
    // task as the prompt), so a config or file writer never runs unasked.
    const commands = createAcpServerCommands({ projectRoot });
    const agent = agentIn(projectRoot);
    const ask = vi.fn(async () => ({ outcome: 'selected', optionId: 'reject_once' }));
    const reads = [
      ['git', 'status'],
      ['permissions', 'rules'],
      ['tuneup', ''],
      ['acp', 'list'],
      ['plugin', 'list'],
      ['bughunt', 'packages/acp'],
    ] as const;
    for (const [name, args] of reads) {
      const result = await commands.run(
        agent,
        's1',
        { name, args },
        turn({ requestPermission: ask }).ctx,
      );
      expect(result?.message ?? '', `${name} ${args}`).not.toMatch(/was not run/);
    }
    expect(ask).not.toHaveBeenCalled();
    const writes = [
      ['permissions', 'allow bash'],
      ['plugin', 'install sandbox'],
      ['tuneup', 'fix'],
      ['gitid', 'set A a@example.com'],
      ['acp', 'config claude-code model x'],
      ['skill-gen', 'x'],
      ['prompt-gen', 'x'],
      ['security', 'scan'],
    ] as const;
    for (const [name, args] of writes) {
      const result = await commands.run(
        agent,
        's1',
        { name, args },
        turn({ requestPermission: ask }).ctx,
      );
      expect(result?.message, `${name} ${args}`).toBe(
        `/${name} was not run: the request was rejected.`,
      );
    }
    expect(ask).toHaveBeenCalledTimes(writes.length);
  }, 60_000);

  it('answers undefined for a name it does not run, so the prompt goes to the model', async () => {
    const commands = createAcpServerCommands({ projectRoot });
    await expect(
      commands.run(agentIn(projectRoot), 's1', { name: 'spawn', args: 'x' }, turn().ctx),
    ).resolves.toBeUndefined();
  });

  it('asks before a command that changes something, and runs it only when allowed', async () => {
    const commands = createAcpServerCommands({ projectRoot });
    const agent = agentIn(projectRoot);

    const rejected = turn({
      requestPermission: vi.fn(async () => ({ outcome: 'selected', optionId: 'reject_once' })),
    });
    const refused = await commands.run(agent, 's1', { name: 'init', args: '' }, rejected.ctx);
    expect(refused?.message).toBe('/init was not run: the request was rejected.');
    await expect(fsp.stat(path.join(projectRoot, 'AGENTS.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const [card, closed] = rejected.updates;
    expect(card).toMatchObject({ sessionUpdate: 'tool_call', title: '/init', kind: 'execute' });
    expect(closed).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: card?.['toolCallId'],
      status: 'failed',
    });

    const noClient = await commands.run(agent, 's1', { name: 'init', args: '' }, turn().ctx);
    expect(noClient?.message).toMatch(/was not run/);

    const allowed = turn({
      requestPermission: vi.fn(async () => ({ outcome: 'selected', optionId: 'allow_once' })),
    });
    const ran = await commands.run(agent, 's1', { name: 'init', args: '' }, allowed.ctx);
    expect(ran?.message).not.toMatch(/was not run/);
    expect(allowed.updates.at(-1)).toMatchObject({ status: 'completed' });
  });
});
