import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineOperations } from '../src/engine-operations';

afterEach(() => vi.useRealTimers());
describe('native engine operation acknowledgements', () => {
  it('retains correlated refinement recovery details on a refused operation', async () => {
    let id: unknown;
    const operations = new EngineOperations(async (_type, payload) => {
      id = payload!['requestId'];
    });
    const pending = operations.request('model.refine', { text: 'Keep this draft' }, [
      'model.refine_result',
    ]);
    operations.receive({
      type: 'model.refine_result',
      payload: {
        requestId: id,
        error: 'Refinement returned no result',
        errorKind: 'timeout',
        retryTimeoutMs: 240000,
        fallbackRef: 'local/org/model',
      },
    });
    await expect(pending).rejects.toMatchObject({
      message: 'Refinement returned no result',
      details: { errorKind: 'timeout', retryTimeoutMs: 240000, fallbackRef: 'local/org/model' },
    });
  });
  it('rejects a correlated queue refusal sent as a generic error', async () => {
    let id: unknown;
    const operations = new EngineOperations(async (_type, payload) => {
      id = payload!['requestId'];
    });
    const pending = operations.request('queue.add', { text: 'Keep this draft' }, ['queue.state']);
    operations.receive({
      type: 'error',
      payload: { requestId: id, phase: 'queue.add', message: 'Queue is full' },
    });
    await expect(pending).rejects.toThrow('Queue is full');
  });
  it('rejects domain errors that do not use a success flag', async () => {
    let id: unknown;
    const operations = new EngineOperations(async (_type, payload) => {
      id = payload!['requestId'];
    });
    const pending = operations.request('memory.sage.remember', { text: 'A native memory' }, [
      'memory.sage.remember',
    ]);
    operations.receive({
      type: 'memory.sage.remember',
      payload: { requestId: id, error: 'Memory store unavailable' },
    });
    await expect(pending).rejects.toThrow('Memory store unavailable');
  });
  it('matches out-of-order responses to their own request and ignores old acknowledgements', async () => {
    const sent: Record<string, unknown>[] = [];
    const operations = new EngineOperations(async (_type, payload) => {
      sent.push(payload!);
    });
    const first = operations.request('key.add', {}, ['key.operation_result']);
    const second = operations.request('model.switch', {}, ['model.switch_result']);
    operations.receive({
      type: 'key.operation_result',
      payload: { requestId: 'stale', success: true },
    });
    operations.receive({
      type: 'model.switch_result',
      payload: { requestId: sent[1]!['requestId'], success: true, model: 'picked' },
    });
    operations.receive({
      type: 'key.operation_result',
      payload: { requestId: sent[0]!['requestId'], success: true, message: 'Saved' },
    });
    await expect(second).resolves.toMatchObject({ model: 'picked' });
    await expect(first).resolves.toMatchObject({ message: 'Saved' });
  });
  it('rejects a failed operation instead of reporting a queued request as saved', async () => {
    let id: unknown;
    const operations = new EngineOperations(async (_type, payload) => {
      id = payload!['requestId'];
    });
    const result = operations.request('key.add', {}, ['key.operation_result']);
    operations.receive({
      type: 'key.operation_result',
      payload: { requestId: id, success: false, message: 'Vault unavailable' },
    });
    await expect(result).rejects.toThrow('Vault unavailable');
  });
  it('rejects a Git refusal even when its error is not included', async () => {
    let id: unknown;
    const operations = new EngineOperations(async (_type, payload) => {
      id = payload!['requestId'];
    });
    const result = operations.request('git.stage', { paths: ['a.ts'] }, ['git.action_result']);
    operations.receive({ type: 'git.action_result', payload: { requestId: id, ok: false } });
    await expect(result).rejects.toThrow('Engine request failed');
  });
  it('bounds unanswered requests and rejects pending work when a session view detaches', async () => {
    vi.useFakeTimers();
    const operations = new EngineOperations(async () => {}, 1000);
    const timed = operations.request('key.add', {}, ['key.operation_result']);
    const rejected = expect(timed).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    const detached = operations.request('key.add', {}, ['key.operation_result']);
    operations.clear();
    await expect(detached).rejects.toThrow('detached');
  });
  it('starts a request timeout only once the journal replay has caught up', async () => {
    vi.useFakeTimers();
    let id: unknown;
    const operations = new EngineOperations(
      async (_type, payload) => {
        id = payload!['requestId'];
      },
      1000,
      60000,
    );
    // A window replays a long project journal; its first request's reply is still behind.
    operations.replaying();
    const tree = operations.request('files.tree', {}, ['files.tree']);
    let settled = false;
    void tree.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    operations.receive({ type: 'files.tree', payload: { requestId: id, tree: [] } });
    await expect(tree).resolves.toMatchObject({ tree: [] });
    // Once caught up, an unanswered request gets its own timeout from that moment.
    operations.replaying();
    const late = operations.request('files.tree', {}, ['files.tree']);
    const rejected = expect(late).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(5000);
    operations.caughtUp();
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    // A replay that never catches up is still bounded.
    operations.replaying();
    const capped = operations.request('files.tree', {}, ['files.tree']);
    const bounded = expect(capped).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(60000);
    await bounded;
  });
});
