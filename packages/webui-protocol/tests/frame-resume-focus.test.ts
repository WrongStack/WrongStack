import { afterEach, expect, it, vi } from 'vitest';
import { FrameResume } from '../src/frame-resume.js';

const sessionId = 's1';
const frame = (seq: number) => ({ type: 'stream.text', seq, payload: { sessionId } });

afterEach(() => vi.useRealTimers());

function catchUp() {
  vi.useFakeTimers();
  const resume = new FrameResume(() => undefined);
  resume.onSessionStart({ type: 'session.start', payload: { sessionId, eventEpoch: 'e1' } });
  expect(resume.gate.accept(frame(2))).toEqual([frame(2)]);
  expect(resume.request([sessionId])).toEqual({ eventEpoch: 'e1', cursors: { s1: 2 } });
  expect(resume.gate.accept(frame(4))).toEqual([]);
  return resume;
}

it('keeps the catch-up cursor and queued frames when an open session is focused', () => {
  const resume = catchUp();
  const focus = {
    type: 'session.start',
    payload: { sessionId, reset: true, replayReason: 'focus' },
  };

  expect(resume.onSessionStart(focus)).toEqual(focus);
  expect(resume.gate.cursors([sessionId])).toEqual({ eventEpoch: 'e1', cursors: { s1: 2 } });
  expect(resume.gate.accept(frame(2))).toEqual([]);
  expect(resume.gate.accept(frame(3))).toEqual([frame(3), frame(4)]);
  resume.onFramesResumed({ type: 'session.frames_resumed', payload: { sessionId } });
});

it('still discards held frames and accepts new numbering after an actual reset', () => {
  const resume = catchUp();
  resume.onSessionStart({ type: 'session.start', payload: { sessionId, reset: true } });

  expect(resume.gate.cursors([sessionId])).toBeNull();
  expect(resume.gate.accept(frame(1))).toEqual([frame(1)]);
  expect(resume.gate.accept(frame(3))).toEqual([frame(3)]);
});
