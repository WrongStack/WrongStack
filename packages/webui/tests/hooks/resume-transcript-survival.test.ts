import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a resumed tab is allowed to show.
 *
 * All three cases here were live defects with the same visible symptom — a tab
 * that opens on an empty chat where a conversation should be — and three
 * unrelated causes. They are asserted together because the fix for each is a
 * single condition, and any of them regressing alone reproduces the whole
 * report ("resume brings the tab back with nothing in it").
 */

const requestedSwitches = new Set<string>();

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    send: () => {},
    consumeRequestedSwitch: (id: string) => requestedSwitches.delete(id),
    subscribeSessions: () => {},
    focusSessionById: () => {},
    getChimeraReports: () => {},
  }),
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { chatLane, readLane, useChatLanes } from '../../src/stores/chat-lanes';
import { useResumeProgressStore } from '../../src/stores/resume-progress-store';
import { setActiveSessionLane, useSessionLanes } from '../../src/stores/session-lanes';
import { useSessionTabStore } from '../../src/stores/session-tab-store';
import type { WSServerMessage } from '../../src/types';

const A = 'sess_alpha';
const B = 'sess_bravo';

/**
 * Both lane registries and the tab strip, back to "nothing open".
 *
 * The foreground pointer lives in `session-lanes`, not `chat-lanes` — resetting
 * only the latter leaves `openTab` believing the previous test's tab is still
 * in front, which it answers with `already_active` instead of a resume.
 */
function resetSurface(): void {
  requestedSwitches.clear();
  useChatLanes.setState({ lanes: {}, activeSessionId: undefined });
  useSessionLanes.setState({ lanes: {} });
  setActiveSessionLane(null);
  useSessionTabStore.setState({ openTabIds: [] });
  useResumeProgressStore.getState().clear();
}

function transcript(from: string, count = 2): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${from} message ${i}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
}

function sessionStart(payload: Record<string, unknown>): void {
  WS_HANDLERS['session.start']?.({
    type: 'session.start',
    payload: { model: 'm', provider: 'p', ...payload },
  } as unknown as WSServerMessage);
}

/** Open a tab the way every resume entry point does, and answer it. */
function openWithTranscript(sessionId: string, count = 2): void {
  requestedSwitches.add(sessionId);
  useSessionTabStore.getState().openTab(sessionId, { resumeSession: () => {} });
  sessionStart({ sessionId, reset: true, replayMessages: transcript(sessionId, count) });
}

describe('a resumed tab keeps its transcript', () => {
  beforeEach(() => {
    resetSurface();
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    });
  });

  /**
   * The server answers a focus with `reset: true` and NO messages, because the
   * tab is already showing the conversation. The client used to decide whether
   * that was a real clear by asking "is this lane the one in front?" — but the
   * tab store moves the active lane BEFORE it sends the focus, so the answer
   * was always yes and the frame fell through to `clearMessages()`. Every
   * switch back to an open tab emptied it.
   */
  it('survives switching away and back (a transcript-less focus answer)', () => {
    openWithTranscript(A);
    expect(readLane(A).messages.length).toBeGreaterThan(0);
    openWithTranscript(B);

    const before = readLane(A).messages.length;
    useSessionTabStore.getState().openTab(A, {
      resumeSession: () => {
        throw new Error('an open tab must be focused, never resumed');
      },
    });
    sessionStart({ sessionId: A, reset: true, replayReason: 'focus', isRunning: false });

    expect(readLane(A).messages).toHaveLength(before);
    expect(readLane(B).messages.length).toBeGreaterThan(0);
  });

  /**
   * A large journal takes the server seconds to replay, and in that window the
   * lane can pick up content of its own while the user clicks elsewhere and
   * back. Both make the lane "known and populated", which is the shape the
   * background-re-announce guard discards — so the transcript the user waited
   * for was thrown away on arrival, and no later click could ask again (an
   * open tab is focused, and a focus carries nothing).
   */
  it('lands even when the wait outlived the click that asked for it', () => {
    requestedSwitches.add(A);
    useSessionTabStore.getState().openTab(A, { resumeSession: () => {} });
    // Something else reaches the lane first, and the user moves on.
    chatLane(A).addMessage({ role: 'system', content: 'a notice' });
    openWithTranscript(B);

    sessionStart({ sessionId: A, reset: true, replayMessages: transcript(A, 4) });

    expect(readLane(A).messages.length).toBeGreaterThan(1);
    expect(readLane(A).messages.some((m) => m.content.includes('sess_alpha message'))).toBe(true);
  });

  /**
   * A run that is still streaming is the one record genuinely ahead of the
   * journal, so it still wins over a replay.
   */
  it('does not overwrite a lane whose run is still streaming', () => {
    openWithTranscript(A, 4);
    const streaming = readLane(A).messages.length;

    requestedSwitches.add(A);
    sessionStart({ sessionId: A, reset: true, isRunning: true, replayMessages: transcript(A, 1) });

    expect(readLane(A).messages).toHaveLength(streaming);
  });
});

describe('the tab says it is waiting', () => {
  beforeEach(() => {
    resetSurface();
  });

  it('marks the tab restoring from the request until the answer', () => {
    requestedSwitches.add(A);
    useSessionTabStore.getState().openTab(A, { resumeSession: () => {} });
    expect(useResumeProgressStore.getState().startedAt[A]).toBeTypeOf('number');

    sessionStart({ sessionId: A, reset: true, replayMessages: transcript(A) });
    expect(useResumeProgressStore.getState().startedAt[A]).toBeUndefined();
  });

  it('stops waiting when the resume is refused instead of answered', () => {
    requestedSwitches.add(A);
    useSessionTabStore.getState().openTab(A, { resumeSession: () => {} });

    WS_HANDLERS['error']?.({
      type: 'error',
      payload: { phase: 'session.resume', message: 'nope', sessionId: A },
    } as unknown as WSServerMessage);

    expect(useResumeProgressStore.getState().startedAt[A]).toBeUndefined();
  });

  it('records server-reported journal progress and clears it on the answer', () => {
    requestedSwitches.add(A);
    useSessionTabStore.getState().openTab(A, { resumeSession: () => {} });

    WS_HANDLERS['session.resume_progress']?.({
      type: 'session.resume_progress',
      payload: { sessionId: A, stage: 'open_journal', loadedBytes: 512, totalBytes: 1024 },
    } as unknown as WSServerMessage);

    expect(useResumeProgressStore.getState().progress[A]).toMatchObject({
      stage: 'open_journal',
      loadedBytes: 512,
      totalBytes: 1024,
    });

    sessionStart({ sessionId: A, reset: true, replayMessages: transcript(A) });
    expect(useResumeProgressStore.getState().progress[A]).toBeUndefined();
  });

  it('does not mark a plain tab switch as restoring — nothing was requested', () => {
    openWithTranscript(A);
    openWithTranscript(B);
    useResumeProgressStore.getState().clear();

    useSessionTabStore.getState().openTab(A, { resumeSession: () => {} });
    expect(useResumeProgressStore.getState().startedAt[A]).toBeUndefined();
  });
});

/**
 * The slot rules the surface actually enforces.
 *
 * Four slots, one session per slot. These are asserted because the resume
 * fixes above only hold if "which tab does this session land in" behaves the
 * way the strip claims: a session already on screen is switched to and never
 * re-read from disk, and a strip with nothing to give refuses rather than
 * quietly displacing a conversation.
 */
describe('tab slots', () => {
  beforeEach(() => {
    resetSurface();
  });

  it('holds four and refuses the fifth rather than displacing one', () => {
    const ids = ['s1', 's2', 's3', 's4'];
    for (const id of ids) openWithTranscript(id);

    const fifth = useSessionTabStore.getState().openTab('s5', {
      resumeSession: () => {
        throw new Error('a refused open must not reach the server');
      },
    });

    expect(fifth).toEqual({ success: false, reason: 'tabs_full' });
    expect(useSessionTabStore.getState().openTabIds).toEqual(ids);
  });

  it('switches to a session that already owns a slot — never resumes it again', () => {
    openWithTranscript(A);
    openWithTranscript(B);

    const again = useSessionTabStore.getState().openTab(A, {
      resumeSession: () => {
        throw new Error('a session on screen must be focused, not resumed');
      },
    });

    expect(again).toEqual({ success: true, reason: 'switched' });
    expect(useSessionTabStore.getState().openTabIds).toEqual([A, B]);
    // And it is a switch, not a wait: nothing is being read back from disk.
    expect(useResumeProgressStore.getState().startedAt[A]).toBeUndefined();
  });

  it('recycles an empty background slot instead of refusing', () => {
    openWithTranscript('s1');
    openWithTranscript('s2');
    openWithTranscript('s3');
    // A slot that was opened but never carried a conversation.
    requestedSwitches.add('blank');
    useSessionTabStore.getState().openTab('blank', { resumeSession: () => {} });
    useResumeProgressStore.getState().clear();
    // Move the foreground off it, so it is a recyclable BACKGROUND slot.
    useSessionTabStore.getState().openTab('s1', { resumeSession: () => {} });

    const opened = useSessionTabStore.getState().openTab('s5', { resumeSession: () => {} });

    expect(opened.success).toBe(true);
    expect(useSessionTabStore.getState().openTabIds).toContain('s5');
    expect(useSessionTabStore.getState().openTabIds).not.toContain('blank');
  });
});
