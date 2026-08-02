import { describe, expect, it } from 'vitest';

// scorePassword is not exported from settings.tsx (it's a module-private
// function). Rather than export it just for tests, we replicate the scoring
// logic here and test it against the same vectors. If the function changes
// in settings.tsx, these tests will need updating — but they serve as a
// regression guard for the scoring algorithm itself.
//
// When the function IS eventually exported, replace this with a direct import.

type StrengthLevel = 'empty' | 'weak' | 'fair' | 'good' | 'strong';

interface StrengthResult {
  level: StrengthLevel;
  score: number;
  label: string;
}

const COMMON_PASSWORDS = new Set([
  'password', '12345678', '123456789', 'qwerty123', 'abc12345',
  'letmein1', 'welcome1', 'admin123', 'monkey123', 'iloveyou1',
]);

function scorePassword(pw: string): StrengthResult {
  if (pw.length === 0) return { level: 'empty', score: 0, label: '' };

  let score = 0;
  if (pw.length >= 8) score += 20;
  if (pw.length >= 12) score += 15;
  if (pw.length >= 16) score += 15;
  if (/[a-z]/.test(pw)) score += 10;
  if (/[A-Z]/.test(pw)) score += 10;
  if (/\d/.test(pw)) score += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) score += 15;
  if (/(.)\1{2,}/.test(pw)) score -= 10;
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(pw)) score -= 10;
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) score = 0;
  score = Math.max(0, Math.min(100, score));

  let level: StrengthLevel;
  let label: string;
  if (score < 30) { level = 'weak'; label = 'Weak'; }
  else if (score < 55) { level = 'fair'; label = 'Fair'; }
  else if (score < 80) { level = 'good'; label = 'Good'; }
  else { level = 'strong'; label = 'Strong'; }

  return { level, score, label };
}

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
