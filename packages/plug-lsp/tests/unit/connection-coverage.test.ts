import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { Connection } from '../../src/server/connection.js';
import { LSPErrorCode } from '../../src/types.js';

function frame(value: unknown): Buffer {
  const body = JSON.stringify(value);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

describe('Connection protocol completion coverage', () => {
  it('dispatches successful, failed, unknown, and notification messages', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = new Connection(stdin, stdout);
    const notification = vi.fn();
    const unsubscribe = connection.onNotification('server/event', notification);

    const success = connection.sendRequest<{ ok: boolean }>(
      'success',
      { value: 1 },
      1_000,
      new AbortController().signal,
    );
    stdout.write(frame({ jsonrpc: '2.0', id: 999, result: 'ignored' }));
    stdout.write(frame({ jsonrpc: '2.0', id: '1', result: { ok: true } }));
    await expect(success).resolves.toEqual({ ok: true });

    const failure = connection.sendRequest('failure', null, 1_000, new AbortController().signal);
    stdout.write(
      frame({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: 'server failed', data: { retry: false } },
      }),
    );
    await expect(failure).rejects.toMatchObject({
      code: LSPErrorCode.ProtocolError,
      message: 'server failed',
    });

    stdout.write(frame({ jsonrpc: '2.0', method: 'server/event', params: { changed: true } }));
    expect(notification).toHaveBeenCalledWith({ changed: true });
    unsubscribe();
    stdout.write(frame({ jsonrpc: '2.0', method: 'server/event', params: 'ignored' }));
    expect(notification).toHaveBeenCalledOnce();
  });

  it('recovers from malformed headers, lengths, JSON, and partial frames', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = new Connection(stdin, stdout);
    const received = vi.fn();
    connection.onNotification('valid', received);

    stdout.write(Buffer.from('Missing: length\r\n\r\njunk'));
    stdout.write(Buffer.from('Content-Length: 99999999\r\n\r\n'));
    stdout.write(Buffer.from('Content-Length: 1\r\n\r\n{'));
    const valid = frame({ jsonrpc: '2.0', method: 'valid', params: 1 });
    stdout.write(valid.subarray(0, 10));
    stdout.write(valid.subarray(10));
    const partialBody = frame({ jsonrpc: '2.0', method: 'valid', params: 2 });
    stdout.write(partialBody.subarray(0, partialBody.length - 2));
    stdout.write(partialBody.subarray(partialBody.length - 2));
    stdout.write(frame({ jsonrpc: '2.0' }));
    expect(received).toHaveBeenCalledWith(1);
    expect(received).toHaveBeenCalledWith(2);
  });

  it('closes on receive overflow and keeps close and unsubscription idempotent', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = new Connection(stdin, stdout);
    const closed = vi.fn();
    const unsubscribe = connection.onClose(closed);
    stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(closed).toHaveBeenCalledOnce();
    connection.close();
    expect(closed).toHaveBeenCalledOnce();
    unsubscribe();
    expect(() => connection.sendNotification('after/close', null)).toThrow('closed');
  });

  it('cancels pending requests and tolerates cancellation write failures', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const connection = new Connection(stdin, stdout);
    const controller = new AbortController();
    const pending = connection.sendRequest('cancel', null, 1_000, controller.signal);
    vi.spyOn(connection, 'sendNotification').mockImplementationOnce(() => {
      throw new Error('cancel transport failed');
    });
    controller.abort(new Error('operator cancelled'));
    await expect(pending).rejects.toThrow('operator cancelled');
  });

  it('fails pending requests for stdout errors and close events, including non-Errors', async () => {
    for (const terminal of ['error', 'close'] as const) {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const connection = new Connection(stdin, stdout);
      const pending = connection.sendRequest(terminal, null, 1_000, new AbortController().signal);
      if (terminal === 'error') stdout.emit('error', 'transport text failure' as never);
      else stdout.emit('close');
      await expect(pending).rejects.toBeInstanceOf(Error);
    }
  });
});
