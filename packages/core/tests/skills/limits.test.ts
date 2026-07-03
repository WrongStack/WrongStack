import { describe, expect, it } from 'vitest';
import { SKILL_LIMITS } from '../../src/skills/limits.js';

/**
 * Centralized skill limits — regression guard. These values were frozen at
 * their pre-centralization defaults, so this test pins them so a casual edit
 * doesn't silently shift the budget model (e.g. eager-mode prompt cost).
 *
 * When you intentionally change a value, update both the constant and this test
 * in the same commit.
 */
describe('SKILL_LIMITS', () => {
  it('each limit is a positive integer', () => {
    for (const [key, value] of Object.entries(SKILL_LIMITS)) {
      expect(Number.isInteger(value), `${key} should be an integer`).toBe(true);
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('per-skill body cap is 16k', () => {
    expect(SKILL_LIMITS.MAX_SKILL_BODY_CHARS).toBe(16_000);
  });

  it('resource cap (32k) is larger than the body cap (16k)', () => {
    expect(SKILL_LIMITS.MAX_RESOURCE_CHARS).toBe(32_000);
    expect(SKILL_LIMITS.MAX_RESOURCE_CHARS).toBeGreaterThan(SKILL_LIMITS.MAX_SKILL_BODY_CHARS);
  });

  it('eager default budget is 24k', () => {
    expect(SKILL_LIMITS.EAGER_DEFAULT_MAX_CHARS).toBe(24_000);
  });

  it('compact total (450) fits overview (200) + rules (350) joined', () => {
    // The joined compact body is capped at COMPACT_TOTAL_MAX regardless of the
    // per-section caps, but the invariants should stay coherent.
    expect(SKILL_LIMITS.COMPACT_OVERVIEW_MAX).toBe(200);
    expect(SKILL_LIMITS.COMPACT_RULES_MAX).toBe(350);
    expect(SKILL_LIMITS.COMPACT_TOTAL_MAX).toBe(450);
  });

  it('skill file size limit is 100KB', () => {
    expect(SKILL_LIMITS.MAX_SKILL_FILE_SIZE).toBe(100 * 1024);
  });

  it('tarball size limit is 50MB', () => {
    expect(SKILL_LIMITS.MAX_TARBALL_SIZE).toBe(50 * 1024 * 1024);
  });

  it('skill name max length is 64 (agentskills.io spec)', () => {
    expect(SKILL_LIMITS.SKILL_NAME_MAX_LEN).toBe(64);
  });

  it('skill body soft line limit is 500', () => {
    expect(SKILL_LIMITS.SKILL_BODY_LINE_LIMIT).toBe(500);
  });
});
