import type { TrustBoundary } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeDesktopAction,
  authorizeDesktopRuntimeStart,
  authorizeDesktopRuntimeStop,
  desktopCompatibilityTrustBoundary,
} from '../src/main/desktop-privileged-actions.js';

describe('Desktop privileged action adapter', () => {
  it('classifies native actions and preserves deny decisions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const evaluate = vi.fn(async () => ({ kind: 'deny' as const, reason: 'blocked by policy' }));
    const boundary: TrustBoundary = { evaluate };

    const result = await authorizeDesktopAction(boundary, {
      capability: 'url.open-external',
      subject: { kind: 'url', id: 'https://example.test' },
      risk: 'elevated',
      origin: 'user',
      metadata: { operation: 'test' },
    });

    expect(result).toEqual({ allowed: false, reason: 'blocked by policy' });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'desktop',
        actor: { kind: 'user', id: 'desktop-user' },
        capability: 'url.open-external',
        subject: { kind: 'url', id: 'https://example.test' },
        authContext: { method: 'local-process', principalId: 'desktop-user' },
      }),
    );
  });

  /**
   * WS-SEC-03. The actor used to be hardcoded to `user` at every call site,
   * and `createCompatibilityTrustBoundary` only ever denies `remote-client` —
   * so no desktop authorization could ever come back denied, whatever the
   * policy said. These two assert the request now carries the real origin.
   */
  it('attributes a WebUI-view action to remote-client, not the shell user', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, reason: 'ok' }));

    await authorizeDesktopAction(
      { evaluate },
      {
        capability: 'url.open-external',
        subject: { kind: 'url', id: 'https://example.test' },
        risk: 'elevated',
        origin: 'remote-client',
      },
    );

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { kind: 'remote-client', id: 'desktop-webui-view' },
        authContext: { method: 'local-process', principalId: 'desktop-webui-view' },
      }),
    );
  });

  it('the shipped desktop policy denies a high-risk action from the WebUI view', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const denied = await authorizeDesktopAction(desktopCompatibilityTrustBoundary, {
      capability: 'process.spawn',
      subject: { kind: 'command', id: 'anything' },
      risk: 'high',
      origin: 'remote-client',
    });
    const allowed = await authorizeDesktopAction(desktopCompatibilityTrustBoundary, {
      capability: 'process.spawn',
      subject: { kind: 'command', id: 'anything' },
      risk: 'high',
      origin: 'user',
    });

    expect(denied.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
  });

  it('authorizeDesktopRuntimeStart emits process.spawn with command subject', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, reason: 'ok' }));
    const boundary: TrustBoundary = { evaluate };

    const result = await authorizeDesktopRuntimeStart(boundary, '/projects/test', 'node');

    expect(result).toEqual({ allowed: true, reason: 'ok' });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'process.spawn',
        subject: {
          kind: 'command',
          id: 'wrongstack-webui-runtime',
          attributes: { runtimeKind: 'node' },
        },
        risk: 'high',
        scope: { cwd: '/projects/test' },
      }),
    );
  });

  it('authorizeDesktopRuntimeStop emits process.terminate with runtime id as subject.id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const evaluate = vi.fn(async () => ({ kind: 'allow' as const, reason: 'ok' }));
    const boundary: TrustBoundary = { evaluate };

    const result = await authorizeDesktopRuntimeStop(boundary, {
      id: 'rt-42',
      pid: 12345,
      root: '/projects/test',
    });

    expect(result).toEqual({ allowed: true, reason: 'ok' });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'process.terminate',
        subject: { kind: 'process', id: 'rt-42', attributes: { pid: 12345, runtimeId: 'rt-42' } },
        risk: 'high',
        scope: { cwd: '/projects/test' },
      }),
    );
  });
});

/**
 * WS-SEC-13. None of the `ipcMain.handle` channels checked their sender, while
 * the three `ipcMain.on` handlers in the same file already resolved one. The
 * window hosts a second renderer — the WebUI view, whose content is remote and
 * reflects agent and tool output — so "unreachable because another file does
 * not expose invoke" was the only thing standing between it and channels that
 * spawn runtimes and message live agents.
 */
describe('IPC invoke channels are shell-only (WS-SEC-13)', () => {
  it('registers every invoke channel through the sender gate', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/main/ipc-handlers/index.ts', import.meta.url), 'utf8'),
    );

    // Gating at registration is what makes a channel added later covered by
    // construction; a bare `ipcMain.handle` is the regression.
    expect(src).not.toMatch(/\bipcMain\.handle\(IPC\./);
    expect(src).toMatch(/function handleShellOnly\(/);
    expect((src.match(/handleShellOnly\(ctx, IPC\./g) ?? []).length).toBeGreaterThanOrEqual(18);
  });
});
