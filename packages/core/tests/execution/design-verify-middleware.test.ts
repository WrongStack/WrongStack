import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeDesignVerifyToolCallMiddleware,
  setActiveKit,
} from '../../src/execution/design-detect.js';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-vmw-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function payloadFor(relPath: string, ctx: unknown) {
  return {
    toolUse: { type: 'tool_use', id: 't1', name: 'write', input: { path: relPath } },
    result: { type: 'tool_result', tool_use_id: 't1', content: 'wrote file', is_error: false },
    ctx,
  } as any;
}

describe('makeDesignVerifyToolCallMiddleware', () => {
  it('appends an off-palette warning after a frontend write when a kit is pinned', async () => {
    const mw = makeDesignVerifyToolCallMiddleware();
    const ctx = { projectRoot: root, meta: {} } as any;
    setActiveKit(ctx, 'minimal-clarity', 'web');
    await fs.writeFile(path.join(root, 'bad.css'), '.x { color: #123456; background: #abcdef; }');
    const out = await mw.handler(payloadFor('bad.css', ctx), async (p) => p);
    expect(out.result.content).toMatch(/Design Studio/);
    expect(out.result.content).toMatch(/off-palette/);
    expect(out.result.content).toContain('#123456');
  });

  it('stays silent with no pinned kit', async () => {
    const mw = makeDesignVerifyToolCallMiddleware();
    const ctx = { projectRoot: root, meta: {} } as any; // no activeKit
    await fs.writeFile(path.join(root, 'bad2.css'), '.x { color: #123456; }');
    const out = await mw.handler(payloadFor('bad2.css', ctx), async (p) => p);
    expect(out.result.content).toBe('wrote file');
  });

  it('stays silent for a non-frontend file', async () => {
    const mw = makeDesignVerifyToolCallMiddleware();
    const ctx = { projectRoot: root, meta: {} } as any;
    setActiveKit(ctx, 'minimal-clarity', 'web');
    await fs.writeFile(path.join(root, 'notes.txt'), 'color: #123456');
    const out = await mw.handler(payloadFor('notes.txt', ctx), async (p) => p);
    expect(out.result.content).toBe('wrote file');
  });

  it('stays silent when the write errored', async () => {
    const mw = makeDesignVerifyToolCallMiddleware();
    const ctx = { projectRoot: root, meta: {} } as any;
    setActiveKit(ctx, 'minimal-clarity', 'web');
    const p = payloadFor('bad.css', ctx);
    p.result.is_error = true;
    const out = await mw.handler(p, async (x) => x);
    expect(out.result.content).toBe('wrote file');
  });
});
