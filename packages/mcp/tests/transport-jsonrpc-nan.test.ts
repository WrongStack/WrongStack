import { describe, expect, it } from 'vitest';
import { isJsonRpcResult } from '../src/transport-jsonrpc.js';

describe('isJsonRpcResult finite numeric validation', () => {
  it('rejects NaN and Infinity for id and error.code', () => {
    expect(isJsonRpcResult({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isJsonRpcResult({ jsonrpc: '2.0', id: Number.NaN, result: {} })).toBe(false);
    expect(
      isJsonRpcResult({
        jsonrpc: '2.0',
        id: 1,
        error: { code: Number.POSITIVE_INFINITY, message: 'err' },
      }),
    ).toBe(false);
  });
});
