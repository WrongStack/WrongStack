import { describe, expect, it } from 'vitest';
import {
  assertMatchingJsonRpcResult,
  extractJsonRpcEnvelopes,
  isJsonRpcResult,
} from '../src/transport-jsonrpc.js';

describe('transport JSON-RPC validation', () => {
  it('accepts result and error responses', () => {
    expect(isJsonRpcResult({ jsonrpc: '2.0', id: 1, result: null })).toBe(true);
    expect(
      isJsonRpcResult({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -1, message: 'failed' },
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    'response',
    {},
    { jsonrpc: '1.0', id: 1, result: true },
    { jsonrpc: '2.0', id: '1', result: true },
    { jsonrpc: '2.0', id: 1, method: 'ping', result: true },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, result: true, error: { code: 1, message: 'x' } },
    { jsonrpc: '2.0', id: 1, error: null },
    { jsonrpc: '2.0', id: 1, error: 'failed' },
    { jsonrpc: '2.0', id: 1, error: { code: '1', message: 'failed' } },
    { jsonrpc: '2.0', id: 1, error: { code: 1, message: 2 } },
  ])('rejects malformed result envelope %#', (value) => {
    expect(isJsonRpcResult(value)).toBe(false);
  });

  it('extracts method envelopes with every supported id type', () => {
    const envelopes = extractJsonRpcEnvelopes(
      [
        '{"jsonrpc":"2.0","method":"notify"}',
        '{"jsonrpc":"2.0","id":1,"method":"number"}',
        '{"jsonrpc":"2.0","id":"one","method":"string"}',
      ].join('\n'),
    );
    expect(envelopes).toHaveLength(3);
  });

  it('ignores malformed method envelopes and plain noise', () => {
    expect(
      extractJsonRpcEnvelopes(
        [
          'noise',
          '[]',
          '{invalid',
          '{"jsonrpc":"1.0","method":"old"}',
          '{"jsonrpc":"2.0","method":1}',
          '{"jsonrpc":"2.0","id":true,"method":"bad-id"}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('handles all SSE framing fields and empty events', () => {
    const envelopes = extractJsonRpcEnvelopes(
      [
        '',
        ': keepalive\r',
        'event: message',
        'id: event-id',
        'retry: 1000',
        'data:',
        'data:   ',
        '',
        'data:{"jsonrpc":"2.0","id":4,"result":true}',
        '',
        'data: not-json',
        '',
        'data: null',
        '',
        'data: {}',
        '',
      ].join('\n'),
    );
    expect(envelopes).toEqual([{ jsonrpc: '2.0', id: 4, result: true }]);
  });

  it('asserts the expected response id', () => {
    const response = { jsonrpc: '2.0', id: 7, result: 'ok' };
    expect(assertMatchingJsonRpcResult(response, 7, 'tools/list')).toBe(response);
    expect(() => assertMatchingJsonRpcResult({}, 7, 'tools/list')).toThrow(/not a JSON-RPC/);
    expect(() => assertMatchingJsonRpcResult(response, 8, 'tools/list')).toThrow(/id mismatch/);
  });
});
