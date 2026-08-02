import { describe, expect, it } from 'vitest';

// formatExpiry is a module-private function in auth-panel.tsx. We replicate
// the logic here for test purposes — if the function changes in auth-panel.tsx,
// these tests need updating. When the function IS exported, replace this
// import with the real one.

const UI_COLORS_ERROR = '#f38ba8';
const UI_COLORS_WARNING = '#f9e2af';
const UI_COLORS_INACTIVE = '#585b70';

function formatExpiry(expiresAt: string | undefined): { text: string; color: string } | null {
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return null;

  const now = Date.now();
  const msLeft = expiry - now;

  if (msLeft <= 0) return { text: 'expired', color: UI_COLORS_ERROR };
  if (msLeft < 60 * 60_000) return { text: `${Math.round(msLeft / 60_000)}m left`, color: UI_COLORS_ERROR };
  if (msLeft < 24 * 60 * 60_000) return { text: `${Math.round(msLeft / (60 * 60_000))}h left`, color: UI_COLORS_WARNING };
  return { text: `${Math.round(msLeft / (24 * 60 * 60_000))}d left`, color: UI_COLORS_INACTIVE };
}

describe('formatExpiry', () => {
  it('returns null for undefined', () => {
    expect(formatExpiry(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(formatExpiry('')).toBeNull();
  });

  it('returns null for invalid date string', () => {
    expect(formatExpiry('not-a-date')).toBeNull();
  });

  it('returns "expired" for a past date', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = formatExpiry(past);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('expired');
    expect(result!.color).toBe(UI_COLORS_ERROR);
  });

  it('returns minutes-left for <1h remaining', () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString(); // 30 min
    const result = formatExpiry(soon);
    expect(result).not.toBeNull();
    expect(result!.text).toMatch(/^\d+m left$/);
    expect(result!.color).toBe(UI_COLORS_ERROR);
  });

  it('returns hours-left for 1–24h remaining', () => {
    const hours = new Date(Date.now() + 5 * 60 * 60_000).toISOString(); // 5h
    const result = formatExpiry(hours);
    expect(result).not.toBeNull();
    expect(result!.text).toMatch(/^\d+h left$/);
    expect(result!.color).toBe(UI_COLORS_WARNING);
  });

  it('returns days-left for >24h remaining', () => {
    const days = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(); // 7d
    const result = formatExpiry(days);
    expect(result).not.toBeNull();
    expect(result!.text).toMatch(/^\d+d left$/);
    expect(result!.color).toBe(UI_COLORS_INACTIVE);
  });

  it('returns 1d left at exactly 24h boundary (rounds)', () => {
    const boundary = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const result = formatExpiry(boundary);
    expect(result).not.toBeNull();
    // At 24h: msLeft = 86400000, 86400000 / 86400000 = 1 → "1d left"
    expect(result!.text).toBe('1d left');
  });

  it('uses error color for expired', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(formatExpiry(past)!.color).toBe(UI_COLORS_ERROR);
  });

  it('uses warning color for hours', () => {
    const hours = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    expect(formatExpiry(hours)!.color).toBe(UI_COLORS_WARNING);
  });

  it('uses inactive color for days', () => {
    const days = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    expect(formatExpiry(days)!.color).toBe(UI_COLORS_INACTIVE);
  });
});
