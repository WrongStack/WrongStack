import { describe, expect, it } from 'vitest';
import { sanitizeGovernanceMessage } from '../src/sanitize.js';

const ROCKET = '\u{1F680}';

/**
 * F2633: `sanitizeGovernanceMessage` caps at 512 UTF-16 units with a plain
 * `.slice`. A message whose 512th unit is the high half of an astral character
 * comes back ill-formed, and this string is what governance IPC responses and
 * the CLI's legacy fallback render.
 */
describe('governance message cap keeps valid UTF-16 (F2633)', () => {
  it('drops the orphaned high surrogate instead of keeping it', () => {
    const out = sanitizeGovernanceMessage(`${'m'.repeat(511)}${ROCKET}tail`);

    expect(out.isWellFormed()).toBe(true);
    expect(out).toHaveLength(511);
    expect(out).toBe('m'.repeat(511));
  });

  it('still redacts credentials and keeps short messages (control)', () => {
    expect(sanitizeGovernanceMessage('denied: wsg_abcdef')).toBe('denied: [credential]');
    expect(sanitizeGovernanceMessage(`${'a'.repeat(511)}${ROCKET}`)).toBe('a'.repeat(511));
  });

  it('keeps a whole emoji that ends exactly at the cap', () => {
    const text = `${'a'.repeat(510)}${ROCKET}tail`;
    const out = sanitizeGovernanceMessage(text);

    expect(out).toBe(`${'a'.repeat(510)}${ROCKET}`);
    expect(out.isWellFormed()).toBe(true);
  });
});
