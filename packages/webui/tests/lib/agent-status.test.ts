import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUS_LABEL,
  compareAgentsByActivity,
  isAgentActive,
  tallyAgents,
} from '../../src/lib/agent-status.js';

const mk = (status: string, startedAt: number) => ({ status, startedAt });

describe('agent-status helpers', () => {
  it('isAgentActive is true only for running', () => {
    expect(isAgentActive('running')).toBe(true);
    for (const s of ['completed', 'failed', 'timeout', 'stopped', 'idle']) {
      expect(isAgentActive(s)).toBe(false);
    }
  });

  it('AGENT_STATUS_LABEL maps completed → done and passes others through', () => {
    expect(AGENT_STATUS_LABEL.completed).toBe('done');
    expect(AGENT_STATUS_LABEL.running).toBe('running');
    expect(AGENT_STATUS_LABEL.failed).toBe('failed');
    expect(AGENT_STATUS_LABEL.timeout).toBe('timeout');
    expect(AGENT_STATUS_LABEL.stopped).toBe('stopped');
  });

  it('compareAgentsByActivity puts running first, then oldest-started', () => {
    const list = [
      mk('completed', 100),
      mk('running', 300),
      mk('running', 200),
      mk('failed', 50),
    ];
    const sorted = [...list].sort(compareAgentsByActivity);
    // Running agents first; within each bucket, oldest-started first.
    expect(sorted.map((a) => `${a.status}@${a.startedAt}`)).toEqual([
      'running@200',
      'running@300',
      'failed@50',
      'completed@100',
    ]);
  });

  it('tallyAgents buckets running / completed / failed(+timeout) and total', () => {
    const t = tallyAgents([
      mk('running', 1),
      mk('running', 2),
      mk('completed', 3),
      mk('failed', 4),
      mk('timeout', 5),
      mk('stopped', 6),
    ]);
    expect(t).toEqual({ running: 2, completed: 1, failed: 2, total: 6 });
  });

  it('tallyAgents on an empty list is all zeros', () => {
    expect(tallyAgents([])).toEqual({ running: 0, completed: 0, failed: 0, total: 0 });
  });
});
