/**
 * Solo with companions: `Director.spawn` refuses, `spawnCompanion` admits.
 *
 * A Bug Hunter round runs solo so one fix maps to one outcome, but keeps the
 * resident read-only companions (memory, explore). The exemption is its own
 * entry point, so a caller-built config cannot claim it through `spawn`.
 */

import { describe, expect, it, vi } from 'vitest';
import { Director } from '../../src/coordination/director.js';
import { setSessionSubagentPolicy } from '../../src/coordination/session-subagent-policy.js';
import type { SubagentRunOutcome } from '../../src/types/multi-agent.js';

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
});
