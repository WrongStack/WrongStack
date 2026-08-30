import { describe, expect, it } from 'vitest';
import {
  resolveSessionId,
  sessionIdResolutionError,
} from '../../src/storage/session-id-resolver.js';

describe('resolveSessionId', () => {
  const candidates = [
    '2026-08-01/sess_01JX1111111111111111111111',
    '2026-08-02/sess_01JX2222222222222222222222',
    '2026-08-29/sess_01JX3333333333333333333333',
    '2026-08-29/sess_01JX4444444444444444444444',
  ];

  it('resolves exact canonical session id', () => {
    const res = resolveSessionId('2026-08-01/sess_01JX1111111111111111111111', candidates);
    expect(res).toEqual({
      status: 'resolved',
      id: '2026-08-01/sess_01JX1111111111111111111111',
    });
  });

  it('resolves canonical session id with Windows backslashes', () => {
    const res = resolveSessionId('2026-08-01\\sess_01JX1111111111111111111111', candidates);
    expect(res).toEqual({
      status: 'resolved',
      id: '2026-08-01/sess_01JX1111111111111111111111',
    });
  });

  it('resolves exact leaf match', () => {
    const res = resolveSessionId('sess_01JX2222222222222222222222', candidates);
    expect(res).toEqual({
      status: 'resolved',
      id: '2026-08-02/sess_01JX2222222222222222222222',
    });
  });

  it('resolves unique prefix match', () => {
    const res = resolveSessionId('sess_01JX1', candidates);
    expect(res).toEqual({
      status: 'resolved',
      id: '2026-08-01/sess_01JX1111111111111111111111',
    });
  });

  it('returns ambiguous for ambiguous prefixes', () => {
    const res = resolveSessionId('2026-08-29', candidates);
    expect(res.status).toBe('ambiguous');
    if (res.status === 'ambiguous') {
      expect(res.candidates).toHaveLength(2);
      const err = sessionIdResolutionError(res);
      expect(err.message).toContain('Ambiguous session id');
    }
  });

  it('returns missing for non-existent session', () => {
    const res = resolveSessionId('sess_nonexistent', candidates);
    expect(res.status).toBe('missing');
    if (res.status === 'missing') {
      const err = sessionIdResolutionError(res);
      expect(err.message).toContain('Session not found');
    }
  });

  it('returns missing for empty query', () => {
    const res = resolveSessionId('   ', candidates);
    expect(res.status).toBe('missing');
  });
});
