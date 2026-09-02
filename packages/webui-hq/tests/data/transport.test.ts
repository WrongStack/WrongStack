/**
 * Transport rules that are security- or budget-critical:
 *  - the loopback classifier must agree with the server's ws-auth gate, since
 *    it decides whether the WS URL may carry a `?token=` at all
 *  - resume framing must stay under the frame cap and must never drop the
 *    synthetic peer cursor
 *
 * @vitest-environment jsdom
 */
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from '@wrongstack/core/hq/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackBrowserOrigin } from '../../src/data/transport/loopback.js';
import {
  buildResumeFrames,
  MAX_RESUME_FRAMES,
  normalizeResumeSeq,
} from '../../src/data/transport/resume-frames.js';
import { resolveHqSocketUrl } from '../../src/data/transport/hq-socket.js';
import { clearHqToken, setHqToken } from '../../src/data/auth/token-storage.js';

afterEach(() => {
  clearHqToken();
});

describe('isLoopbackBrowserOrigin', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackBrowserOrigin(host)).toBe(true);
    },
  );

  it.each([
    'example.com',
    '192.168.1.10',
    '128.0.0.1',
    '127.0.0.999',
    '::ffff:192.168.0.1',
    // Browsers serialise IPv4-mapped literals in hex; both sides treat the hex
    // form as NON-loopback, and they must agree or the token gate desyncs.
    '[::ffff:7f00:1]',
  ])('rejects %s', (host) => {
    expect(isLoopbackBrowserOrigin(host)).toBe(false);
  });
});

describe('resolveHqSocketUrl', () => {
  const loopback = { host: '127.0.0.1:3499', protocol: 'http:', hostname: '127.0.0.1' };
  const remote = { host: 'hq.example.com', protocol: 'https:', hostname: 'hq.example.com' };

  it('carries the token on loopback, where the server accepts it', () => {
    setHqToken('tok en/+');
    expect(resolveHqSocketUrl(loopback)).toBe(
      'ws://127.0.0.1:3499/ws/browser?token=tok%20en%2F%2B',
    );
  });

  it('NEVER carries the token off loopback', () => {
    // WS-009: the server refuses query-string tokens off loopback, so sending
    // one authenticates nothing and only leaks the credential into the upgrade
    // request line — and from there into proxy and access logs.
    setHqToken('secret-token');
    const url = resolveHqSocketUrl(remote);
    expect(url).toBe('wss://hq.example.com/ws/browser');
    expect(url).not.toContain('secret-token');
  });

  it('omits the token when there is none (cookie-only mode)', () => {
    expect(resolveHqSocketUrl(loopback)).toBe('ws://127.0.0.1:3499/ws/browser');
  });

  it('upgrades the scheme with the page', () => {
    expect(resolveHqSocketUrl({ ...loopback, protocol: 'https:' })).toMatch(/^wss:/);
  });
});

describe('normalizeResumeSeq', () => {
  it.each([
    [7, 7],
    [7.9, 7],
    [-3, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.MAX_VALUE, 0],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeResumeSeq(input)).toBe(expected);
  });
});

describe('buildResumeFrames', () => {
  it('emits one client.resume per publisher, newest watermark first', () => {
    const frames = buildResumeFrames({ a: 1, b: 9, c: 5 });
    expect(frames.map((frame) => frame.clientId)).toEqual(['b', 'c', 'a']);
    expect(frames[0]).toEqual({ type: 'client.resume', clientId: 'b', lastSeqSeen: 9 });
  });

  it('breaks watermark ties by clientId so the frame order is deterministic', () => {
    expect(buildResumeFrames({ zeta: 4, alpha: 4 }).map((frame) => frame.clientId)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('accepts a Map as well as a plain object', () => {
    expect(buildResumeFrames(new Map([['a', 3]]))).toEqual([
      { type: 'client.resume', clientId: 'a', lastSeqSeen: 3 },
    ]);
  });

  it(`caps the burst at ${MAX_RESUME_FRAMES} frames`, () => {
    // A dashboard left open for days accumulates a cursor per publisher it has
    // ever seen; without the cap the reconnect burst blows the WS frame budget.
    const cursor = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`client-${index}`, index + 1]),
    );
    expect(buildResumeFrames(cursor)).toHaveLength(MAX_RESUME_FRAMES);
  });

  it('always keeps the peer cursor, and sends it first', () => {
    // Peer seqs are small and would be trimmed away by the watermark sort, but
    // losing that cursor means replaying every peer-lifecycle envelope again.
    const cursor: Record<string, number> = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`client-${index}`, index + 100]),
    );
    cursor[HQ_BROWSER_PEER_RESUME_CLIENT_ID] = 2;

    const frames = buildResumeFrames(cursor);
    expect(frames).toHaveLength(MAX_RESUME_FRAMES);
    expect(frames[0]).toEqual({
      type: 'client.resume',
      clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID,
      lastSeqSeen: 2,
    });
  });

  it('skips empty client ids and normalises hostile seqs', () => {
    expect(buildResumeFrames({ '': 5, ok: Number.NaN })).toEqual([
      { type: 'client.resume', clientId: 'ok', lastSeqSeen: 0 },
    ]);
  });

  it('returns no frames rather than throwing on an exotic cursor', () => {
    const hostile = {
      get entries() {
        throw new Error('boom');
      },
    } as never;
    expect(buildResumeFrames(hostile)).toEqual([]);
  });
});
