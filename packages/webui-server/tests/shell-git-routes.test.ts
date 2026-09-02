import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleShellGitRoute, type ShellGitRouteHandlers } from '@wrongstack/webui-server';

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(
    ([raw]) => JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> },
  );
}

function handlers(): ShellGitRouteHandlers {
  return {
    gitInfo: vi.fn(async () => undefined),
    gitChanges: vi.fn(async () => undefined),
    gitDiff: vi.fn(async () => undefined),
    gitStage: vi.fn(async () => undefined),
    gitUnstage: vi.fn(async () => undefined),
    gitDiscard: vi.fn(async () => undefined),
    gitCommit: vi.fn(async () => undefined),
    shellOpen: vi.fn(async () => undefined),
  };
}

describe('handleShellGitRoute dispatcher characterization', () => {
  it('returns false and does not send for non-shell/git message types', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(handleShellGitRoute(ws, { type: 'modes.list', payload: {} }, h)).resolves.toBe(
      false,
    );

    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([
    ['git.info', 'gitInfo'],
    ['git.changes', 'gitChanges'],
    ['git.diff', 'gitDiff'],
    ['git.stage', 'gitStage'],
    ['git.unstage', 'gitUnstage'],
    ['git.discard', 'gitDiscard'],
    ['git.commit', 'gitCommit'],
    ['shell.open', 'shellOpen'],
  ] as const)('dispatches %s to %s and returns true', async (type, handlerName) => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type, payload: { path: 'src/index.ts' } };

    await expect(handleShellGitRoute(ws, msg, h)).resolves.toBe(true);

    expect(h[handlerName]).toHaveBeenCalledTimes(1);
    if (handlerName === 'gitInfo' || handlerName === 'gitChanges') {
      expect(h[handlerName]).toHaveBeenCalledWith(ws);
    } else {
      expect(h[handlerName]).toHaveBeenCalledWith(ws, msg);
    }
  });

  it('does not invoke any other handler when one type is dispatched', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleShellGitRoute(ws, { type: 'git.info', payload: {} }, h);

    expect(h.gitInfo).toHaveBeenCalledTimes(1);
    expect(h.gitChanges).not.toHaveBeenCalled();
    expect(h.gitDiff).not.toHaveBeenCalled();
    expect(h.shellOpen).not.toHaveBeenCalled();
  });

  it('dispatches git.diff with the original message object', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'git.diff', payload: { path: 'src/index.ts' } };

    await handleShellGitRoute(ws, msg, h);

    expect(h.gitDiff).toHaveBeenCalledWith(ws, msg);
  });

  it('dispatches shell.open with the original message object', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'shell.open', payload: { path: '.', target: 'terminal' } };

    await handleShellGitRoute(ws, msg, h);

    expect(h.shellOpen).toHaveBeenCalledWith(ws, msg);
  });

  it('does not send any messages for a valid dispatch when the handler is a no-op stub', async () => {
    const ws = mockWs();
    const h = handlers();

    await handleShellGitRoute(ws, { type: 'git.diff', payload: { path: 'src/index.ts' } }, h);

    expect(sentMessages(ws)).toEqual([]);
  });
});
