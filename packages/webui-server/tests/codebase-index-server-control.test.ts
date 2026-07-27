import type { TrustBoundary } from '@wrongstack/core/security';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const shutdownServer = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/tools', () => ({
  shutdownCodebaseIndexServer: shutdownServer,
}));

const { handleCodebaseIndexServerControl } = await import(
  '../src/server/codebase-index-server-control.js'
);

function boundary(kind: 'allow' | 'deny'): TrustBoundary {
  return {
    evaluate: vi.fn(async () => ({
      kind,
      reason: kind === 'allow' ? 'test allow' : 'test deny',
    })),
  };
}

describe('codebase index server WebSocket control', () => {
  beforeEach(() => {
    shutdownServer.mockReset();
    shutdownServer.mockResolvedValue({ stopped: true, pid: 1234 });
  });

  it('stops the current project server and returns its pid', async () => {
    const send = vi.fn();
    const handled = await handleCodebaseIndexServerControl(
      {} as never,
      {
        type: 'codebase.index.server.shutdown',
        payload: { requestId: 'shutdown-1' },
      },
      {
        trustBoundary: boundary('allow'),
        getProjectRoot: () => '/project',
        getIndexDir: () => '/index',
        send,
        backend: 'standalone',
      },
    );

    expect(handled).toBe(true);
    expect(shutdownServer).toHaveBeenCalledWith('/project', '/index', 'websocket-request');
    expect(send).toHaveBeenCalledWith(expect.anything(), {
      type: 'codebase.index.server.shutdown_result',
      payload: { requestId: 'shutdown-1', stopped: true, pid: 1234 },
    });
  });

  it('does not stop the server when the trust boundary denies it', async () => {
    const send = vi.fn();
    await handleCodebaseIndexServerControl(
      {} as never,
      {
        type: 'codebase.index.server.shutdown',
        payload: { requestId: 'shutdown-2' },
      },
      {
        trustBoundary: boundary('deny'),
        getProjectRoot: () => '/project',
        getIndexDir: () => undefined,
        send,
        backend: 'cli-embedded',
      },
    );

    expect(shutdownServer).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      type: 'codebase.index.server.shutdown_result',
      payload: {
        requestId: 'shutdown-2',
        stopped: false,
        reason: 'Shutdown denied: test deny',
      },
    });
  });

  it('ignores unrelated messages', async () => {
    const handled = await handleCodebaseIndexServerControl(
      {} as never,
      { type: 'ping' },
      {
        trustBoundary: boundary('allow'),
        getProjectRoot: () => '/project',
        getIndexDir: () => undefined,
        send: vi.fn(),
        backend: 'standalone',
      },
    );
    expect(handled).toBe(false);
  });
});
