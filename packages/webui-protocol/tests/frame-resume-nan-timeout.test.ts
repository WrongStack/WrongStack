import { describe, expect, it, vi } from 'vitest';
import { FrameResume } from '../src/frame-resume.js';

describe('FrameResume NaN timeoutMs fallback (F1835)', () => {
  it('falls back to 5000ms default instead of 24.8 days when timeoutMs is NaN', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const resume = new FrameResume(() => {}, Number.NaN);
      resume.gate.adoptEpoch('e1');
      resume.gate.accept({ type: 't', seq: 1, payload: { sessionId: 's1' } });
      resume.request(['s1']);
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 5_000);
    } finally {
      spy.mockRestore();
    }
  });
});
