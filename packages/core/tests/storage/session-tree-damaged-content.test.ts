import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionDataFromFile } from '../../src/storage/session-store/load-session-data.js';
import { reconstructSessionTree } from '../../src/storage/session-store/tree-replay.js';

const passthroughScrubber: SecretScrubber = { scrub: (text) => text, scrubObject: (obj) => obj };
const ts = (minute: number) => `2026-11-25T00:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * F2243: once `branch_created` appears, replay switches to
 * `applyEventToBranchState`. Its `user_input` / `llm_response` branches copied
 * journal content into the branch message array unvalidated, so one damaged
 * line either rejected the whole load (repair pass) or leaked into the
 * reconstructed tree. Damaged events are skipped and reported instead.
 */
function branchedJournal(damaged: unknown | undefined): unknown[] {
  return [
    { type: 'session_start', ts: ts(0), model: 'm', provider: 'p' },
    {
      type: 'branch_created',
      ts: ts(1),
      newBranchId: 'b1',
      name: 'b1',
      parentBranchId: 'main',
      forkSeq: 0,
    },
    {
      type: 'branch_switched',
      ts: ts(2),
      fromBranchId: 'main',
      toBranchId: 'b1',
      workspaceRestored: false,
    },
    { type: 'user_input', ts: ts(3), content: 'hello', branchId: 'b1' },
    ...(damaged === undefined ? [] : [damaged]),
    { type: 'user_input', ts: ts(5), content: 'after', branchId: 'b1' },
  ];
}

describe('branched replay skips damaged content (F2243)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-damaged-content-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function load(name: string, events: unknown[]) {
    const file = path.join(dir, `${name}.jsonl`);
    await fsp.writeFile(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const damaged: string[] = [];
    const data = await loadSessionDataFromFile({
      id: name,
      file,
      full: true,
      secretScrubber: passthroughScrubber,
      events: {
        emit: (type: string, payload: unknown) => {
          if (type === 'session.damaged') damaged.push(JSON.stringify(payload));
        },
      } as never,
    });
    return { data, damaged };
  }

  it.each([
    ['user_input', { type: 'user_input', ts: ts(4), content: [null], branchId: 'b1' }],
    [
      'llm_response',
      {
        type: 'llm_response',
        ts: ts(4),
        content: [null],
        usage: { input: 1, output: 1 },
        stopReason: 'end',
        model: 'm',
        provider: 'p',
        branchId: 'b1',
      },
    ],
  ])('skips a damaged %s on an active branch', async (_label, damagedEvent) => {
    const { data, damaged } = await load(String(_label), branchedJournal(damagedEvent));

    expect(data.messages.map((message) => message.content)).toEqual(['hello', 'after']);
    expect(damaged).toHaveLength(1);
  });

  it('keeps the malformed message out of the reconstructed tree', () => {
    const { messages } = reconstructSessionTree(
      branchedJournal({ type: 'user_input', ts: ts(4), content: [null], branchId: 'b1' }) as never,
      { sessionId: 'branched' },
    );

    expect(messages.map((message) => message.content)).toEqual(['hello', 'after']);
  });

  it('still replays a clean branched journal', async () => {
    const { data, damaged } = await load('clean', branchedJournal(undefined));

    expect(data.messages.map((message) => message.content)).toEqual(['hello', 'after']);
    expect(damaged).toHaveLength(0);
  });
});
