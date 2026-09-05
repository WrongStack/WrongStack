/**
 * Reconnect re-seeding for the HQ chat data plane.
 *
 * `session.transcript` envelopes are broadcast live but never retained in the
 * server's `eventLog`, so the reconnect gap-fill cannot replay them: every
 * turn that landed while the socket was down would be a permanent hole in the
 * rendered chat unless the hook re-seeds from HTTP.
 *
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqTranscriptEntry } from '@wrongstack/core/hq';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../src/data/api.js', () => ({ fetchJson }));

const { useSessionTranscript } = await import('../../src/domain/use-session-transcript.js');
const { useHqStore } = await import('../../src/data/store/index.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ sessionId }: { sessionId: string }): ReactElement {
  const transcript = useSessionTranscript(sessionId, null);
  return <div data-testid="turns">{String(transcript.entries.length)}</div>;
}

function turns(): string | null {
  return container?.querySelector('[data-testid="turns"]')?.textContent ?? null;
}

// Distinct roles on purpose: consecutive assistant entries are folded into
// one bubble by `coalesceStreamedText`, which would hide the second turn.
function entry(text: string, role: HqTranscriptEntry['role'] = 'assistant'): HqTranscriptEntry {
  return { ts: `2026-07-14T12:00:0${text.length}.000Z`, role, text };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchJson.mockReset();
  useHqStore.setState({ connected: false, events: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('useSessionTranscript reconnect re-seed', () => {
  it('refetches the transcript when the socket comes back', async () => {
    fetchJson
      .mockResolvedValueOnce({ sessionId: 's1', total: 1, entries: [entry('one')] })
      .mockResolvedValueOnce({
        sessionId: 's1',
        total: 2,
        entries: [entry('one'), entry('two!!', 'user')],
      });

    container = document.createElement('div');
    document.body.append(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(<Probe sessionId="s1" />);
    });
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(turns()).toBe('1');

    // A drop alone must not refetch — only the recovery does.
    await act(async () => {
      useHqStore.setState({ connected: false });
    });
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      useHqStore.setState({ connected: true });
    });
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(turns()).toBe('2');
  });
});
