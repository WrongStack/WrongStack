import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentMonitorService, createAgentMonitorService } from '../src/agent-monitor.js';
import { FleetBus } from '../src/fleet-bus.js';

/**
 * F47 (WS-045 class): AgentMonitorService._appendToFile writes subagent
 * transcripts (tool inputs/outputs, model text) via fs.appendFile +
 * SECRET_FILE_MODE (a Windows no-op) with no owner-only hardening. On Windows
 * the transcripts stayed readable by other local accounts where inheritance
 * was not owner-only. Each transcript file is hardened once (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the transcript path; real FleetBus events drive a segment close.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let monitor: AgentMonitorService;
let fleetBus: FleetBus;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-f47-'));
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
  fleetBus = new FleetBus();
  monitor = createAgentMonitorService({
    fleetBus,
    events: new EventBus(),
    transcriptsDir: dir,
    maxEntriesPerAgent: 50,
    streamEnabled: true,
  });
  monitor.start();
  monitor.trackSubagent('a1', 'Agent 1');
});

afterEach(async () => {
  monitor.stop();
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fsp.rm(dir, { recursive: true, force: true });
});

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms));
const transcriptPath = () => path.join(dir, 'a1', 'transcript.jsonl');
const countFor = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;
const fleet = (type: string, payload: Record<string, unknown>) => ({
  subagentId: 'a1',
  ts: Date.now(),
  type,
  payload,
});

describe('agent monitor transcript owner-only hardening (F47)', () => {
  it('hardens the transcript when a segment closes', async () => {
    fleetBus.emit(fleet('provider.text_delta', { text: 'Hello world', iteration: 0 }));
    fleetBus.emit(fleet('tool.started', { name: 'read', iteration: 0 }));
    await waitFor(150);
    expect(
      countFor(transcriptPath()),
      'segment close issues icacls for the transcript',
    ).toBeGreaterThan(0);
  });

  it('hardens ONCE across multiple segments', async () => {
    fleetBus.emit(fleet('provider.text_delta', { text: 'first', iteration: 0 }));
    fleetBus.emit(fleet('tool.started', { name: 'read', iteration: 0 }));
    fleetBus.emit(fleet('provider.text_delta', { text: 'second', iteration: 1 }));
    fleetBus.emit(fleet('tool.started', { name: 'glob', iteration: 1 }));
    await waitFor(200);
    expect(countFor(transcriptPath())).toBe(1);
  });
});
