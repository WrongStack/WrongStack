/**
 * Regression for E5 (DOS-004): the CLI-hosted `WebSocketServer`
 * previously had no `verifyClient` callback, so a hostile page
 * could complete the WS handshake and only then be rejected at
 * the application-layer `authenticate` step. Every accepted
 * handshake allocates a `ws` instance, two buffers, and a
 * per-connection upgrade — `for(;;) new WebSocket(...)` from a
 * single hostile tab is cheap memory/FD pressure on the agent
 * host. The standalone `server-runtime.ts` already wires
 * `verifyClient`; this test pins the CLI path so a future
 * "let's just call `new WebSocketServer({})` directly" refactor
 * breaks the build.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '../../../..');
const source = readFileSync(
  resolve(repoRoot, 'packages/cli/src/webui-server.ts'),
  'utf8',
);

describe('E5 / CLI webui WS verifyClient is wired', () => {
  it('the CLI WebSocketServer construction passes a verifyClient', () => {
    // A future "let's just call new WebSocketServer({server})" must
    // fail this test before it lands. The check is narrow on
    // purpose: the call site must include `verifyClient` literally.
    expect(source).toMatch(/new WebSocketServer\(\s*\{[^}]*verifyClient/);
  });

  it('verifyClient is the ws-auth helper (not a stub)', () => {
    // A stub that always returns true would pass the structural
    // check above and lose the entire point of E5. The helper
    // imported must be the one from `@wrongstack/webui-server`.
    expect(source).toMatch(/verifyClient\s+as\s+verifyWsClient/);
  });
});
