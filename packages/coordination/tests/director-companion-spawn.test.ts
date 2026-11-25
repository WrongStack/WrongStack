/**
 * Solo with companions: `Director.spawn` refuses, `spawnCompanion` admits.
 *
 * A Bug Hunter round runs solo so one fix maps to one outcome, but keeps the
 * resident read-only companions (memory, explore). The exemption is its own
 * entry point, so a caller-built config cannot claim it through `spawn`.
 */

import type { Config } from '@wrongstack/contracts/types/config';
import type { SubagentRunOutcome } from '@wrongstack/contracts/types/multi-agent';
import { setSessionSubagentPolicy } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import { Director } from '../src/director.js';
import {
  resetSessionSubagentModelPlan,
  setSessionSubagentModelPlanForSession,
  subagentSlotOccupancy,
} from '../src/session-subagent-models.js';

function directorFor(sessionId: string, appConfig?: Config) {
  return new Director({
    sessionId,
    appConfig,
    sessionProvider: appConfig?.provider,
    sessionModel: appConfig?.model,
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

  it('runs a native companion on the ACP leader side model while keeping ACP workers available', async () => {
    const director = directorFor('dir-companion-acp-leader', {
      provider: 'acp',
      model: 'claude-code',
      acp: { leader: { sideModel: 'openrouter/anthropic/claude-haiku-4-5' } },
      fallbackBridge: 'openai/gpt-5.4',
    } as Config);
    try {
      const id = await director.spawnCompanion(companion);
      expect(director.resolvedModelFor(id)).toEqual({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-4-5',
      });
      await director.assignInternal({
        id: 'memory-probe',
        description: 'Review memory',
        subagentId: id,
      });
      await expect(director.awaitTasks(['memory-probe'])).resolves.toMatchObject([
        { subagentId: id, status: 'success', result: 'ok' },
      ]);

      const externalId = await director.spawn({
        name: 'Reviewer',
        provider: 'acp',
        model: 'codex-cli',
      });
      expect(director.resolvedModelFor(externalId)).toEqual({
        provider: 'acp',
        model: 'codex-cli',
      });
    } finally {
      await director.shutdown();
    }
  });

  it('refuses an explicitly external companion role without consuming a fleet slot', async () => {
    const sessionId = 'dir-companion-acp-role';
    setSessionSubagentModelPlanForSession(sessionId, {
      enabled: true,
      lock: true,
      followSessionModel: false,
      slots: [{ provider: 'openai', model: 'gpt-5.4' }],
      roles: { 'memory-curator': { provider: 'acp', model: 'codex-cli' } },
    });
    const director = directorFor(sessionId);
    try {
      await expect(director.spawnCompanion(companion)).rejects.toThrow(
        'Companion "memory-curator" requires a native provider and model',
      );
      expect(director.status().subagents).toEqual([]);
      expect(subagentSlotOccupancy(sessionId)).toEqual([{ slotIndex: 0, subagentIds: [] }]);
    } finally {
      resetSessionSubagentModelPlan(sessionId);
      await director.shutdown();
    }
  });

  it('refuses a companion when the ACP leader has no native side model or role route', async () => {
    const director = directorFor('dir-companion-acp-no-side', {
      provider: 'acp',
      model: 'codex-cli',
    } as Config);
    try {
      await expect(director.spawnCompanion(companion)).rejects.toThrow('acp.leader.sideModel');
      expect(director.status().subagents).toEqual([]);
    } finally {
      await director.shutdown();
    }
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
