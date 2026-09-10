import { describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  on: vi.fn(),
}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ on: seams.on }),
}));

vi.mock('@/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ wsUrl: 'ws://test' }) },
}));

const { ensureInspectHandlerInstalled, useSessionInspectStore } = await import(
  '../../src/stores/session-inspect-store'
);

describe('session-inspect error state', () => {
  it('redacts server errors before storing them for rendered UI', () => {
    ensureInspectHandlerInstalled();
    const handler = seams.on.mock.calls[0]?.[1] as
      | ((message: { payload: { error: string } }) => void)
      | undefined;
    expect(handler).toBeDefined();

    const secret = ['s' + 'k', 'proj', '1234567890123456789012345678901234567890'].join('-');
    handler!({ payload: { error: `inspect failed with ${secret}` } });

    const error = useSessionInspectStore.getState().error;
    expect(error).toContain('inspect failed with');
    expect(error).not.toContain(secret);
  });
});
