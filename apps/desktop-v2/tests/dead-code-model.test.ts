import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeadCodePlan, DeadCodeResult } from '../src/DeadCodePlan';
import {
  deadCodeApplyBody,
  deadCodeRequest,
  deadCodeRestoreOutcome,
  filterDeadCode,
  sameDeadCodePlan,
} from '../src/dead-code-model';
import { beginDeadCodeWork, getDeadCodeWork, updateDeadCodeWork } from '../src/dead-code-work';

const findings = [
  {
    id: '1',
    file: 'src/a.ts',
    name: 'oldFunction',
    package: 'app',
    category: 'dead-export',
    confidence: 'high',
    reason: 'Nothing references this declaration.',
    fix: 'remove-declaration',
  },
  {
    id: '2',
    file: 'src/b.ts',
    name: 'testHelper',
    category: 'test-only-export',
    confidence: 'medium',
    reason: 'Only tests use it.',
    manualReason: 'Review test coverage.',
  },
  {
    id: '3',
    file: 'src/c.ts',
    name: 'publicApi',
    category: 'unused-public-export',
    confidence: 'low',
    reason: 'No local consumers.',
  },
];
describe('Desktop dead-code review', () => {
  it('distinguishes historical overwritten conflicts from unresolved restoration conflicts', () => {
    expect(deadCodeRestoreOutcome([], ['a.ts'])).toEqual({
      remaining: ['a.ts'],
      notice: '0 files restored; 1 conflicts remain.',
    });
    expect(deadCodeRestoreOutcome(['a.ts'], ['a.ts'])).toEqual({
      remaining: [],
      notice: '1 file restored.',
    });
    expect(deadCodeRestoreOutcome(['a.ts'], ['a.ts', 'b.ts']).remaining).toEqual(['b.ts']);
  });
  it('keeps confidence, category, package search and mechanical fix filters distinct', () => {
    expect(filterDeadCode(findings, '', 'medium', '', false)).toHaveLength(2);
    expect(filterDeadCode(findings, '', 'low', '', true).map((item) => item['id'])).toEqual(['1']);
    expect(filterDeadCode(findings, '', 'high', 'APP', false)).toHaveLength(1);
    expect(
      filterDeadCode(findings, 'test-only-export', 'medium', '', false).map((item) => item['id']),
    ).toEqual(['2']);
  });
  it('refuses changed diffs, linked findings and skipped work before execution', () => {
    const plan = {
      changes: [{ file: 'src/a.ts', action: 'edit', diff: '-old\n+new', findingIds: ['1'] }],
      planned: ['1'],
      skipped: [],
    };
    expect(sameDeadCodePlan(plan, structuredClone(plan))).toBe(true);
    expect(
      sameDeadCodePlan(plan, { ...plan, changes: [{ ...plan.changes[0], diff: '-other\n+new' }] }),
    ).toBe(false);
    expect(sameDeadCodePlan(plan, { ...plan, planned: ['1', 'newly-linked'] })).toBe(false);
    expect(sameDeadCodePlan(plan, { ...plan, skipped: [{ id: '1', reason: 'changed' }] })).toBe(
      false,
    );
  });
  it('treats a reordered identical plan as the same operation', () => {
    const changes = [
      { file: 'a', action: 'delete', diff: '-a', findingIds: ['a', 'b'] },
      { file: 'b', action: 'edit', diff: '-b', findingIds: ['c'] },
    ];
    expect(
      sameDeadCodePlan(
        { changes, planned: ['a', 'b', 'c'] },
        {
          changes: [changes[1], { ...changes[0], findingIds: ['b', 'a'] }],
          planned: ['c', 'b', 'a'],
        },
      ),
    ).toBe(true);
  });
  it('retains the owning project operation and refuses duplicate starts', () => {
    const a = crypto.randomUUID(),
      b = crypto.randomUUID();
    expect(beginDeadCodeWork(a, 'applying')).toBe(true);
    expect(beginDeadCodeWork(a, 'applying again')).toBe(false);
    expect(beginDeadCodeWork(b, 'scanning')).toBe(true);
    updateDeadCodeWork(a, {
      busy: '',
      result: { ok: true },
      notice: 'Saved',
      scanScope: 'src',
      includePublicApi: true,
    });
    expect(getDeadCodeWork(a).scanScope).toBe('src');
    expect(getDeadCodeWork(a).includePublicApi).toBe(true);
    expect(getDeadCodeWork(a).result).toEqual({ ok: true });
    expect(getDeadCodeWork(b).busy).toBe('scanning');
    expect(beginDeadCodeWork(a, 'restoring')).toBe(true);
  });
  it('prepares a bounded request with real evidence and manual-fix semantics', () => {
    const text = deadCodeRequest(findings);
    expect(text).toContain('Nothing references this declaration.');
    expect(text).toContain('Review test coverage.');
    expect(text).toContain('normal permission flow');
    expect(
      deadCodeRequest(Array.from({ length: 201 }, (_, i) => ({ ...findings[0], id: String(i) }))),
    ).toContain('1 additional findings omitted');
  });
  it('renders actual diffs, rollback, exclusions and verification output without object dumps', () => {
    const plan = {
      changes: [
        { file: 'src/a.ts', action: 'edit', diff: '@@ -1 +1 @@\n-old\n+new', findingIds: ['1'] },
      ],
      skipped: [{ id: 'manual', reason: 'Manual only' }],
      notes: ['Linked re-export included.'],
    };
    const markup = renderToStaticMarkup(createElement(DeadCodePlan, { plan, onOpenFile() {} }));
    expect(markup).toContain('dead-diff-add');
    expect(markup).toContain('dead-diff-remove');
    expect(markup).toContain('Manual only');
    const result = renderToStaticMarkup(
      createElement(DeadCodeResult, {
        result: {
          ok: false,
          rolledBack: true,
          changed: [],
          deleted: [],
          attempts: 1,
          verify: [
            {
              package: 'app',
              command: 'bun run typecheck',
              ok: false,
              output: 'Type mismatch',
              durationMs: 10,
            },
          ],
          excluded: [{ id: '1', reason: 'Required by another file.' }],
        },
      }),
    );
    expect(result).toContain('Changes rolled back');
    expect(result).toContain('Type mismatch');
    expect(result).not.toContain('[object Object]');
  });
});

it('binds an apply to the reviewed preview revision when the engine reports one', () => {
  expect(deadCodeApplyBody(['a'], true, { revision: 'abc', changes: [] })).toEqual({
    ids: ['a'],
    verify: 'typecheck',
    expectedRevision: 'abc',
  });
  expect(deadCodeApplyBody(['a'], false, { changes: [] })).toEqual({ ids: ['a'], verify: 'none' });
});
