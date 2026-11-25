import { describe, expect, it } from 'vitest';
import { callerSessionId } from '../src/origin-session.js';

describe('callerSessionId blank id guard (F2295)', () => {
  it('ignores whitespace-only activeRunSessionId and falls through to session.id', () => {
    expect(callerSessionId({ activeRunSessionId: '   ', session: { id: 'real-sess' } })).toBe(
      'real-sess',
    );
  });
});
