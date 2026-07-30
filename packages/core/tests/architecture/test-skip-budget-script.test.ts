import { describe, expect, it } from 'vitest';
import {
  collectSkipDeclarations,
  validateSkipBudget,
} from '../../../../scripts/lib/test-skip-budget.mjs';

describe('test skip budget', () => {
  it('returns an empty declaration list for ordinary tests', () => {
    expect(
      collectSkipDeclarations("it('runs', () => expect(true).toBe(true));", 'ok.test.ts'),
    ).toEqual([]);
  });

  it('finds direct, conditional, runtime, and aliased skip declarations', () => {
    const dot = '.';
    const declarations = collectSkipDeclarations(
      [
        `it${dot}skip('debt', () => {});`,
        `describe${dot}skipIf(!ready)('environment suite', () => {});`,
        `(process.platform === 'win32' ? it : it${dot}skip)(`,
        "  'platform case',",
        ');',
        "it('runtime', ({ skip }) => {",
        ['  return ', "skip('unsupported');"].join(''),
        '});',
        `const describeIfGit = hasGit ? describe : describe${dot}skip;`,
        "describeIfGit('git suite', () => {});",
      ].join('\n'),
      'packages/example/tests/example.test.ts',
    );

    expect(declarations.map((item) => item.kind).sort()).toEqual([
      'conditional-skip',
      'conditional-skip',
      'conditional-suite-alias',
      'runtime-skip',
      'skip',
      'skip',
      'skip',
      'skipIf',
    ]);
  });

  it('rejects both new declarations and stale baseline entries', () => {
    const current = [
      { file: 'a.test.ts', kind: 'skip', fingerprint: 'kept' },
      { file: 'a.test.ts', kind: 'skipIf', fingerprint: 'new' },
    ];
    expect(
      validateSkipBudget(current, {
        schemaVersion: 1,
        declarations: [
          { file: 'a.test.ts', kind: 'skip', fingerprint: 'kept' },
          { file: 'b.test.ts', kind: 'runIf', fingerprint: 'resolved' },
        ],
      }),
    ).toEqual([
      'a.test.ts: 1 new or changed skipIf declaration(s)',
      'b.test.ts: 1 resolved or changed runIf declaration(s); tighten the reviewed budget',
    ]);
  });

  it('counts duplicate declarations and accepts an identical budget', () => {
    const row = { file: 'a.test.ts', kind: 'skip', fingerprint: 'same' };
    expect(validateSkipBudget([row, row], { schemaVersion: 1, declarations: [row] })).toEqual([
      'a.test.ts: 1 new or changed skip declaration(s)',
    ]);
    expect(validateSkipBudget([row], { schemaVersion: 1, declarations: [row] })).toEqual([]);
    expect(validateSkipBudget([], { schemaVersion: 1, declarations: [] })).toEqual([]);
    expect(validateSkipBudget([], { schemaVersion: 1, declarations: undefined } as never)).toEqual(
      [],
    );
  });
});
