import { describe, expect, it, vi } from 'vitest';
import { EngineHttpError, retryWhileUnavailable } from '../src/engine-http';

vi.mock('../src/platform', () => ({ request: vi.fn() }));

describe('retryWhileUnavailable', () => {
  it('reads again while the engine answers 503, then returns the data', async () => {
    const http = vi
      .fn()
      .mockRejectedValueOnce(new EngineHttpError(503, { error: 'CodeMap index unavailable' }))
      .mockRejectedValueOnce(new EngineHttpError(503, { error: 'CodeMap index unavailable' }))
      .mockResolvedValue({ nodes: [{ id: 'a' }] });
    const read = retryWhileUnavailable(http, [1, 1, 1]);
    await expect(read('/api/codemap/packages')).resolves.toEqual({ nodes: [{ id: 'a' }] });
    expect(http).toHaveBeenCalledTimes(3);
  });

  it('gives up after its delays, and never retries other errors or writes', async () => {
    const unavailable = new EngineHttpError(503, { error: 'CodeMap index unavailable' });
    const always = vi.fn().mockRejectedValue(unavailable);
    await expect(retryWhileUnavailable(always, [1, 1])('/api/codemap/packages')).rejects.toBe(
      unavailable,
    );
    expect(always).toHaveBeenCalledTimes(3);

    const missing = vi.fn().mockRejectedValue(new EngineHttpError(404, {}));
    await expect(retryWhileUnavailable(missing, [1])('/x')).rejects.toBeInstanceOf(EngineHttpError);
    expect(missing).toHaveBeenCalledTimes(1);

    const owned = new EngineHttpError(503, { error: 'owned', ownedExternally: true });
    const external = vi.fn().mockRejectedValue(owned);
    await expect(retryWhileUnavailable(external, [1, 1])('/api/codemap/packages')).rejects.toBe(
      owned,
    );
    expect(external).toHaveBeenCalledTimes(1);

    const post = vi.fn().mockRejectedValue(unavailable);
    await expect(retryWhileUnavailable(post, [1])('/api/codemap/index', 'POST', {})).rejects.toBe(
      unavailable,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
});
