import { describe, expect, it } from 'vitest';
import { endLabel, reportedEnded } from '../src/session-process-model';

const row = (extra: Record<string, unknown>) => ({
  pid: 12,
  command: 'npm test',
  tool: 'bash',
  startedAt: 1,
  endedAt: 5,
  exitCode: null,
  signal: null,
  killed: false,
  background: true,
  sessionId: 's1',
  ...extra,
});

describe('engine-reported process ends', () => {
  it('reads only this session and refuses unreadable rows', () => {
    const ended = reportedEnded(
      {
        ended: [
          row({ exitCode: 2 }),
          row({ pid: 13, sessionId: 's2' }),
          row({ pid: 14, exitCode: 1.5 }),
          row({ pid: 15, signal: 9 }),
        ],
      },
      's1',
    );
    expect(ended).toEqual([
      {
        pid: 12,
        command: 'npm test',
        tool: 'bash',
        startedAt: 1,
        endedAt: 5,
        exitCode: 2,
        signal: null,
        killed: false,
        background: true,
      },
    ]);
    // Older engines do not send the list at all.
    expect(reportedEnded({ processes: [] }, 's1')).toBeNull();
  });

  it('labels the reported exit and never turns an unknown exit into success', () => {
    const [base] = reportedEnded({ ended: [row({})] }, 's1')!;
    expect(endLabel({ ...base!, exitCode: 0 })).toEqual({ text: 'Exit code 0', failed: false });
    expect(endLabel({ ...base!, exitCode: 3 })).toEqual({ text: 'Exit code 3', failed: true });
    expect(endLabel({ ...base!, signal: 'SIGTERM', killed: true })).toEqual({
      text: 'Terminated on request · SIGTERM',
      failed: true,
    });
    // Windows reports a terminated process by its exit code, without a signal.
    expect(endLabel({ ...base!, exitCode: 1, killed: true })).toEqual({
      text: 'Terminated on request · exit code 1',
      failed: true,
    });
    expect(endLabel(base!)).toEqual({ text: 'Exit not reported', failed: null });
    expect(endLabel({ ...base!, killed: true }).failed).toBeNull();
  });
});
