import type { AutomationRunRecord } from '@wrongstack/webui-protocol';
import { expect, it } from 'vitest';
import { changedFileOverlap, runFacts } from '../src/automation-run-compare';

const run = (id: string, patch: Partial<AutomationRunRecord> = {}): AutomationRunRecord => ({
  id,
  jobId: 'job',
  subjectKey: 's',
  trigger: 'manual',
  status: 'completed',
  createdAt: 0,
  ...patch,
});
const result = (files: string[], truncated = false) => ({
  version: 1 as const,
  agentStatus: 'done',
  sessionId: null,
  finalText: null,
  durationMs: 1500,
  usage: {
    inputTokens: 10,
    outputTokens: null,
    iterations: 2,
    costUsd: null,
    costSource: 'unknown' as const,
  },
  changedFiles: files,
  changedFilesTruncated: truncated,
  validation: { status: 'passed' as const, evidence: [] },
});

it('lines up recorded facts and marks differences without inventing values', () => {
  const facts = Object.fromEntries(
    runFacts(
      run('a', { result: result(['x']) }),
      run('b', { status: 'failed', error: 'boom' }),
    ).map((fact) => [fact.label, fact]),
  );
  expect(facts['Status']).toMatchObject({ left: 'completed', right: 'failed', differs: true });
  expect(facts['Duration']).toMatchObject({ left: '1.5 s', right: 'Not recorded' });
  expect(facts['Output tokens']!.left).toBe('Not recorded');
  expect(facts['Trigger']!.differs).toBe(false);
  expect(facts['Error']).toMatchObject({ left: '—', right: 'boom' });
});
it('splits changed files and flags truncated lists', () => {
  const overlap = changedFileOverlap(
    run('a', { result: result(['b.ts', 'a.ts']) }),
    run('b', { result: result(['a.ts', 'c.ts'], true) }),
  );
  expect(overlap).toEqual({
    onlyLeft: ['b.ts'],
    onlyRight: ['c.ts'],
    both: ['a.ts'],
    partial: true,
  });
});
