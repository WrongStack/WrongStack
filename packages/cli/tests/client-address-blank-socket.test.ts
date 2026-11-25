import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { resolveClientAddress } from '../src/hq-server/client-address.js';

describe('resolveClientAddress (F2211)', () => {
  it('returns unknown when remoteAddress is whitespace-only', () => {
    expect(
      resolveClientAddress(
        { socket: { remoteAddress: '   ' }, headers: {} } as unknown as http.IncomingMessage,
        0,
      ),
    ).toBe('unknown');
    expect(
      resolveClientAddress(
        {
          socket: { remoteAddress: '::ffff:127.0.0.1' },
          headers: {},
        } as unknown as http.IncomingMessage,
        0,
      ),
    ).toBe('127.0.0.1');
  });
});
