import { describe, expect, it } from 'vitest';
import { parseHqStartSession } from '../src/command-start-session.js';

describe('parseHqStartSession null payload guard (F2300)', () => {
  it('returns null instead of throwing on null payload', () => {
    expect(parseHqStartSession(null as unknown as Record<string, unknown>)).toBeNull();
    expect(parseHqStartSession({ prompt: ' run tests ' })?.prompt).toBe('run tests');
  });
});
