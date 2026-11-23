import { resetWrongTraceGate } from '@wrongstack/wrongtrace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWrongTracePromptContributor } from '../src/system-prompt/wrongtrace-prompt-contributor.js';

// F1450: the boot-prompt friction line must keep summarizeFriction's units
// consistent. getFrictionMatrix() carries the daemon's `total_collisions` (a
// collision count) on its row array; the contributor used to replace it with
// `rows.length` (an edge count) while self-thrash stayed collision-weighted, so
// a 50/50 split read "0% of 2 collisions, self-thrash 100%".

// A pipe/socket name that does not exist: the IPC transport fails fast and the
// client falls back to the stubbed HTTP routes, never a real daemon.
const MISSING_SOCKET =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\ws-test-wrongtrace-friction-units-missing'
    : '/nonexistent-ws-test-wrongtrace-friction-units.sock';

function stubDaemon(friction: unknown): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/api/health')) return json({ status: 'ok', socket_path: MISSING_SOCKET });
    if (url.includes('/api/atlas')) return json({ workspaces: ['w'], packages: [] });
    if (url.includes('/api/metrics/friction')) return json(friction);
    return new Response('not found', { status: 404 });
  });
}

async function promptText(friction: unknown): Promise<string> {
  resetWrongTraceGate();
  stubDaemon(friction);
  const blocks = await createWrongTracePromptContributor()({ subagent: false } as never);
  return blocks.map((b) => (b as { text?: string }).text ?? '').join('\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetWrongTraceGate();
});

describe('WrongTrace prompt contributor friction units (F1450)', () => {
  it('uses the daemon total_collisions, not the edge count', async () => {
    const text = await promptText({
      edges: [
        { author_model: 'm1', overwriter_model: 'm2', conflict_count: 10 },
        { author_model: 'm1', overwriter_model: 'm1', conflict_count: 10, is_self_thrash: true },
      ],
      total_collisions: 20,
    });
    expect(text).toContain('Cross-agent ratio: 50% of 20 collisions. Self-thrash: 50%.');
  });

  it('counts edges, not conflict weights, when the daemon sends a bare row array', async () => {
    const text = await promptText([
      { author_model: 'm1', overwriter_model: 'm2', conflict_count: 5 },
      { author_model: 'm2', overwriter_model: 'm2', conflict_count: 5 },
      { author_model: 'm3', overwriter_model: 'm1', conflict_count: 1 },
    ]);
    expect(text).toContain('Cross-agent ratio: 67% of 3 collisions. Self-thrash: 33%.');
  });
});
