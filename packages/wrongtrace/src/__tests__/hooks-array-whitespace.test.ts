import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetWrongTraceGate } from '../gate.js';
import { createWrongTraceHookPair } from '../hooks.js';

describe('WrongTrace hooks array files whitespace normalization (F1842)', () => {
  it('skips blank items and trims array file paths so peer locks are enforced', async () => {
    const baseDir = path.resolve('/tmp/wt-f1842-test');
    const expectedTarget = path.resolve(baseDir, 'src/locked.ts');
    const origFetch = globalThis.fetch;
    const origEnv = process.env['WRONGTRACE_URL'];
    process.env['WRONGTRACE_URL'] = 'http://127.0.0.1:48999';
    resetWrongTraceGate();
    globalThis.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/health') {
        return new Response(
          JSON.stringify({ ok: true, status: 'ok', version: '0.3.3', socket_path: '' }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/file/health') {
        const queried = url.searchParams.get('path') ?? '';
        const locked = path.resolve(queried) === expectedTarget;
        return new Response(
          JSON.stringify({
            health_score: 90,
            is_fragile: false,
            is_locked: locked,
            ...(locked ? { lock_owner: 'other-agent', lock_reason: 'editing' } : {}),
          }),
          { status: 200 },
        );
      }
      if (url.pathname === '/api/metrics/friction') {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const hooks = createWrongTraceHookPair(() => 'sess-1', { baseDir: () => baseDir });
      const verdict = await hooks.preToolUse({
        toolName: 'replace',
        toolInput: { files: ['   ', ' src/locked.ts '] },
      });
      expect(verdict?.action).toBe('deny');
    } finally {
      globalThis.fetch = origFetch;
      if (origEnv === undefined) delete process.env['WRONGTRACE_URL'];
      else process.env['WRONGTRACE_URL'] = origEnv;
      resetWrongTraceGate();
    }
  });
});
