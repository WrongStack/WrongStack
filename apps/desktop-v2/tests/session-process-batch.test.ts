import { expect, it } from 'vitest';
import {
  batchTermination,
  batchTerminationSummary,
  processKey,
  type SessionProcess,
  terminable,
} from '../src/session-process-model';

const proc = (pid: number, patch: Partial<SessionProcess> = {}): SessionProcess => ({
  pid,
  command: `run ${pid}`,
  tool: 'bash',
  startedAt: 1000 + pid,
  status: 'running',
  protected: false,
  background: true,
  hasOutput: true,
  ...patch,
});

it('sends only picks that are still the same running, unprotected process', () => {
  const a = proc(1),
    b = proc(2),
    c = proc(3),
    d = proc(4);
  const { send, skipped } = batchTermination(
    [a, b, c, d],
    [
      a,
      { ...b, status: 'exited' },
      { ...c, protected: true },
      // The PID was reused by a different run.
      { ...d, startedAt: 9999 },
    ],
  );
  expect(send).toEqual([a]);
  expect(skipped).toEqual([b, c, d]);
  expect(batchTermination([proc(5)], []).skipped).toHaveLength(1);
});
it('identifies a run by PID and start time and only offers running unprotected ones', () => {
  expect(processKey(proc(7))).toBe('7:1007');
  expect(terminable(proc(7))).toBe(true);
  expect(terminable(proc(7, { status: 'killed' }))).toBe(false);
  expect(terminable(proc(7, { protected: true }))).toBe(false);
});
it('reports acknowledged, failed and skipped processes separately', () => {
  expect(
    batchTerminationSummary(3, [proc(1)], [{ proc: proc(2), error: 'denied' }], [proc(3)]),
  ).toBe(
    'Termination acknowledged for 1 of 3 processes. Failed: PID 2 (denied). Not sent because they exited, changed or became protected: PID 3. Refresh verifies whether they are still tracked.',
  );
});
