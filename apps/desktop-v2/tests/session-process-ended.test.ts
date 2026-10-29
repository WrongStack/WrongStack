import { expect, it } from 'vitest';
import {
  endedProcesses,
  observedDuration,
  type SessionProcess,
} from '../src/session-process-model';

const proc = (pid: number, startedAt = 1000): SessionProcess => ({
  pid,
  command: `run ${pid}`,
  tool: 'bash',
  startedAt,
  status: 'running',
  protected: false,
  background: true,
  hasOutput: true,
});

it('records runs that left the list, newest first, once each', () => {
  const first = endedProcesses([], [proc(1), proc(2)], [proc(2)], 5000, 7000);
  expect(first).toEqual([{ proc: proc(1), lastSeenAt: 5000, goneBy: 7000 }]);
  // Nothing new gone: the same list is kept.
  expect(endedProcesses(first, [proc(2)], [proc(2)], 7000, 9000)).toBe(first);
  const second = endedProcesses(first, [proc(2)], [], 9000, 11000);
  expect(second.map((item) => item.proc.pid)).toEqual([2, 1]);
});
it('treats a reused PID with a new start time as the old run ending', () => {
  const ended = endedProcesses([], [proc(3, 1000)], [proc(3, 2000)], 5000, 6000);
  expect(ended).toHaveLength(1);
  expect(ended[0]!.proc.startedAt).toBe(1000);
});
it('keeps at most fifty ended runs', () => {
  const previous = Array.from({ length: 60 }, (_, index) => proc(index + 1));
  expect(endedProcesses([], previous, [], 1, 2)).toHaveLength(50);
});
it('formats observed durations', () => {
  expect(observedDuration(0, 42_000)).toBe('42 s');
  expect(observedDuration(0, 192_000)).toBe('3 min 12 s');
  expect(observedDuration(0, 3_900_000)).toBe('1 h 5 min');
  expect(observedDuration(5000, 1000)).toBe('0 s');
});
