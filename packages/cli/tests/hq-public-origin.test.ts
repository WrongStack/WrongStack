import { describe, expect, it } from 'vitest';
import { normalizeHqPublicOrigin } from '../src/hq-server/utils.js';

describe('HQ persistent public origin', () => {
  it.each([
    ['https://hq.example.com', 'https://hq.example.com'],
    ['https://hq.example.com/', 'https://hq.example.com'],
    ['https://hq.example.com:8443', 'https://hq.example.com:8443'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeHqPublicOrigin(input)).toBe(expected);
  });

  it.each([
    'http://hq.example.com',
    'https://hq.example.com/mobile',
    'https://user:pass@hq.example.com',
    'https://hq.example.com?token=x',
    'https://hq.example.com/#fragment',
  ])('rejects unsafe public URL %s', (input) => {
    expect(() => normalizeHqPublicOrigin(input)).toThrow(/exact HTTPS origin/);
  });
});
