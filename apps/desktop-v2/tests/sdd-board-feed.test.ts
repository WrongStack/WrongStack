// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SddBoardDetail } from '../src/SddBoardDetail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(board: Record<string, unknown>, task?: Record<string, unknown>) {
  const host = document.createElement('div');
  act(() =>
    createRoot(host).render(
      createElement(SddBoardDetail, {
        task,
        tasks: task ? [task] : [],
        board,
        waiting: false,
        request: vi.fn(async () => undefined),
        onSelect: vi.fn(),
      }),
    ),
  );
  return host;
}

describe('SDD board activity beside the tasks', () => {
  it('lists the board feed newest first with what happened and when', () => {
    const now = Date.now();
    const host = mount({
      runId: 'r1',
      feed: [
        { ts: now - 5_000, kind: 'completed', text: 'T2 done (Write tests)' },
        { ts: now - 120_000, kind: 'verification_failed', text: 'T1 checks failed' },
      ],
    });
    const lines = [...host.querySelectorAll('article')].map((article) => article.textContent);
    expect(lines[0]).toMatch(/^Completed\d+s agoT2 done \(Write tests\)$/);
    expect(lines[1]).toBe('Verification failed2m agoT1 checks failed');
  });

  it('explains an empty feed', () => {
    expect(mount({ runId: 'r1' }).textContent).toContain('Task pickups, completions');
  });

  it('shows the selected task instead of the feed', () => {
    const host = mount(
      { runId: 'r1', status: 'completed', feed: [{ ts: 1, kind: 'started', text: 'x' }] },
      { id: 't1', shortId: 'T1', title: 'Write tests', status: 'completed' },
    );
    expect(host.querySelector('[aria-label="Board activity"]')).toBeNull();
    expect(host.textContent).toContain('Write tests');
  });
});
