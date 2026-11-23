import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtUptime } from '../src/office/OfficeMapCanvas/utils.js';

// No i18n instance is registered in this file, so both helpers use their
// compact English form.
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

describe('office map age labels roll over to the next unit (F1302)', () => {
  it('prints 59.5+ minutes as an hour and 23.5+ hours as a day', () => {
    expect(fmtAgo(ago(3590), NOW)).toBe('1h ago');
    expect(fmtAgo(ago(86_200), NOW)).toBe('1d ago');
    expect(fmtUptime(ago(3590), NOW)).toBe('1h');
  });

  it('keeps values inside a unit, and hours without days, unchanged', () => {
    expect(fmtAgo(ago(3569), NOW)).toBe('59m ago');
    expect(fmtAgo(ago(84_599), NOW)).toBe('23h ago');
    expect(fmtAgo(ago(125), NOW)).toBe('2m ago');
    expect(fmtUptime(ago(86_200), NOW)).toBe('24h');
  });
});
