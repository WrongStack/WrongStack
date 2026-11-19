import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestAcpRuntime, saveSessionAcpRuntime } from '../../src/lib/acp-runtime';

// acp-runtime.ts resolves its ws-client import to the same module as the
// '@/lib/ws-client' alias, so one mock intercepts both.
const ws = vi.hoisted(() => ({
  status: { state: 'open' },
  send: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ws }));

type OperationResultMessage = { payload: Record<string, unknown> };

beforeEach(() => {
  vi.useFakeTimers();
  ws.status.state = 'open';
  ws.send.mockReset().mockReturnValue(true);
  ws.off.mockReset();
  ws.on.mockReset().mockReturnValue(ws.off);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('saveSessionAcpRuntime', () => {
  it('rejects without sending when the session id is missing', async () => {
    await expect(saveSessionAcpRuntime({ 'agent-x': { model: 'plan' } }, null)).rejects.toThrow(
      'ACP settings require a connected session.',
    );
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.on).not.toHaveBeenCalled();
  });

  it('rejects without sending when the client is not open', async () => {
    ws.status.state = 'closed';
    await expect(
      saveSessionAcpRuntime({ 'agent-x': { model: 'plan' } }, 'session-1'),
    ).rejects.toThrow('ACP settings require a connected session.');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends prefs.update and resolves only on its correlated success result', async () => {
    const settings = { 'agent-x': { model: 'plan' } };
    const pending = saveSessionAcpRuntime(settings, 'session-1');

    expect(ws.on).toHaveBeenCalledWith('key.operation_result', expect.any(Function));
    const sent = ws.send.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(sent.type).toBe('prefs.update');
    expect(sent.payload.sessionId).toBe('session-1');
    expect(sent.payload.acpRuntime).toEqual(settings);
    expect(typeof sent.payload.requestId).toBe('string');

    const handler = ws.on.mock.calls[0][1] as (m: OperationResultMessage) => void;
    // A result for another requestId must be ignored, leaving the save pending.
    handler({ payload: { requestId: 'other', success: true } });
    expect(ws.off).not.toHaveBeenCalled();

    handler({ payload: { requestId: sent.payload.requestId, success: true } });
    await expect(pending).resolves.toBeUndefined();
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the server message on a correlated failure result', async () => {
    const pending = saveSessionAcpRuntime({}, 'session-1');
    const handler = ws.on.mock.calls[0][1] as (m: OperationResultMessage) => void;
    const requestId = (ws.send.mock.calls[0][0] as { payload: Record<string, unknown> }).payload
      .requestId as string;
    handler({ payload: { requestId, success: false, message: 'denied by policy' } });
    await expect(pending).rejects.toThrow('denied by policy');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to a generic error when a failure result carries no message', async () => {
    const pending = saveSessionAcpRuntime({}, 'session-1');
    const handler = ws.on.mock.calls[0][1] as (m: OperationResultMessage) => void;
    const requestId = (ws.send.mock.calls[0][0] as { payload: Record<string, unknown> }).payload
      .requestId as string;
    handler({ payload: { requestId, success: false } });
    await expect(pending).rejects.toThrow('ACP settings save failed.');
  });

  it('rejects and releases the listener when the save is never confirmed', async () => {
    const pending = saveSessionAcpRuntime({}, 'session-1');
    const assertion = expect(pending).rejects.toThrow('ACP settings save was not confirmed.');
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects and releases the listener when the send is refused', async () => {
    ws.send.mockReturnValue(false);
    await expect(saveSessionAcpRuntime({}, 'session-1')).rejects.toThrow(
      'ACP settings save could not be sent.',
    );
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('requestAcpRuntime', () => {
  it('rejects without sending when the client is not open', async () => {
    ws.status.state = 'connecting';
    await expect(requestAcpRuntime('agent-x', { model: 'plan' })).rejects.toThrow(
      'ACP settings require a connected session.',
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('sends acp.config_options and resolves with its correlated payload', async () => {
    const values = { model: 'plan' };
    const pending = requestAcpRuntime('agent-x', values);

    expect(ws.on).toHaveBeenCalledWith('acp.config_options', expect.any(Function));
    const sent = ws.send.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(sent.type).toBe('acp.config_options');
    expect(sent.payload.agentId).toBe('agent-x');
    expect(sent.payload.values).toEqual(values);
    expect(typeof sent.payload.requestId).toBe('string');

    const handler = ws.on.mock.calls[0][1] as (m: OperationResultMessage) => void;
    const result = {
      requestId: sent.payload.requestId,
      ok: true,
      agentId: 'agent-x',
      options: [
        {
          id: 'model',
          name: 'Model',
          currentValue: 'plan',
          options: [{ value: 'plan', name: 'Plan' }],
        },
      ],
      applied: values,
    };
    handler({ payload: result });
    // The resolved contract is the full correlated payload (transport fields
    // included), typed as AcpRuntimeOptionsResult.
    await expect(pending).resolves.toEqual({
      requestId: result.requestId,
      ok: true,
      agentId: 'agent-x',
      options: result.options,
      applied: values,
    });
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the server error on a correlated failed reply', async () => {
    const pending = requestAcpRuntime('agent-x', {});
    const handler = ws.on.mock.calls[0][1] as (m: OperationResultMessage) => void;
    const requestId = (ws.send.mock.calls[0][0] as { payload: Record<string, unknown> }).payload
      .requestId as string;
    handler({ payload: { requestId, ok: false, error: 'agent unreachable' } });
    await expect(pending).rejects.toThrow('agent unreachable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to a generic error when a failed reply carries no error', async () => {
    const pending = requestAcpRuntime('agent-x', {});
    const handler = ws.on.mock.calls[0][1] as (m: OperationResultMessage) => void;
    const requestId = (ws.send.mock.calls[0][0] as { payload: Record<string, unknown> }).payload
      .requestId as string;
    handler({ payload: { requestId, ok: false } });
    await expect(pending).rejects.toThrow('ACP settings request failed.');
  });

  it('rejects and releases the listener when the request times out', async () => {
    const pending = requestAcpRuntime('agent-x', {});
    const assertion = expect(pending).rejects.toThrow('ACP settings request timed out.');
    await vi.advanceTimersByTimeAsync(100_000);
    await assertion;
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects and releases the listener when the send is refused', async () => {
    ws.send.mockReturnValue(false);
    await expect(requestAcpRuntime('agent-x', {})).rejects.toThrow(
      'ACP settings require a connected session.',
    );
    expect(ws.off).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
