/**
 * Solo with companions: `Director.spawn` refuses, `spawnCompanion` admits.
 *
 * A Bug Hunter round runs solo so one fix maps to one outcome, but keeps the
 * resident read-only companions (memory, explore). The exemption is its own
 * entry point, so a caller-built config cannot claim it through `spawn`.
 */

import type { SubagentRunOutcome } from '@wrongstack/contracts/types/multi-agent';
import { describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import {
  resetSessionSubagentModelPlan,
  setSessionSubagentModelPlanForSession,
  subagentSlotOccupancy,
} from '../../src/coordination/session-subagent-models.js';
import { setSessionSubagentPolicy } from '../../src/security/session-subagent-policy.js';

function directorFor(sessionId: string) {
  return new Director({
    sessionId,
    config: {
      coordinatorId: `companion-${sessionId}`,
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 2,
    },
    runner: vi.fn(
      async (): Promise<SubagentRunOutcome> => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
    ),
  });
}

async function soloSession(id: string, mode: 'companions' | 'none') {
  await setSessionSubagentPolicy(
    { messages: [], meta: {}, session: { id, append: vi.fn(async () => undefined) } },
    mode,
  );
}

const companion = { name: 'Memory Companion', role: 'memory-curator' };

describe('Director companion spawn gate', () => {
  it('companions mode: spawn refuses, spawnCompanion admits', async () => {
    await soloSession('dir-companions', 'companions');
    const director = directorFor('dir-companions');

    await expect(director.spawn({ ...companion, id: 'memory-companion-x' })).rejects.toThrow(
      'Subagents are disabled for this session.',
    );
    await expect(
      director.spawnCompanion({ ...companion, id: 'memory-companion-dir' }),
    ).resolves.toEqual(expect.any(String));
  });

  it('strict solo: spawnCompanion refuses too', async () => {
    await soloSession('dir-strict', 'none');
    const director = directorFor('dir-strict');

    await expect(
      director.spawnCompanion({ ...companion, id: 'memory-companion-strict' }),
    ).rejects.toThrow('Subagent companions are disabled for this session.');
  });

  it('spawnCompanion does not occupy numbered worker lanes or strip tier under a locked lane plan', async () => {
    const sessionId = 'dir-companion-lanes';
    setSessionSubagentModelPlanForSession(sessionId, {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [
        { provider: 'anthropic', model: 'claude-opus-4-7' },
        { provider: 'openai', model: 'gpt-5.4' },
      ],
    });
    try {
      const director = new Director({
        sessionId,
        config: {
          coordinatorId: `companion-${sessionId}`,
          doneCondition: { type: 'all_tasks_done' },
          maxConcurrent: 4,
        },
        appConfig: {
          modelTiers: {
            enabled: true,
            levels: {
              budget: { provider: 'anthropic', model: 'claude-haiku-4-5' },
            },
          },
        } as never,
        runner: vi.fn(
          async (): Promise<SubagentRunOutcome> => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        ),
      });

      const skillId = await director.spawnCompanion({
        id: 'skill-companion-dir',
        name: 'Skill Companion',
        role: 'skill-companion',
        tier: 'budget',
      });

      expect(subagentSlotOccupancy(sessionId)).toEqual([
        { slotIndex: 0, subagentIds: [] },
        { slotIndex: 1, subagentIds: [] },
      ]);
      expect(director.resolvedModelFor(skillId)).toEqual({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      });
    } finally {
      resetSessionSubagentModelPlan(sessionId);
    }
  });

  it('spawnCompanion still honors an explicit session role override for a companion role', async () => {
    const sessionId = 'dir-companion-role-override';
    setSessionSubagentModelPlanForSession(sessionId, {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [{ provider: 'anthropic', model: 'claude-opus-4-7' }],
      roles: {
        'explore-companion': { provider: 'google', model: 'gemini-3-flash' },
      },
    });
    try {
      const director = directorFor(sessionId);
      const exploreId = await director.spawnCompanion({
        id: 'explore-companion-dir',
        name: 'Explore Companion',
        role: 'explore-companion',
      });

      expect(subagentSlotOccupancy(sessionId)).toEqual([{ slotIndex: 0, subagentIds: [] }]);
      expect(director.resolvedModelFor(exploreId)).toEqual({
        provider: 'google',
        model: 'gemini-3-flash',
      });
    } finally {
      resetSessionSubagentModelPlan(sessionId);
    }
  });

  it('spawnCompanion is exempt from maxSpawns and does not consume leader spawn budget', async () => {
    const director = new Director({
      sessionId: 'dir-companion-budget',
      maxSpawns: 1,
      config: {
        coordinatorId: 'companion-budget',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner: vi.fn(
        async (): Promise<SubagentRunOutcome> => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
      ),
    });

    await expect(
      director.spawnCompanion({
        id: 'explore-companion-budget-1',
        name: 'Explore Companion',
        role: 'explore-companion',
      }),
    ).resolves.toBe('explore-companion-budget-1');
    expect(director.spawnCount).toBe(0);

    await expect(director.spawn({ id: 'worker-1', name: 'Worker 1', role: 'coder' })).resolves.toBe(
      'worker-1',
    );
    expect(director.spawnCount).toBe(1);

    await expect(
      director.spawn({ id: 'worker-2', name: 'Worker 2', role: 'coder' }),
    ).rejects.toThrow(/maxSpawns/i);

    await expect(
      director.spawnCompanion({
        id: 'memory-companion-budget-2',
        name: 'Memory Companion',
        role: 'memory-curator',
      }),
    ).resolves.toBe('memory-companion-budget-2');
    expect(director.spawnCount).toBe(1);
  });
});
