/**
 * WS-004 — `mcp.add` / `mcp.update` payload validation.
 *
 * Both handlers cast the raw WebSocket payload with `as McpServerInput` and
 * handed it to `addMcp`, which persists `command`/`args`/`env` into the global
 * config and then spawns them. An unvalidated frame therefore became a
 * persistent child process that respawns on every restart. Four separate
 * scanners reached this handler independently.
 *
 * These cover the structural contract only. Whether a given `command` is
 * *allowed* is a policy question owned elsewhere; the spawn itself is hardened
 * by buildWin32CmdShimInvocation (CMDI-005).
 */
import { describe, expect, it } from 'vitest';
import { validateMcpServerPayload } from '../src/server/ws-payload-validation.js';

const ok = (payload: unknown) => validateMcpServerPayload(payload, 'mcp.add');

describe('validateMcpServerPayload', () => {
  it('accepts a minimal stdio server', () => {
    const result = ok({ name: 'files', command: 'npx', args: ['-y', '@scope/pkg'] });
    expect(result.ok).toBe(true);
  });

  it('accepts an http server with headers', () => {
    const result = ok({
      name: 'remote',
      url: 'https://mcp.example/v1',
      headers: { Authorization: 'Bearer x' },
      enabled: true,
      lazy: false,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object payload', () => {
    for (const payload of [undefined, null, 'name', 42, []]) {
      expect(ok(payload).ok).toBe(false);
    }
  });

  it('rejects a missing or blank name', () => {
    expect(ok({}).ok).toBe(false);
    expect(ok({ name: '' }).ok).toBe(false);
    expect(ok({ name: '   ' }).ok).toBe(false);
    expect(ok({ name: 123 }).ok).toBe(false);
  });

  it('rejects a non-string command', () => {
    const result = ok({ name: 'x', command: { toString: 'evil' } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('command');
  });

  it('rejects args that are not a string array', () => {
    expect(ok({ name: 'x', command: 'node', args: 'not-an-array' }).ok).toBe(false);
    expect(ok({ name: 'x', command: 'node', args: [1, 2] }).ok).toBe(false);
    expect(ok({ name: 'x', command: 'node', args: [{}] }).ok).toBe(false);
  });

  it('rejects env and headers that are not string maps', () => {
    expect(ok({ name: 'x', env: 'PATH=/' }).ok).toBe(false);
    expect(ok({ name: 'x', env: { PATH: 42 } }).ok).toBe(false);
    expect(ok({ name: 'x', headers: { Authorization: null } }).ok).toBe(false);
  });

  it('rejects non-boolean enabled/lazy', () => {
    expect(ok({ name: 'x', enabled: 'yes' }).ok).toBe(false);
    expect(ok({ name: 'x', lazy: 1 }).ok).toBe(false);
  });

  it('bounds oversized strings and collections', () => {
    const huge = 'a'.repeat(5_000);
    expect(ok({ name: huge }).ok).toBe(false);
    expect(ok({ name: 'x', command: huge }).ok).toBe(false);
    expect(ok({ name: 'x', args: Array.from({ length: 300 }, () => 'a') }).ok).toBe(false);
  });

  it('accepts the object form of transport', () => {
    expect(ok({ name: 'x', transport: { type: 'stdio' } }).ok).toBe(true);
    expect(ok({ name: 'x', transport: 'stdio' }).ok).toBe(true);
    expect(ok({ name: 'x', transport: 42 }).ok).toBe(false);
  });
});
