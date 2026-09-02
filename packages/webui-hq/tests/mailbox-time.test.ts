import { describe, expect, it } from 'vitest';
import {
  formatMailboxTime,
  formatRelativeTime,
  shortMailboxId,
} from '../src/domain/mailbox-time.js';

describe('mailbox-time', () => {
  describe('formatMailboxTime', () => {
    it('formats valid ISO timestamp', () => {
      const ts = '2026-07-04T12:00:00.000Z';
      const formatted = formatMailboxTime(ts);
      expect(formatted).toBe(new Date(ts).toLocaleString());
    });

    it('returns raw string on parse failure', () => {
      const invalid = 'not-a-timestamp';
      expect(formatMailboxTime(invalid)).toBe(invalid);
    });
  });

  describe('formatRelativeTime', () => {
    const mockNow = new Date('2026-07-04T12:00:00.000Z').getTime();

    it('returns seconds ago', () => {
      const ts = '2026-07-04T11:59:30.000Z'; // 30s ago
      expect(formatRelativeTime(ts, mockNow)).toBe('30s ago');
    });

    it('returns minutes ago', () => {
      const ts = '2026-07-04T11:55:00.000Z'; // 5m ago
      expect(formatRelativeTime(ts, mockNow)).toBe('5m ago');
    });

    it('returns hours ago', () => {
      const ts = '2026-07-04T09:00:00.000Z'; // 3h ago
      expect(formatRelativeTime(ts, mockNow)).toBe('3h ago');
    });

    it('returns days ago', () => {
      const ts = '2026-07-02T12:00:00.000Z'; // 2d ago
      expect(formatRelativeTime(ts, mockNow)).toBe('2d ago');
    });

    it('returns weeks ago', () => {
      const ts = '2026-06-20T12:00:00.000Z'; // 2w ago
      expect(formatRelativeTime(ts, mockNow)).toBe('2w ago');
    });

    it('returns months ago', () => {
      const ts = '2026-05-04T12:00:00.000Z'; // 2mo ago
      expect(formatRelativeTime(ts, mockNow)).toBe('2mo ago');
    });

    it('returns years ago', () => {
      const ts = '2024-07-04T12:00:00.000Z'; // 2y ago
      expect(formatRelativeTime(ts, mockNow)).toBe('2y ago');
    });

    it('clamps future timestamps to "0s ago"', () => {
      const future = '2026-07-04T12:00:30.000Z'; // 30s in the future
      expect(formatRelativeTime(future, mockNow)).toBe('0s ago');
    });

    it('crosses the minute boundary at exactly 60s', () => {
      const oneMinute = '2026-07-04T11:59:00.000Z'; // exactly 60s ago
      expect(formatRelativeTime(oneMinute, mockNow)).toBe('1m ago');
    });

    it('defaults `now` to the current time', () => {
      // Without an explicit `now`, a timestamp taken just now should
      // read as a sub-minute "Ns ago" bucket rather than falling back
      // to the raw string.
      const justNow = new Date().toISOString();
      expect(formatRelativeTime(justNow)).toMatch(/^\d+s ago$/);
    });

    it('returns raw string on invalid input', () => {
      const invalid = 'invalid';
      expect(formatRelativeTime(invalid, mockNow)).toBe(invalid);
    });
  });

  describe('shortMailboxId', () => {
    it('truncates UUID or long ID to 14 chars', () => {
      const longId = '1234567890abcdef1234567890';
      expect(shortMailboxId(longId)).toBe('12345678…7890');
    });

    it('returns short ID unchanged', () => {
      const shortId = '123456';
      expect(shortMailboxId(shortId)).toBe(shortId);
    });

    it('returns ID of exactly 14 characters unchanged', () => {
      const fourteen = '12345678901234';
      expect(shortMailboxId(fourteen)).toBe(fourteen);
    });

    it('truncates at the first char over the threshold (15)', () => {
      const fifteen = '123456789012345';
      // first 8 + ellipsis + last 4
      expect(shortMailboxId(fifteen)).toBe('12345678…2345');
    });

    it('returns an empty string unchanged', () => {
      expect(shortMailboxId('')).toBe('');
    });
  });
});
