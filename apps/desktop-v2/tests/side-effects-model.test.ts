import { expect, it } from 'vitest';
import {
  effectSummary,
  effectsCsv,
  effectsSnapshot,
  journalEffectsSnapshot,
  outcomeText,
  withOlderPage,
} from '../src/side-effects-model';

const effect = {
  toolUseId: 'call-1',
  toolName: 'bash',
  ts: '2026-10-28T00:00:00Z',
  input: { command: 'git status' },
  risk: 'shell' as const,
  outcome: 'exit 0',
};
it('preserves the owning runtime window and refuses malformed or mismatched records', () => {
  expect(
    effectsSnapshot({ sessionId: 'one', sideEffects: [effect], total: 70, truncated: true }, 'one'),
  ).toMatchObject({ total: 70, truncated: true, entries: [effect] });
  expect(effectsSnapshot({ sessionId: 'one', sideEffects: [effect] }, 'one').total).toBeNull();
  expect(() => effectsSnapshot({ sessionId: 'other', sideEffects: [effect] }, 'one')).toThrow(
    'another',
  );
  expect(() =>
    effectsSnapshot({ sessionId: 'one', sideEffects: [{ ...effect, ts: 'bad' }] }, 'one'),
  ).toThrow('invalid');
  expect(() =>
    effectsSnapshot({ sessionId: 'one', sideEffects: [effect], total: 0 }, 'one'),
  ).toThrow('inconsistent');
});
it('summarizes meaningful inputs without dumping arbitrary JSON and escapes spreadsheet formulas', () => {
  expect(effectSummary(effect)).toBe('git status');
  expect(effectSummary({ ...effect, input: { packages: ['one', 'two'] } })).toBe('one, two');
  expect(effectSummary({ ...effect, input: { custom: { nested: true } } })).toBe(
    '1 recorded input fields',
  );
  const csv = effectsCsv([
    {
      ...effect,
      input: { command: '=HYPERLINK("https://fixture.invalid")\nnext' },
      outcome: '+untrusted',
    },
  ]);
  expect(csv).toContain('"\'=HYPERLINK(""https://fixture.invalid"")\nnext"');
  expect(csv).toContain('"\'+untrusted"');
});

it('pages older records only when they join the loaded window exactly', () => {
  const at = (id: string) => ({ ...effect, toolUseId: id });
  const latest = effectsSnapshot(
    { sessionId: 'one', sideEffects: [at('c'), at('d')], total: 4, start: 2, truncated: true },
    'one',
  );
  expect(latest.start).toBe(2);
  const older = effectsSnapshot(
    { sessionId: 'one', sideEffects: [at('a'), at('b'), at('c')], total: 4, start: 0 },
    'one',
  );
  expect(withOlderPage(latest.entries, older).map((item) => item.toolUseId)).toEqual([
    'a',
    'b',
    'c',
    'd',
  ]);
  // The runtime dropped records in between: refused instead of leaving a gap.
  const shifted = effectsSnapshot(
    { sessionId: 'one', sideEffects: [at('x'), at('y')], total: 4, start: 0 },
    'one',
  );
  expect(() => withOlderPage(latest.entries, shifted)).toThrow(/changed while paging/);
  expect(effectsSnapshot({ sessionId: 'one', sideEffects: [] }, 'one').start).toBeNull();
});
it('reads journal pages only with their position and reports engines without journal reads', () => {
  expect(
    journalEffectsSnapshot(
      {
        journalSideEffects: { sessionId: 'one', sideEffects: [effect], total: 9, start: 8 },
      },
      'one',
    ),
  ).toMatchObject({ total: 9, start: 8, truncated: true, entries: [effect] });
  expect(() => journalEffectsSnapshot({ id: 'one' }, 'one')).toThrow('session journal');
  expect(() => journalEffectsSnapshot({ id: 'one', error: 'Session not found' }, 'one')).toThrow(
    'Session not found',
  );
  expect(() =>
    journalEffectsSnapshot({ journalSideEffects: { sessionId: 'one', sideEffects: [] } }, 'one'),
  ).toThrow('position');
  expect(() =>
    journalEffectsSnapshot(
      { journalSideEffects: { sessionId: 'two', sideEffects: [], total: 0, start: 0 } },
      'one',
    ),
  ).toThrow('another');
});

it('words the recorded tool outcomes and keeps other text as recorded', () => {
  const t = (key: string, values: Record<string, string>) => `${key} ${JSON.stringify(values)}`;
  expect(outcomeText('launched (pid 42)', t)).toBe('effectsView.outcome.launched {"pid":"42"}');
  expect(outcomeText('started background job j1 (PID: 7)', t)).toBe(
    'effectsView.outcome.backgroundJob {"job":"j1","pid":"7"}',
  );
  expect(outcomeText('timed out (exit 124)', t)).toBe(
    'effectsView.outcome.timedOut {"code":"124"}',
  );
  expect(outcomeText('exit 0', t)).toBe('effectsView.outcome.exit {"code":"0"}');
  expect(outcomeText('error (spawn ENOENT)', t)).toBe(
    'effectsView.outcome.error {"message":"spawn ENOENT"}',
  );
  expect(outcomeText('aborted', t)).toBe('effectsView.outcome.aborted {}');
  expect(outcomeText('HTTP 200 (application/json)', t)).toBe('HTTP 200 (application/json)');
});
