import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueGraphTransfer, startGraphTransfer } from '../src/server/codemap-transfer.js';

const size = 512 * 1024;
function start(scope = 'project:packages', body = 'a'.repeat(size + 1)) {
  return startGraphTransfer(scope, body, new URLSearchParams({ transfer: 'chunks' }));
}
function continuation(id: string, offset = String(size)) {
  return new URLSearchParams({ transfer: 'chunks', snapshot: id, offset });
}

afterEach(() => vi.useRealTimers());
describe('CodeMap transfer snapshots', () => {
  it('preserves legacy full JSON and the exact small-response boundary', () => {
    const body = 'a'.repeat(size + 1);
    expect(startGraphTransfer('scope', body)).toEqual({ status: 200, body });
    expect(start('scope', 'a'.repeat(size)).body).toHaveLength(size);
  });

  it('pins bytes across changes and isolates project, index directory and graph scope', () => {
    const first = JSON.parse(start().body);
    const updated = JSON.parse(start('project:packages', 'b'.repeat(size + 1)).body);
    expect(updated.snapshot).not.toBe(first.snapshot);
    const tail = continueGraphTransfer('project:packages', continuation(first.snapshot));
    expect(Buffer.from(JSON.parse(tail?.body ?? '{}').chunk, 'base64').toString()).toBe('a');
    expect(continueGraphTransfer('other:packages', continuation(first.snapshot))?.status).toBe(409);
    expect(continueGraphTransfer('project:files', continuation(first.snapshot))?.status).toBe(409);
  });

  it.each(['-1', '1.5', '1', 'NaN', '9007199254740992', String(size * 2)])(
    'rejects invalid continuation offsets: %s',
    (offset) => {
      const first = JSON.parse(start().body);
      expect(
        continueGraphTransfer('project:packages', continuation(first.snapshot, offset))?.status,
      ).toBe(400);
    },
  );

  it('expires snapshots deterministically', () => {
    vi.useFakeTimers();
    const first = JSON.parse(start().body);
    vi.advanceTimersByTime(60_000);
    expect(continueGraphTransfer('project:packages', continuation(first.snapshot))?.status).toBe(
      409,
    );
  });

  it('bounds retained snapshot count and rejects oversized graphs without truncating', () => {
    const first = JSON.parse(start().body);
    for (let i = 0; i < 8; i++) start();
    expect(continueGraphTransfer('project:packages', continuation(first.snapshot))?.status).toBe(
      409,
    );
    const rejected = start('scope', 'a'.repeat(16 * 1024 * 1024 + 1));
    expect(rejected.status).toBe(413);
    expect(JSON.parse(rejected.body).code).toBe('CODEMAP_GRAPH_TOO_LARGE');
  });
});
