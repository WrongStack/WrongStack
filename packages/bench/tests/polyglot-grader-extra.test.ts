import { beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => ({ execCommand: vi.fn() }));
vi.mock('../src/exec-command.js', () => ({ execCommand: exec.execCommand }));

import { gradePolyglot } from '../src/graders/polyglot-grader.js';
import type { PolyglotMeta } from '../src/suites/polyglot.js';
import type { BenchTask } from '../src/types.js';

const meta = (over: Partial<PolyglotMeta> = {}): PolyglotMeta => ({
  language: 'python',
  solutionFiles: ['s.py'],
  testFiles: ['t.py'],
  testCommand: { command: 'python', args: ['-m', 'pytest'] },
  ...over,
});
const task = (m: PolyglotMeta): BenchTask => ({
  id: 'polyglot/python/x',
  suite: 'polyglot',
  prompt: '',
  templateDir: '',
  meta: m as never as Record<string, unknown>,
});

beforeEach(() => exec.execCommand.mockReset());

describe('gradePolyglot', () => {
  it('passes when the test command exits 0', async () => {
    exec.execCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    expect(await gradePolyglot({ workdir: '/w', task: task(meta()), timeoutMs: 1000 })).toEqual({
      passed: true,
    });
  });

  it('fails with a tail of output when the test command exits non-zero', async () => {
    exec.execCommand.mockResolvedValue({
      exitCode: 1,
      stdout: 'assert failed',
      stderr: '',
      timedOut: false,
    });
    const res = await gradePolyglot({ workdir: '/w', task: task(meta()), timeoutMs: 1000 });
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/assert failed/);
  });

  it('fails when the test command times out', async () => {
    exec.execCommand.mockResolvedValue({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    const res = await gradePolyglot({ workdir: '/w', task: task(meta()), timeoutMs: 50 });
    expect(res).toEqual({ passed: false, detail: 'test command timed out' });
  });

  it('runs a setup command first and fails the task if setup fails', async () => {
    exec.execCommand.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'npm err',
      timedOut: false,
    });
    const res = await gradePolyglot({
      workdir: '/w',
      task: task(meta({ setupCommand: { command: 'npm', args: ['install'] } })),
      timeoutMs: 1000,
    });
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/setup failed \(npm\)/);
  });

  it('proceeds to tests when setup succeeds', async () => {
    exec.execCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) // setup
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false }); // tests
    const res = await gradePolyglot({
      workdir: '/w',
      task: task(meta({ setupCommand: { command: 'npm', args: ['install'] } })),
      timeoutMs: 1000,
    });
    expect(res).toEqual({ passed: true });
  });

  it('truncates very long failure output', async () => {
    exec.execCommand.mockResolvedValue({
      exitCode: 1,
      stdout: 'x'.repeat(2000),
      stderr: '',
      timedOut: false,
    });
    const res = await gradePolyglot({ workdir: '/w', task: task(meta()), timeoutMs: 1000 });
    expect((res.detail as string).startsWith('…')).toBe(true);
    expect((res.detail as string).length).toBeLessThan(520);
  });
});
