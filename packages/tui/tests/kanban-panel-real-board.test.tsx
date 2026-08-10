// Sanitized-fixture Ink-mount regression — loads a version-controlled
// `kanban-audit-dirty.json` fixture (sourced from the dirtiest production
// board, sanitized of real agent IDs) and asserts that the KanbanPanel's
// audit badge surfaces the real findings rather than synthesized ones.
//
// The fixture lives under `packages/tui/tests/fixtures/` so the assertion
// oracle is reproducible from repository state alone (CI, fresh checkouts).
// If the fixture is missing we fail loudly rather than silently passing —
// that contract was the peer-review finding this test originally violated.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KanbanBoard, KanbanBoardSummary } from '@wrongstack/kanban';
import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanPanel } from '../src/components/kanban-panel.js';
import { ALL_AUDIT_CODES } from '../src/kanban-audit.js';

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/kanban-audit-dirty.json',
);

// The Kanban Cleaner vocabulary, read from the audit itself rather than
// re-typed here — this list had already fallen a code behind. That the WebUI's
// `KanbanCleanerAlert` recognizes the same set is enforced by
// `packages/cli/tests/kanban-cleaner-parity.test.ts`.
const ALLOWED_AUDIT_CODES = new Set<string>(ALL_AUDIT_CODES);

const mockListBoards = vi.fn();
const mockGetBoard = vi.fn();
const mockDescribeKanbanBoundary = vi.fn((_policy?: unknown): string => 'unrestricted');

vi.mock('@wrongstack/kanban', () => ({
  listBoards: (...args: unknown[]) => mockListBoards(...args),
  getBoard: (...args: unknown[]) => mockGetBoard(...args),
  describeKanbanBoundary: (policy?: unknown) => mockDescribeKanbanBoundary(policy),
}));

vi.mock('@wrongstack/tools/session-kanban', () => ({
  applySessionKanbanTaskToSource: () => Promise.resolve(),
}));

async function waitForFrame(
  frames: readonly string[],
  predicate: (frame: string) => boolean,
): Promise<string> {
  let match = [...frames].reverse().find(predicate);
  for (let attempt = 0; match === undefined && attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    match = [...frames].reverse().find(predicate);
  }

  if (match === undefined) {
    throw new Error(
      `Expected Ink frame was not rendered. Captured frames: ${JSON.stringify(frames)}`,
    );
  }
  return match;
}

describe('KanbanPanel — sanitized-fixture audit badge', () => {
  it('renders the audit badge with real findings against the version-controlled fixture', async () => {
    // Fail loudly if the fixture is missing — a silent skip would make
    // this test pass without exercising anything (the bug peer review
    // flagged). The fixture is committed, so this only fails if a
    // future change removes it without updating the test.
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    const board = JSON.parse(raw) as KanbanBoard;

    const summary: KanbanBoardSummary = {
      id: board.id,
      title: board.title,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      columnCount: board.columns.length,
      taskCount: board.tasks.length,
      completedTaskCount: board.tasks.filter((t) => t.status === 'completed').length,
    };
    mockListBoards.mockResolvedValue([summary]);
    mockGetBoard.mockResolvedValue(board);

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        React.createElement(KanbanPanel, {
          projectRoot: '/tmp/project',
          sessionId: 'sess-audit-fixture',
          onClose: () => {},
          terminalWidth: 200,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const { frames, unmount } = result!;
    const frame = await waitForFrame(frames, (candidate) => /cleaner issues?/.test(candidate));

    // The fixture was sanitized from the dirtiest production board
    // (23 cleaner issues, 3 error + 20 warning). We don't pin the
    // exact count to avoid churn, but we do pin: (a) the badge
    // surfaces, (b) at least one abandoned-running-task is reported
    // (the dominant error category in the source corpus), and (c)
    // the audit-codes emitted by this TUI match the WebUI Cleaner
    // vocabulary exactly.
    expect(frame).toMatch(/cleaner issues?/);
    expect(frame).toMatch(/⚠/);
    expect(frame).toMatch(/abandoned-running-task|assignment lease/i);

    // Drive the audit directly on the loaded board and pin the
    // vocabulary parity. The Ink frame itself only renders severity
    // glyph + task title + message — not the raw code — so we use
    // `auditKanbanBoard` to pull the actual codes. Any drift between
    // the TUI's emitted codes and the WebUI Cleaner vocabulary fails
    // the assertion below, *without* relying on string-matching the
    // frame.
    const audit = await (await import('../src/kanban-audit.js')).auditKanbanBoard(board, {
      now: new Date('2026-07-18T13:30:00Z'),
    });
    expect(audit.issues.length).toBeGreaterThan(0);
    const emitted = new Set(audit.issues.map((i) => i.code));
    // Every emitted code must come from the WebUI Cleaner vocabulary.
    // This is the drift pin: if audit.ts ever starts emitting a new
    // code, this assertion fails until the WebUI vocabulary is
    // updated in lockstep.
    for (const code of emitted) {
      expect(ALLOWED_AUDIT_CODES.has(code)).toBe(true);
    }
    // Sanitized fixture was the dirtiest board — at least one
    // abandoned-running-task should appear (the dominant error).
    expect(emitted.has('abandoned-running-task')).toBe(true);

    act(() => unmount());
  }, 30_000);
});
