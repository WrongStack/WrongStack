import { describe, expect, it } from 'vitest';
import { phaseVerificationAttempts } from '../src/GoalPhaseVerification';

describe('goal phase verification', () => {
  it('reads recorded attempts and skips malformed ones', () => {
    expect(
      phaseVerificationAttempts({
        verificationAttempts: [
          { attempt: 0, ok: false, at: 5, output: 'tsc failed' },
          { attempt: 1, ok: true },
          { attempt: 'x', ok: true },
        ],
      }),
    ).toEqual([
      { attempt: 0, ok: false, at: 5, output: 'tsc failed' },
      { attempt: 1, ok: true, at: null, output: '' },
    ]);
    expect(phaseVerificationAttempts({})).toEqual([]);
  });
});
