/**
 * Browser-safe loopback classification, mirroring the server's browser-origin
 * gate (webui-server ws-auth.ts `isLoopbackHostname`).
 *
 * SECURITY BOUNDARY — do not "simplify" this. It decides whether the WebSocket
 * URL may carry a `?token=`. The server refuses query-string tokens off
 * loopback (WS-009), so attaching one there would not authenticate anything;
 * it would only leak the credential into the upgrade request line, and from
 * there into proxy and access logs. Both sides must classify identically.
 *
 * Deliberately avoids `@wrongstack/core/hq`'s `isLoopbackHost` — that helper
 * uses `node:net` and would break the SPA bundle (see
 * `tests/browser-import-boundaries.test.ts`).
 *
 * Covers: `localhost`, the 127.0.0.0/8 block, `::1` (with or without brackets,
 * as WHATWG serializes IPv6 hostnames), and the DECIMAL IPv4-mapped
 * `::ffff:127.x.x.x` form. Browsers emit the hex form (`[::ffff:7f00:1]`) for
 * IPv4-mapped literals — both this client and the server consistently treat
 * that as non-loopback.
 */
export function isLoopbackBrowserOrigin(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    if (v4[1] !== '127') return false;
    for (const octet of v4.slice(1)) {
      if (Number(octet) > 255) return false;
    }
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return host.startsWith('::ffff:127.');
}
