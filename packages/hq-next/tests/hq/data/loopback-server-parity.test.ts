/**
 * The dashboard's loopback classifier decides whether the `/ws/browser` URL
 * carries `?token=`; the HQ server's upgrade gate decides whether to accept it
 * (hostname of the Host header, then `isLoopbackHost`). A page origin the two
 * classify differently loses its token-authenticated live feed (F1315).
 */
import { isLoopbackHost } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { isLoopbackBrowserOrigin } from '../../../src/hq/data/transport/loopback.js';

describe('loopback classifier agrees with the HQ server gate', () => {
  it.each([
    'http://127.0.0.1:3499/',
    'http://127.4.5.6:3499/',
    'http://localhost:3499/',
    'http://[::1]:3499/',
    'http://[::ffff:127.0.0.1]:3499/',
    'http://[::ffff:127.9.8.7]:3499/',
    'http://[::ffff:192.168.0.1]:3499/',
    'http://192.168.1.10:3499/',
    'https://hq.example.com/',
  ])('%s', (pageUrl) => {
    const page = new URL(pageUrl);
    const server = isLoopbackHost(new URL(`http://${page.host}`).hostname);
    expect(isLoopbackBrowserOrigin(page.hostname)).toBe(server);
  });
});
