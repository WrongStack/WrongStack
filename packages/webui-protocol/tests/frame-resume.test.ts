import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameResume } from '../src/frame-resume.js';

type Frame = { type: string; seq?: number; stream?: string; payload: Record<string, unknown> };
const f = (seq: number, sessionId = 's1', text = `t${seq}`): Frame => ({
  type: 'provider.text_delta',
  seq,
  payload: { sessionId, text },
});
const texts = (frames: Frame[]) => frames.map((x) => x.payload['text']);
/** The gate a client's `FrameResume` owns. */
const newGate = () => new FrameResume<Frame>(() => undefined).gate;

describe('FrameResume gate', () => {
  it('passes frames straight through outside a resume, gaps included', () => {
    const gate = newGate();
    expect(texts(gate.accept(f(1)))).toEqual(['t1']);
    // A frame broadcast while no tab showed the session never came: accepted.
    expect(texts(gate.accept(f(5)))).toEqual(['t5']);
    expect(texts(gate.accept({ type: 'sessions.list', payload: {} }))).toEqual([undefined]);
  });

  it('drops a frame it already applied', () => {
    const gate = newGate();
    gate.accept(f(1));
    gate.accept(f(2));
    expect(gate.accept(f(2))).toEqual([]);
    expect(gate.accept(f(1))).toEqual([]);
  });

  it('holds live frames that skip ahead during a resume, then applies them in order', () => {
    const gate = newGate();
    gate.adoptEpoch('e1');
    gate.accept(f(1));
    gate.accept(f(2));
    expect(gate.cursors(['s1', 'other'])).toEqual({ eventEpoch: 'e1', cursors: { s1: 2 } });
    gate.beginResume(['s1']);

    // The new connection's live frames race the catch-up.
    expect(gate.accept(f(5))).toEqual([]);
    expect(gate.accept(f(6))).toEqual([]);
    // The catch-up fills the gap; the held frames follow in order, and the
    // catch-up's own copy of 5 is not applied twice.
    expect(texts(gate.accept(f(3)))).toEqual(['t3']);
    expect(texts(gate.accept(f(4)))).toEqual(['t4', 't5', 't6']);
    expect(gate.accept(f(5))).toEqual([]);
    expect(gate.finishResume('s1')).toEqual([]);
    expect(texts(gate.accept(f(7)))).toEqual(['t7']);
  });

  it('releases what waited, in order, when the catch-up is refused', () => {
    const gate = newGate();
    gate.adoptEpoch('e1');
    gate.accept(f(1));
    gate.beginResume(['s1']);
    gate.accept(f(9));
    gate.accept(f(7));
    expect(texts(gate.finishResume('s1'))).toEqual(['t7', 't9']);
    expect(gate.accept(f(8))).toEqual([]);
    expect(texts(gate.accept(f(10)))).toEqual(['t10']);
  });

  it('counts a frame under `stream` when its payload names another session', () => {
    const gate = newGate();
    gate.adoptEpoch('e1');
    gate.accept({ ...f(1, 'subagent'), stream: 'tab' });
    expect(gate.cursors(['tab', 'subagent'])).toEqual({ eventEpoch: 'e1', cursors: { tab: 1 } });
  });

  it('forgets every cursor when the server process changed', () => {
    const gate = newGate();
    gate.adoptEpoch('e1');
    gate.accept(f(4));
    gate.beginResume(['s1']);
    gate.accept(f(9));
    expect(texts(gate.adoptEpoch('e2'))).toEqual(['t9']);
    expect(gate.isResuming('s1')).toBe(false);
    expect(gate.cursors(['s1'])).toBeNull();
    // Numbering restarted on the new server.
    expect(texts(gate.accept(f(1)))).toEqual(['t1']);
  });

  it('has nothing to resume before it knows the server epoch', () => {
    const gate = newGate();
    gate.accept(f(3));
    expect(gate.cursors(['s1'])).toBeNull();
  });
});

describe('FrameResume', () => {
  afterEach(() => vi.useRealTimers());

  const start = (sessionId: string, extra: Record<string, unknown> = {}): Frame => ({
    type: 'session.start',
    payload: {
      sessionId,
      replayMessages: [{ role: 'user', content: 'x' }],
      replayMarkers: [],
      replayToolMeta: [],
      replayUsage: { input: 1, output: 1 },
      model: 'm',
      ...extra,
    },
  });

  it.each([null, [], 'invalid', 42])(
    'passes malformed session.start payload %j through',
    (payload) => {
      const applied: Frame[] = [];
      const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
      const frame = { type: 'session.start', payload } as unknown as Frame;
      expect(resume.onSessionStart(frame)).toBe(frame);
      expect(applied).toEqual([]);
    },
  );

  it('drops the transcript replay of a tab being caught up, and only of that tab', () => {
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1));
    expect(resume.request(['s1'])).toEqual({ eventEpoch: 'e1', cursors: { s1: 1 } });

    const kept = resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    expect(Object.keys(kept.payload).sort()).toEqual(['eventEpoch', 'model', 'sessionId']);
    const other = resume.onSessionStart(start('s2'));
    expect(other.payload['replayMessages']).toHaveLength(1);
  });

  it('lets a new server epoch keep its replay', () => {
    const resume = new FrameResume<Frame>(() => undefined);
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1));
    resume.request(['s1']);
    const fresh = resume.onSessionStart(start('s1', { eventEpoch: 'e2' }));
    expect(fresh.payload['replayMessages']).toHaveLength(1);
  });

  it('applies held frames when the catch-up answer arrives', () => {
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1));
    resume.request(['s1']);
    resume.gate.accept(f(4));
    resume.onFramesResumed({ type: 'session.frames_resumed', payload: { sessionId: 's1' } });
    expect(texts(applied)).toEqual(['t4']);
  });

  it('gives up waiting after the timeout and applies what it held', () => {
    vi.useFakeTimers();
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames), 1_000);
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1));
    resume.request(['s1']);
    resume.gate.accept(f(3));
    vi.advanceTimersByTime(999);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(texts(applied)).toEqual(['t3']);
    expect(resume.gate.isResuming('s1')).toBe(false);
  });
  it('restarts the give-up timer when a second reconnect asks again', () => {
    vi.useFakeTimers();
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames), 1_000);
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1));
    resume.request(['s1']);
    resume.gate.accept(f(3));
    vi.advanceTimersByTime(800);
    resume.request(['s1']);
    vi.advanceTimersByTime(800);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(texts(applied)).toEqual(['t3']);
  });

  it('asks for nothing before any frame was applied', () => {
    const resume = new FrameResume<Frame>(() => undefined);
    expect(resume.request(['s1'])).toBeNull();
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    expect(resume.request(['s1'])).toBeNull();
  });

  it('releases what a tab held when the server process changed under its catch-up', () => {
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1));
    resume.request(['s1']);
    resume.gate.accept(f(3));
    resume.onSessionStart(start('s1', { eventEpoch: 'e2' }));
    expect(texts(applied)).toEqual(['t3']);
    expect(resume.gate.isResuming('s1')).toBe(false);
  });

  it('ignores a catch-up answer for a tab that was not waiting, or that names none', () => {
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
    resume.onFramesResumed({ type: 'session.frames_resumed', payload: { sessionId: 's9' } });
    resume.onFramesResumed({ type: 'session.frames_resumed', payload: {} });
    expect(applied).toEqual([]);
  });

  it('passes a numbered frame through when it names no session', () => {
    const gate = new FrameResume<Frame>(() => undefined).gate;
    const bare = { type: 'x', seq: 1 } as unknown as Frame;
    expect(gate.accept(bare)).toEqual([bare]);
    const unnamed: Frame = { type: 'x', seq: 1, payload: { sessionId: '' } };
    expect(gate.accept(unnamed)).toEqual([unnamed]);
  });

  it('treats negative or non-integer seq as unnumbered, clears timer when all sessions resume, and unions overlapping request() calls', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const applied: Frame[] = [];
      const resume = new FrameResume<Frame>((frames) => applied.push(...frames), 1_000);
      resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
      resume.onSessionStart(start('s2', { eventEpoch: 'e1' }));

      // Negative and float seq values must be treated as unnumbered (pass straight through without advancing cursor)
      const negSeq = f(-1, 's1', 'neg');
      const floatSeq = f(1.5, 's1', 'float');
      expect(resume.gate.accept(negSeq)).toEqual([negSeq]);
      expect(resume.gate.accept(floatSeq)).toEqual([floatSeq]);
      expect(resume.gate.cursors(['s1'])).toBeNull();

      // Advance real cursors for s1 and s2
      resume.gate.accept(f(1, 's1', 's1-1'));
      resume.gate.accept(f(1, 's2', 's2-1'));

      // Overlapping request(['s1']) then request(['s2']) must union this.requested
      resume.request(['s1']);
      resume.request(['s2']);
      resume.gate.accept(f(3, 's1', 's1-3'));
      resume.gate.accept(f(3, 's2', 's2-3'));

      // Finish s2 first: timer not cleared yet because s1 is still in this.requested and resuming
      const clearsBefore = clearTimeoutSpy.mock.calls.length;
      resume.onFramesResumed({ type: 'session.frames_resumed', payload: { sessionId: 's2' } });
      expect(clearTimeoutSpy.mock.calls.length).toBe(clearsBefore);

      // Finish s1: all sessions in this.requested are now done, so clearTimeout is called
      resume.onFramesResumed({ type: 'session.frames_resumed', payload: { sessionId: 's1' } });
      expect(clearTimeoutSpy.mock.calls.length).toBe(clearsBefore + 1);

      // Also verify that if timeout fires after overlapping requests, both s1 and s2 are flushed
      const appliedTimeout: Frame[] = [];
      const resume2 = new FrameResume<Frame>((frames) => appliedTimeout.push(...frames), 500);
      resume2.onSessionStart(start('s1', { eventEpoch: 'e1' }));
      resume2.onSessionStart(start('s2', { eventEpoch: 'e1' }));
      resume2.gate.accept(f(1, 's1', 'a1'));
      resume2.gate.accept(f(1, 's2', 'b1'));
      resume2.request(['s1']);
      resume2.request(['s2']);
      resume2.gate.accept(f(3, 's1', 'a3'));
      resume2.gate.accept(f(3, 's2', 'b3'));
      vi.advanceTimersByTime(500);
      expect(texts(appliedTimeout)).toEqual(['a3', 'b3']);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('disarms the pending give-up timer when adoptEpoch ends resume on server restart', () => {
    vi.useFakeTimers();
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames), 1_000);
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(1, 's1', 'a1'));
    resume.request(['s1']);

    vi.advanceTimersByTime(400);
    // Server restarts with new epoch e2
    resume.onSessionStart(start('s1', { eventEpoch: 'e2' }));
    resume.gate.accept(f(1, 's1', 'b1'));
    resume.gate.beginResume(['s1']);
    resume.gate.accept(f(3, 's1', 'b3-held'));

    // Advance past the old e1 1000ms timer deadline
    vi.advanceTimersByTime(700);
    expect(resume.gate.isResuming('s1')).toBe(true);
    expect(texts(applied)).not.toContain('b3-held');
  });

  it('preserves replay fields and resets sequence watermark when session.start has reset: true during resume (F82)', () => {
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.gate.accept(f(5, 's1', 'old-5'));
    resume.request(['s1']);
    resume.gate.accept(f(7, 's1', 'stale-7'));

    const resetStart = resume.onSessionStart(start('s1', { eventEpoch: 'e1', reset: true }));
    expect(resetStart.payload['replayMessages']).toHaveLength(1);
    expect(resume.gate.isResuming('s1')).toBe(false);
    expect(applied).toEqual([]);

    // Post-reset frames starting at seq=1 must be accepted
    expect(texts(resume.gate.accept(f(1, 's1', 'post-reset-1')))).toEqual(['post-reset-1']);
  });

  it('adopts the epoch of a session.start without a session id and passes it through', () => {
    const resume = new FrameResume<Frame>(() => undefined);
    const bare: Frame = { type: 'session.start', payload: { eventEpoch: 'e9' } };
    expect(resume.onSessionStart(bare)).toBe(bare);
    resume.gate.accept(f(1, 's1'));
    expect(resume.gate.cursors(['s1'])).toEqual({ eventEpoch: 'e9', cursors: { s1: 1 } });
  });

  it('keeps the resume timer when a reset leaves another requested session resuming', () => {
    vi.useFakeTimers();
    const applied: Frame[] = [];
    const resume = new FrameResume<Frame>((frames) => applied.push(...frames));
    resume.onSessionStart(start('s1', { eventEpoch: 'e1' }));
    resume.onSessionStart(start('s2', { eventEpoch: 'e1' }));
    resume.gate.accept(f(2, 's1', 'a2'));
    resume.gate.accept(f(2, 's2', 'b2'));
    resume.request(['s1', 's2']);
    resume.gate.accept(f(4, 's2', 'b4-held'));

    // s1 restarts; s2 is still catching up, so the timer that releases it stays.
    resume.onSessionStart(start('s1', { eventEpoch: 'e1', reset: true }));
    expect(resume.gate.isResuming('s1')).toBe(false);
    expect(resume.gate.isResuming('s2')).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(resume.gate.isResuming('s2')).toBe(false);
    expect(texts(applied)).toContain('b4-held');
  });
});
