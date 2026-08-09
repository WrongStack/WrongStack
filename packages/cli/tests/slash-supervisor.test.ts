/**
 * /supervisor — status / on / off / log against the registry-held
 * FleetSupervisor. The supervisor itself is a real instance over fake
 * ports; the registry is populated per-test and cleared after.
 */

import { type BrainDecision, FleetBus, FleetSupervisor } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveFleetSupervisor } from '../src/fleet/supervisor-registry.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSupervisorCommand } from '../src/slash-commands/supervisor.js';

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

const makeCtx = (): SlashCommandContext => {
  const write = vi.fn();
  const writeWarning = vi.fn();
  return {
    renderer: { write, writeWarning } as never as SlashCommandContext['renderer'],
  } as never as SlashCommandContext;
};

function makeSupervisor(config: Record<string, unknown> = {}): FleetSupervisor {
  return new FleetSupervisor({
    events: new EventBus(),
    fleet: new FleetBus(),
    brain: {
      async decide(): Promise<BrainDecision> {
        return { type: 'answer', text: 'ok' };
      },
    },
    source: { subagents: () => [], listPendingTasks: () => [], isWorkComplete: () => false },
    actions: {
      retargetPendingTask: () => true,
      spawnHelper: async () => ({ subagentId: 'h1' }),
      steerAgent: async () => {},
      notifyLeader: async () => {},
      terminate: async () => {},
    },
    config: config as never,
  });
}

describe('/supervisor slash command', () => {
  afterEach(() => {
    setActiveFleetSupervisor(null);
  });

  it('reports name, category, and help', () => {
    const cmd = buildSupervisorCommand(makeCtx());
    expect(cmd.name).toBe('supervisor');
    expect(cmd.category).toBe('Agent');
    expect(cmd.help).toContain('/supervisor on');
    expect(cmd.help).toContain('/supervisor log');
  });

  it('warns when no supervisor is active', async () => {
    const ctx = makeCtx();
    const result = await buildSupervisorCommand(ctx).run!('');
    expect(result!.message).toContain('No fleet supervisor is active');
  });

  it('status shows armed state, config thresholds, and action gates', async () => {
    const supervisor = makeSupervisor({ allowTerminate: false });
    supervisor.start();
    setActiveFleetSupervisor(supervisor);
    try {
      const result = await buildSupervisorCommand(makeCtx()).run!('status');
      const message = stripAnsi(result!.message!);
      expect(message).toContain('armed');
      expect(message).toContain('interval 20s');
      expect(message).toContain('terminate ✗');
      expect(message).toContain('0 engagement(s)');
    } finally {
      supervisor.stop();
    }
  });

  it('off disarms and on re-arms the loop', async () => {
    const supervisor = makeSupervisor();
    supervisor.start();
    setActiveFleetSupervisor(supervisor);
    try {
      const off = await buildSupervisorCommand(makeCtx()).run!('off');
      expect(stripAnsi(off!.message!)).toContain('disarmed');
      expect(supervisor.isRunning()).toBe(false);

      const on = await buildSupervisorCommand(makeCtx()).run!('on');
      expect(stripAnsi(on!.message!)).toContain('armed');
      expect(supervisor.isRunning()).toBe(true);
    } finally {
      supervisor.stop();
    }
  });

  it('log shows recent supervision entries (and an empty hint before any)', async () => {
    const supervisor = makeSupervisor();
    setActiveFleetSupervisor(supervisor);
    const empty = await buildSupervisorCommand(makeCtx()).run!('log');
    expect(empty!.message).toContain('No supervision activity');

    // Drive one real engagement: overload with an idle sibling.
    const events = new EventBus();
    const active = new FleetSupervisor({
      events,
      fleet: new FleetBus(),
      brain: {
        async decide(req): Promise<BrainDecision> {
          const rec = req.options?.find((o) => o.recommended);
          return { type: 'answer', optionId: rec?.id, text: 'ok' };
        },
      },
      source: {
        subagents: () => [
          { id: 'busy', name: 'busy', status: 'running' },
          { id: 'idle', name: 'idle', status: 'idle' },
        ],
        listPendingTasks: () => [
          { id: 't-1', description: 'one', subagentId: 'busy' },
          { id: 't-2', description: 'two', subagentId: 'busy' },
        ],
        isWorkComplete: () => false,
      },
      actions: {
        retargetPendingTask: () => true,
        spawnHelper: async () => ({ subagentId: 'h1' }),
        steerAgent: async () => {},
        notifyLeader: async () => {},
        terminate: async () => {},
      },
      config: { overloadPinnedThreshold: 2 } as never,
    });
    setActiveFleetSupervisor(active);
    await active.evaluate();
    const result = await buildSupervisorCommand(makeCtx()).run!('log 5');
    const message = stripAnsi(result!.message!);
    expect(message).toContain('overloaded_worker');
    expect(message).toContain('retarget');
    expect(message).toContain('approved');
  });
});
