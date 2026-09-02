import type { TrustBoundary } from '@wrongstack/core/security';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeDesktopAction,
  authorizeDesktopRuntimeStart,
  authorizeDesktopRuntimeStop,
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
