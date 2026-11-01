import { describe, expect, it } from 'vitest';
import { projectSideEffectsSummary } from '../src/server/session-journal-side-effects.js';

const effect = (toolName: string, risk: string, ts: string) => ({
  type: 'side_effect',
  toolUseId: `${toolName}-${ts}`,
  toolName,
  ts,
  input: { command: 'x'.repeat(400) },
  risk,
});

describe('project side-effect summary', () => {
  const store = {
    list: async () => [
      { id: 'a', title: 'First' },
      { id: 'b', name: 'Named', title: 'ignored' },
      { id: 'gone' },
      { id: 'quiet' },
    ],
    load: async (id: string) => {
      if (id === 'gone') throw Error('missing');
      if (id === 'quiet') return { events: [{ type: 'user_input' }] };
      return id === 'a'
        ? { events: [effect('bash', 'shell', '2026-11-01T10:00:00Z'), { type: 'llm_response' }] }
        : {
            events: [
              effect('fetch', 'network', '2026-11-01T12:00:00Z'),
              effect('bash', 'shell', '2026-11-01T11:00:00Z'),
            ],
          };
    },
  };

  it('counts per risk and tool, keeps newest records first and skips unreadable journals', async () => {
    const summary = await projectSideEffectsSummary(store as never, {});
    expect(summary).toMatchObject({
      sessionsScanned: 4,
      sessionsWithEffects: 2,
      unreadable: 1,
      total: 3,
      byRisk: { shell: 2, network: 1 },
      byTool: { bash: 2, fetch: 1 },
    });
    expect(summary.records.map((row) => [row.sessionTitle, row.toolName])).toEqual([
      ['Named', 'fetch'],
      ['Named', 'bash'],
      ['First', 'bash'],
    ]);
    expect(summary.records[0]?.input.length).toBe(300);
  });

  it('narrows every count to one risk', async () => {
    const summary = await projectSideEffectsSummary(store as never, { risk: 'network' });
    expect(summary).toMatchObject({ total: 1, sessionsWithEffects: 1, byRisk: { network: 1 } });
  });
});
