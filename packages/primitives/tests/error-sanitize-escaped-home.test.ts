import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: String.raw`C:\Users\fixture.user+1` }));
vi.mock('node:os', () => ({ homedir: () => fixture.home }));

import { scrubErrorDetail, scrubErrorText } from '../src/error-sanitize.js';

beforeEach(() => {
  fixture.home = String.raw`C:\Users\fixture.user+1`;
});

describe('error sanitization masks JSON-escaped Windows home paths', () => {
  it.each([false, true])('preserves serialized JSON with pretty=%s', (pretty) => {
    const input = JSON.stringify({ path: `${fixture.home}\\work\\file.json` }, null, pretty ? 2 : undefined);
    expect(JSON.parse(scrubErrorText(input))).toEqual({ path: '~\\work\\file.json' });
  });

  it('masks case variants in serialized paths', () => {
    const input = JSON.stringify({ path: `${fixture.home.toUpperCase()}\\work` });
    expect(JSON.parse(scrubErrorText(input))).toEqual({ path: '~\\work' });
  });

  it('also masks escaped paths through the bounded error-detail API', () => {
    const input = JSON.stringify({ path: `${fixture.home}\\file.json` });
    expect(JSON.parse(scrubErrorDetail(new Error(input)))).toEqual({ path: '~\\file.json' });
  });

  it('retains literal and forward-slash path handling', () => {
    expect(scrubErrorText(`${fixture.home}\\work`)).toBe('~\\work');
    expect(scrubErrorText(`${fixture.home.replace(/\\/g, '/')}/work`)).toBe('~/work');
  });

  it('preserves unrelated serialized paths', () => {
    const input = JSON.stringify({ path: String.raw`D:\Shared\work\file.json` });
    expect(scrubErrorText(input)).toBe(input);
  });

  it('masks Unicode home names without changing the following payload', () => {
    fixture.home = String.raw`C:\Users\Çağrı`;
    const input = JSON.stringify({ path: `${fixture.home}\\work`, note: 'kept' });
    expect(JSON.parse(scrubErrorText(input))).toEqual({ path: '~\\work', note: 'kept' });
  });

  it('retains POSIX home masking', () => {
    fixture.home = '/home/fixture-user';
    expect(scrubErrorText(JSON.stringify({ path: `${fixture.home}/work` }))).toBe('{"path":"~/work"}');
  });
});
