// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { surfaceI18n } from '../src/surface-i18n';
import { WorktreeHistory } from '../src/WorktreeHistory';
import { WorktreeLanes } from '../src/WorktreeViews';
import { cleanupOutcome, mergeOutcome, type WorktreeView } from '../src/worktree-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = Date.parse('2026-11-04T09:00:00.000Z');
const events = [
  {
    kind: 'allocated',
    at: T,
    handleId: 'h1',
    branch: 'wstack/ap/goal-1',
    baseBranch: 'main',
    ownerLabel: 'goal phase 1',
  },
  { kind: 'merged', at: T + 120_000, handleId: 'h1', branch: 'wstack/ap/goal-1', squash: true },
  { kind: 'released', at: T + 125_000, handleId: 'h1' },
] as never;

const lanes = () =>
  renderToStaticMarkup(
    createElement(WorktreeLanes, {
      worktrees: [
        {
          handleId: 'h1',
          branch: 'wstack/ap/goal-1',
          status: 'active',
          ownerLabel: 'goal',
          insertions: 1,
          deletions: 2,
          files: 3,
          allocatedAt: T,
        } as unknown as WorktreeView,
      ],
      baseBranch: 'main',
    }),
  ).replaceAll('<!-- -->', '');

async function history() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(WorktreeHistory, { events })));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('Worktrees in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates lanes, history and outcomes in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    expect(lanes()).toContain('Base <code>main</code> · 1 isolated');
    expect(lanes()).toContain('Active');
    expect(await history()).toContain('1 merged');
    expect(cleanupOutcome({ ok: true, removed: 2 })).toBe('Removed 2 items.');
    expect(mergeOutcome({ ok: false, branch: 'b', conflict: true })).toBe(
      'b was not merged: conflicts in the checkout.',
    );

    await surfaceI18n.changeLanguage('tr');
    expect(lanes()).toContain('Temel <code>main</code> · 1 yalıtılmış');
    expect(lanes()).toContain('Etkin');
    expect(await history()).toContain('1 birleştirildi');
    const t = surfaceI18n.getFixedT('tr', 'desktop');
    const say = (word: string, values?: Record<string, string | number>) =>
      t(`worktrees.outcome.${word}`, values ?? {});
    expect(cleanupOutcome({ ok: true, removed: 2 }, say)).toBe('2 öğe kaldırıldı.');
    expect(mergeOutcome({ ok: false, branch: 'b', conflict: true }, say)).toBe(
      'b birleştirilmedi: checkout içinde çakışmalar var.',
    );
  });
});
