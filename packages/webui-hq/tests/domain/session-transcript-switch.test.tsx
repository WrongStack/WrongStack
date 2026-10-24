/**
 * Switching the viewed session must not carry the previous session's turns
 * into the new one. The reset effect clears the state, but the live-append
 * effect of the SAME commit folds the new session's buffered
 * `session.transcript` batches onto the stale ref and overwrites the reset.
 *
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqTranscriptEntry } from '@wrongstack/hq';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchJson = vi.fn();
vi.mock('../../src/data/api.js', () => ({ fetchJson }));

const { useSessionTranscript } = await import('../../src/domain/use-session-transcript.js');
const { useHqStore } = await import('../../src/data/store/index.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({
  sessionId,
  agentId = null,
}: {
  sessionId: string;
  agentId?: string | null;
}): ReactElement {
  const transcript = useSessionTranscript(sessionId, agentId);
  return <div data-testid="texts">{transcript.entries.map((e) => e.text).join('|')}</div>;
}

const texts = (): string => container?.querySelector('[data-testid="texts"]')?.textContent ?? '';

function entry(text: string, role: HqTranscriptEntry['role']): HqTranscriptEntry {
  return { ts: '2026-07-14T12:00:00.000Z', role, text };
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

describe('useSessionTranscript session switch', () => {
  it('drops the previous session turns when the viewed session changes', async () => {
    fetchJson.mockResolvedValueOnce({
      sessionId: 'A',
      total: 2,
      entries: [entry('A-one', 'user'), entry('A-two', 'tool')],
    });
    fetchJson.mockReturnValueOnce(new Promise(() => undefined)); // B's seed never lands

    container = document.createElement('div');
    document.body.append(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(<Probe sessionId="A" />);
    });
    await flush();
    expect(texts()).toBe('A-one|A-two');

    // Session B already has live batches buffered in the event ring.
    await act(async () => {
      useHqStore.setState({
        events: [
          {
            id: 'e1',
            type: 'session.transcript',
            sessionId: 'B',
            clientId: 'c',
            seq: 1,
            payload: { fromSeq: 0, entries: [entry('B-live', 'assistant')] },
          } as never,
        ],
      });
    });
    await act(async () => {
      created.render(<Probe sessionId="B" />);
    });
    await flush();

    expect(texts()).toBe('B-live');
  });

  it('control: a switch with no buffered live batches starts empty', async () => {
    fetchJson.mockResolvedValueOnce({
      sessionId: 'A',
      total: 1,
      entries: [entry('A-one', 'user')],
    });
    fetchJson.mockReturnValueOnce(new Promise(() => undefined));
    container = document.createElement('div');
    document.body.append(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(<Probe sessionId="A" />);
    });
    await flush();
    await act(async () => {
      created.render(<Probe sessionId="B" />);
    });
    await flush();
    expect(texts()).toBe('');
  });

  it('keeps the session transcript when the selection moves from no agent to the leader', async () => {
    // The leader IS the session conversation (same plane, same fetch): picking
    // it in the fleet nav must not blank a transcript that is already loaded.
    fetchJson.mockResolvedValue({
      sessionId: 'A',
      total: 2,
      entries: [entry('A-one', 'user'), entry('A-two', 'tool')],
    });
    container = document.createElement('div');
    document.body.append(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(<Probe sessionId="A" agentId={null} />);
    });
    await flush();
    expect(texts()).toBe('A-one|A-two');

    await act(async () => {
      created.render(<Probe sessionId="A" agentId="leader" />);
    });
    await flush();
    expect(texts()).toBe('A-one|A-two');
  });

  it('populates meta.total and preserves repeated same-timestamp seed deltas when viewing a subagent (F153)', async () => {
    fetchJson.mockResolvedValueOnce({
      subagentId: 'sub-1',
      total: 2,
      source: 'stream',
      entries: [entry('0', 'assistant'), entry('0', 'assistant')],
    });
    let latestMeta: { total: number; source?: string } = { total: 0 };
    function SubProbe(): ReactElement {
      const transcript = useSessionTranscript('A', 'sub-1');
      latestMeta = transcript.meta;
      return <div data-testid="texts">{transcript.entries.map((e) => e.text).join('|')}</div>;
    }
    container = document.createElement('div');
    document.body.append(container);
    const created = createRoot(container);
    root = created;
    await act(async () => {
      created.render(<SubProbe />);
    });
    await flush();
    expect(texts()).toBe('00');
    expect(latestMeta).toEqual({ total: 2, source: 'stream' });
  });
});
