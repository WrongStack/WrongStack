import { describe, expect, it } from 'vitest';
import { scorePassword } from '../src/domain/password-strength.js';

describe('scorePassword', () => {
  it('returns empty for zero-length input', () => {
    expect(scorePassword('')).toEqual({ level: 'empty', score: 0, label: '' });
  });

  it('scores common passwords as weak (score 0)', () => {
    for (const pw of ['password', '12345678', 'qwerty123', 'letmein1']) {
      const result = scorePassword(pw);
      expect(result.score).toBe(0);
      expect(result.level).toBe('weak');
    }
  });

  it('scores a short all-lowercase password as weak', () => {
    const result = scorePassword('abcdefgh');
    expect(result.level).toBe('weak');
    expect(result.score).toBeLessThan(30);
  });

  it('scores a mixed-case 8-char password with digits as fair', () => {
    const result = scorePassword('Abcd1234');
    expect(result.level).toBe('fair');
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.score).toBeLessThan(55);
  });

  it('scores a 12+ char password with variety as good or strong', () => {
    const result = scorePassword('MyStr0ng!Pass');
    expect(['good', 'strong']).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  it('scores a 16+ char password with full variety as strong', () => {
    const result = scorePassword('Super$Secure#Passw0rd!');
    expect(result.level).toBe('strong');
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it('penalizes repeated characters', () => {
    const withoutRepeat = scorePassword('abcdefgh1A!');
    const withRepeat = scorePassword('aaabcdef1A!');
    expect(withRepeat.score).toBeLessThan(withoutRepeat.score);
  });

  it('penalizes sequential patterns', () => {
    const withoutSeq = scorePassword('xyzxyz1A!');
    const withSeq = scorePassword('1234abcdA!');
    expect(withSeq.score).toBeLessThanOrEqual(withoutSeq.score);
  });

  it('never returns negative scores', () => {
    const result = scorePassword('password');
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('never returns scores above 100', () => {
    const result = scorePassword('ABCDEFGHIJ!abcdefghij0123456789$');
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
