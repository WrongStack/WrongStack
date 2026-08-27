/**
 * YOLO belongs to a conversation, not to a process.
 *
 * One WebUI page holds four sessions on one runtime, and they share a single
 * `DefaultPermissionPolicy`. YOLO is a per-tab preference — it is stored on
 * each session's own context meta, the picker is per tab, and the browser
 * reads it per tab — but the runtime switch the policy actually consulted was
 * process-wide. Turning YOLO on in one tab therefore auto-approved the tools
 * of the other three, which is the loudest possible isolation break: the user
 * granted blanket approval to one conversation and it silently applied to
 * three they were not looking at.
 *
 * The decision cache had to move with it. Keyed by tool and subject alone, it
 * replayed a YOLO "auto" from one conversation onto the identical call in
 * another and would have made the fix decorative.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import type { Tool } from '../../src/types/index.js';

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'demo',
    description: 'demo',
    inputSchema: { type: 'object' },
    permission: 'confirm',
    mutating: false,
    subjectKey: 'path',
    async execute() {
      return 'ok';
    },
    ...overrides,
  } as Tool;
}

/** A conversation, as the policy sees one: an id and a meta bag. */
function conversation(id: string, meta: Record<string, unknown> = {}): Context {
  return { session: { id }, meta } as unknown as Context;
}

let trustFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-yolo-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
});

describe('YOLO is decided per conversation', () => {
  it('auto-approves only the tab that turned it on', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const input = { path: 'src/a.ts' };

    const yoloTab = await p.evaluate(tool(), input, conversation('tab-1', { yolo: true }));
    const otherTab = await p.evaluate(tool(), input, conversation('tab-2', { yolo: false }));

    expect(yoloTab.permission).toBe('auto');
    expect(yoloTab.source).toBe('yolo');
    // The tab beside it still asks.
    expect(otherTab.permission).toBe('confirm');
  });

  it('does not replay one conversation’s YOLO decision onto another from cache', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const input = { path: 'src/a.ts' };

    // Same tool, same subject — the old cache key in full.
    await p.evaluate(tool(), input, conversation('tab-1', { yolo: true }));
    const otherTab = await p.evaluate(tool(), input, conversation('tab-2', { yolo: false }));

    expect(otherTab.permission).toBe('confirm');
  });

  it('falls back to the process switch for a host that keeps no per-session value', async () => {
    // A CLI or TUI has one conversation, so its runtime flag IS the answer.
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });

    const decision = await p.evaluate(tool(), { path: 'src/a.ts' }, conversation('only-session'));

    expect(decision.permission).toBe('auto');
  });

  it('lets a session opt OUT of a process-wide YOLO', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });

    const decision = await p.evaluate(
      tool(),
      { path: 'src/a.ts' },
      conversation('careful-tab', { yolo: false }),
    );

    expect(decision.permission).toBe('confirm');
  });
});
