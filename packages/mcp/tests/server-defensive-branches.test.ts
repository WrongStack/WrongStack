/**
 * Defensive-branch coverage for MCPServer HTTP guards that are unreachable
 * through normal inputs but must be pinned:
 *
 *  - `assertArgumentsMatchSchema` renders a validation error with an empty
 *    path as `(root)` (server.ts:292). The shared validator always emits a
 *    truthy path (`<root>` at worst), so the fallback only fires when the
 *    validator misbehaves — which is exactly what this test forces.
 *  - `isJsonContentType` treats a `split(';')` that yields no media type as
 *    non-JSON via the `?? ''` fallback (server.ts:778). A real string always
 *    yields at least one element, so the fallback only fires when the runtime
 *    misbehaves — forced here by stubbing `String.prototype.split`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted state shared between the module mock and the test bodies.
const h = vi.hoisted(() => ({
  rootError: false,
  breakSplit: false,
}));

vi.mock('@wrongstack/core/utils', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    validateAgainstSchema: (() => {
      if (h.rootError) {
        return { ok: false, errors: [{ path: '', message: 'root-level failure' }] };
      }
      return { ok: true, errors: [] };
    }) as never,
  };
});

import { MCPServer, serveHttp, type MCPServerToolHost } from '../src/server.js';

const ORIGINAL_SPLIT = String.prototype.split;

function makeHost(): MCPServerToolHost {
  return {
    listTools: () => [
      { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
    ],
    callTool: async (name, args) => ({
      content: `${name}:${JSON.stringify(args)}`,
      isError: false,
    }),
  };
}

afterEach(() => {
  h.rootError = false;
  h.breakSplit = false;
  String.prototype.split = ORIGINAL_SPLIT;
  vi.restoreAllMocks();
});

describe('MCPServer defensive branches', () => {
  it('renders a pathless schema error as (root)', async () => {
    h.rootError = true;
    const server = new MCPServer({ host: makeHost() });
    const res = await server.handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'echo', arguments: { x: 1 } },
      }),
    );
    const parsed = JSON.parse(res ?? '') as { error?: { code: number; message: string } };
    expect(parsed.error?.code).toBe(-32602);
    expect(parsed.error?.message).toContain('(root): root-level failure');
  });

  it('refuses a content-type whose split yields no media type', async () => {
    // Only the media-type gate's own `split(';')` returns an empty array; all
    // other splits (including undici's internal ones) behave normally. This
    // drives `[0]` to undefined so the `?? ''` fallback at server.ts:778 fires.
    h.breakSplit = true;
    // `String.prototype.split` is an overloaded built-in (string|RegExp, or a
    // `[Symbol.split]` splitter), and a single-signature stub is not assignable
    // to it. Cast the assignment to the built-in's own type, and widen the
    // pass-through arg: calling `split(undefined)` is valid at runtime (it
    // yields the whole string) but no overload declares it.
    String.prototype.split = function split(
      this: string,
      separator?: string | RegExp,
      limit?: number,
    ): string[] {
      if (h.breakSplit && separator === ';') return [];
      // `.call` on the overloaded original resolves to the `[Symbol.split]`
      // signature, so narrow it to the plain separator form for the
      // pass-through. `ORIGINAL_SPLIT` itself keeps its real type — it is
      // assigned back to the prototype during cleanup.
      const passthrough = ORIGINAL_SPLIT as (
        this: string,
        separator?: string | RegExp,
        limit?: number,
      ) => string[];
      return passthrough.call(this, separator, limit);
    } as typeof String.prototype.split;
    const handle = await serveHttp(new MCPServer({ host: makeHost() }), { port: 0 });
    try {
      const res = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: {} },
        }),
      });
      expect(res.status).toBe(415);
    } finally {
      await handle.close();
    }
  });
});
