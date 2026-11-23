import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { BrainDecision, BrainDecisionRequest } from '@wrongstack/contracts/types/brain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { BrainTraceRecorder } from '../../src/brain/brain-trace.js';

/**
 * F68 (WS-045 directory-hardening-on-creation class): BrainTraceRecorder
 * creates the trace directory via mkdir with no mode and no owner-only
 * hardening. Trace rows hold the question/context verbatim under the default
 * content policy. On Windows every trace file created inside inherits whatever
 * the parent grants. Hardening the directory when it is prepared (icacls
 * (OI)(CI) inheritance) covers the trace file and any future destination in
 * the same directory.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the trace directory; a real EventBus drives request → answer.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f68-'));
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

const request = (id: string): BrainDecisionRequest => ({
  id,
  source: 'system',
  question: 'Evaluate the proposed action.',
  risk: 'low',
  fallback: 'ask_human',
  options: [{ id: 'approve', label: 'Approve' }],
});
const answer: BrainDecision = { type: 'answer', text: 'ok' } as BrainDecision;

describe('brain trace directory-hardening-on-creation (F68)', () => {
  it('hardens the trace directory when it is prepared', async () => {
    const traceDir = path.join(dir, 'traces');
    const events = new EventBus();
    const trace = new BrainTraceRecorder({ events, filePath: path.join(traceDir, 'trace.jsonl') });
    trace.start();
    events.emit('brain.decision_requested', { request: request('r1'), sessionId: 's1', at: 1 });
    events.emit('brain.decision_answered', { request: request('r1'), decision: answer, at: 2 });
    await trace.stop();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'trace dir is hardened when prepared').toContain(traceDir);
  });
});
