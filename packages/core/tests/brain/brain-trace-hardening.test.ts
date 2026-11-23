import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { BrainDecision, BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainTraceRecorder } from '../../src/brain/brain-trace.js';

/**
 * F40 (WS-045 class): BrainTraceRecorder appends trace rows — under the default
 * `content: 'full'` the question and context verbatim (its own WS-035 comment)
 * — via appendFile + SECRET_FILE_MODE (a Windows no-op) with no owner-only
 * hardening. On Windows the trace file stayed readable by other local accounts
 * where inheritance was not owner-only. Each destination is hardened once per
 * recorder; reconfigure to a new filePath hardens the new destination.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the trace path; a real EventBus drives request → answer.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f40-'));
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const countFor = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;

const request = (id: string): BrainDecisionRequest => ({
  id,
  source: 'system',
  question: 'Evaluate the proposed action.',
  risk: 'low',
  fallback: 'ask_human',
  options: [{ id: 'approve', label: 'Approve' }],
});
const answer: BrainDecision = { type: 'answer', text: 'ok' } as BrainDecision;

async function decide(events: EventBus, id: string): Promise<void> {
  events.emit('brain.decision_requested', { request: request(id), sessionId: 's1', at: 1 });
  events.emit('brain.decision_answered', { request: request(id), decision: answer, at: 2 });
}

describe('brain trace owner-only hardening (F40)', () => {
  it('hardens the trace file when a decision resolves', async () => {
    const filePath = path.join(dir, 'trace.jsonl');
    const events = new EventBus();
    const trace = new BrainTraceRecorder({ events, filePath });
    trace.start();
    await decide(events, 'r1');
    await trace.stop();
    expect(hardened(filePath), 'resolved decision issues icacls for the trace file').toBe(true);
  });

  it('hardens ONCE across multiple decisions', async () => {
    const filePath = path.join(dir, 'trace.jsonl');
    const events = new EventBus();
    const trace = new BrainTraceRecorder({ events, filePath });
    trace.start();
    await decide(events, 'r1');
    await decide(events, 'r2');
    await trace.stop();
    expect(countFor(filePath)).toBe(1);
  });

  it('hardens the NEW destination after reconfigure', async () => {
    const first = path.join(dir, 'first.jsonl');
    const second = path.join(dir, 'second.jsonl');
    const events = new EventBus();
    const trace = new BrainTraceRecorder({ events, filePath: first });
    trace.start();
    await decide(events, 'r1');
    trace.reconfigure({ filePath: second });
    await decide(events, 'r2');
    await trace.stop();
    expect(hardened(first)).toBe(true);
    expect(hardened(second), 'reconfigured destination is hardened too').toBe(true);
  });
});
