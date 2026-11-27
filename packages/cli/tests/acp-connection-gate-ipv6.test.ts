import { describe, expect, it } from 'vitest';
import { createAcpConnectionGate } from '../src/subcommands/handlers/acp-connection-gate.js';

describe('createAcpConnectionGate IPv6 bind support (F2728)', () => {
  it('accepts ?token= and matching Origin on ::1 bind', () => {
    const gate = createAcpConnectionGate({ host: '::1', port: 9000, token: 'secret' });

    expect(gate.check({ url: '/?token=secret', headers: { host: '[::1]:9000' } }, 0)).toEqual({
      ok: true,
    });

    expect(
      gate.check(
        { url: '/?token=secret', headers: { host: '[::1]:9000', origin: 'http://[::1]:9000' } },
        0,
      ),
    ).toEqual({ ok: true });
  });
});
