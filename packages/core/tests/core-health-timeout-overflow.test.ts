import { describe, expect, it } from 'vitest';
import { DefaultHealthRegistry } from '../src/observability/health.js';

describe('DefaultHealthRegistry timeout clamping', () => {
  it('clamps >32-bit and non-finite timeoutMs so healthy checks do not time out immediately', async () => {
    const reg = new DefaultHealthRegistry({ timeoutMs: 1e15 });
    reg.register({
      name: 'db',
      check: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { status: 'healthy' };
      },
    });
    const agg = await reg.run();
    expect(agg.status).toBe('healthy');

    const nanReg = new DefaultHealthRegistry({ timeoutMs: Number.NaN });
    nanReg.register({ name: 'ok', check: async () => ({ status: 'healthy' }) });
    expect((await nanReg.run()).status).toBe('healthy');
  });
});
