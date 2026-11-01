/**
 * Zero-dependency password scoring for the HQ security page.
 *
 * Deliberately not zxcvbn: HQ ships offline and a 400 KB dictionary bundle to
 * colour one meter is a bad trade. The tiers below are advisory — the server
 * enforces the real policy.
 */
export type PasswordStrengthLevel = 'empty' | 'weak' | 'fair' | 'good' | 'strong';

export interface PasswordStrength {
  level: PasswordStrengthLevel;
  /** 0-100. */
  score: number;
  label: string;
}

const COMMON_PASSWORDS = new Set([
  'password',
  '12345678',
  '123456789',
  'qwerty123',
  'abc12345',
  'letmein1',
  'welcome1',
  'admin123',
  'monkey123',
  'iloveyou1',
]);

export function scorePassword(password: string): PasswordStrength {
  if (password.length === 0) return { level: 'empty', score: 0, label: '' };

  let score = 0;

  // Length tiers.
  if (password.length >= 8) score += 20;
  if (password.length >= 12) score += 15;
  if (password.length >= 16) score += 15;

  // Character variety.
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 10;
  if (/\d/.test(password)) score += 10;
  if (/[^a-zA-Z0-9]/.test(password)) score += 15;

  // Pattern penalties.
  if (/(.)\1{2,}/.test(password)) score -= 10; // aaa, 111
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(password)) score -= 10;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) score = 0; // dictionary hit

  score = Math.max(0, Math.min(100, score));

  if (score < 30) return { level: 'weak', score, label: 'Weak' };
  if (score < 55) return { level: 'fair', score, label: 'Fair' };
  if (score < 80) return { level: 'good', score, label: 'Good' };
  return { level: 'strong', score, label: 'Strong' };
}
