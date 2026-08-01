/**
 * WS-036 — `mcp.list` echoed MCP server env verbatim over the WebSocket.
 *
 * MCP server env is where server credentials live: `GITHUB_TOKEN`,
 * `*_API_KEY`, and so on. This is the surface that put them in the browser.
 *
 * Two independent signals decide whether a value is masked, because either
 * alone misses real cases — a secret-looking KEY, or a secret-looking VALUE.
 * The round-trip (mask sent back means "unchanged") is pinned separately, in
 * packages/mcp/tests/env-mask.test.ts.
 */
import { MCP_ENV_MASK } from '@wrongstack/mcp';
import { describe, expect, it } from 'vitest';
import { toView } from '../src/server/mcp-handlers.js';

const base = { name: 'demo', transport: 'stdio' as const, status: 'stopped', enabled: true };

const viewEnv = (env: Record<string, string>): Record<string, string> | undefined =>
  toView({ ...base, env } as never).env;

describe('mcp.list env redaction (WS-036)', () => {
  it('masks a secret-looking key regardless of its value', () => {
    expect(viewEnv({ GITHUB_TOKEN: 'anything-at-all' })).toEqual({
      GITHUB_TOKEN: MCP_ENV_MASK,
    });
    expect(viewEnv({ BRAVE_API_KEY: 'x' })).toEqual({ BRAVE_API_KEY: MCP_ENV_MASK });
    expect(viewEnv({ DB_PASSWORD: 'hunter2' })).toEqual({ DB_PASSWORD: MCP_ENV_MASK });
  });

  it('masks a credential hiding behind an innocuous key name', () => {
    // The key says nothing; the value is unmistakably a GitHub PAT.
    const masked = viewEnv({ GH_PAT: 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(masked).toEqual({ GH_PAT: MCP_ENV_MASK });
  });

  it('lets ordinary configuration through so the UI stays usable', () => {
    expect(viewEnv({ NODE_ENV: 'production', LOG_LEVEL: 'debug' })).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
    });
  });

  it('never leaves a secret in the serialized payload', () => {
    const secret = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const serialized = JSON.stringify(viewEnv({ GITHUB_TOKEN: secret, NODE_ENV: 'production' }));
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('production');
  });

  it('omits env entirely when the server declares none', () => {
    expect(toView({ ...base } as never).env).toBeUndefined();
  });
});
