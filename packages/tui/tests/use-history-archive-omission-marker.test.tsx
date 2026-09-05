/**
 * Regression: the scroll-back cursor (`use-history-archive`) sized the first
 * page as `appendedCount - entries.length`, assuming every on-screen row has
 * an archive line at the tail. Retention's omission marker (id < 0) is a
 * screen row with no archive line, and the banner is archived at line 0 —
 * so once retention had run, scroll-back re-served the banner (duplicate ids
 * in state via `archiveLoaded`, which merged without an id-collision guard)
 * and the two newest omitted entries were unreachable.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { render } from 'ink-testing-library';
import type React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/app-reducer.js';
import type { State } from '../src/app-state.js';
import type { HistoryEntry } from '../src/history-entry.js';
import { useHistoryArchive } from '../src/hooks/use-history-archive.js';
import { Text } from '../src/ink.js';
import { reduceConversation } from '../src/reducers/conversation.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-archive-marker-'));
  directories.push(directory);
  return directory;
}

function fullHistory(): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    { id: 0, kind: 'banner', version: 'test', provider: 'p', model: 'm', cwd: 'c' },
  ];
  for (let id = 1; id <= 10; id++) {
    entries.push({ id, kind: 'info', text: `entry-${id}` });
  }
  return entries;
}

/** The window retention keeps after the transcript outgrows the budget. */
function trimmedWindow(): HistoryEntry[] {
  return [
    fullHistory()[0] as HistoryEntry,
    {
      id: -8,
      kind: 'info',
      text: '… 7 earlier TUI entries omitted (full session remains on disk).',
    },
    ...(fullHistory().slice(8) as HistoryEntry[]),
  ];
}

function withEntries(stateEntries: HistoryEntry[], loaded: HistoryEntry[]): HistoryEntry[] {
  const state = reduceConversation(
    { entries: stateEntries, nextId: 11, archiveLoading: false } as unknown as State,
    { type: 'archiveLoaded', entries: loaded } as unknown as Parameters<
      typeof reduceConversation
    >[1],
  );
  return state.entries as HistoryEntry[];
}

const SESSION_ID = 'session-under-test';

interface HarnessProps {
  entries: HistoryEntry[];
  dispatch: React.Dispatch<Action>;
  sessionsDir: string;
  onReady: (request: () => void) => void;
}

function ArchiveHarness({
  entries,
  dispatch,
  sessionsDir,
  onReady,
}: HarnessProps): React.ReactElement {
  const { onRequestOlderEntries } = useHistoryArchive({
    entries,
    dispatch,
    sessionsDir,
    sessionId: SESSION_ID,
  });
  onReady(onRequestOlderEntries);
  return <Text>archive</Text>;
}

/** Let the async archive open (rm + construct) and any queued writes settle. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 6; pass++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe('scroll-back with a retention omission marker on screen', () => {
  it('serves every omitted entry exactly once instead of re-serving the banner', async () => {
    const sessionsDir = await temporaryDirectory();
    const dispatch = vi.fn();
    let request: () => void = () => {};
    let view!: ReturnType<typeof render>;

    await act(async () => {
      view = render(
        <ArchiveHarness
          entries={fullHistory()}
          dispatch={dispatch}
          sessionsDir={sessionsDir}
          onReady={(next) => {
            request = next;
          }}
        />,
      );
    });
    await settle();

    // Retention trims the window: banner + omission marker + newest tail.
    await act(async () => {
      view.rerender(
        <ArchiveHarness
          entries={trimmedWindow()}
          dispatch={dispatch}
          sessionsDir={sessionsDir}
          onReady={(next) => {
            request = next;
          }}
        />,
      );
    });
    await settle();

    dispatch.mockClear();
    const servedIds: number[] = [];
    let stateEntries = trimmedWindow();
    for (let round = 0; round < 5; round++) {
      await act(async () => {
        request();
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      const loadedAction = dispatch.mock.calls
        .map(([action]) => action as { type: string; entries?: HistoryEntry[] })
        .find((action) => action.type === 'archiveLoaded');
      const loaded = loadedAction?.entries ?? [];
      servedIds.push(...loaded.map((entry) => entry.id));
      stateEntries = withEntries(stateEntries, loaded);
      dispatch.mockClear();
      if (loaded.length === 0) break;
    }

    // Every omitted id must be reachable — pre-fix, ids 6 and 7 never were.
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      expect(servedIds).toContain(id);
    }
    // The banner (id 0) may arrive in a page but must never be duplicated.
    const ids = stateEntries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(ids).toContain(id);
    }

    act(() => view.unmount());
  });
});
