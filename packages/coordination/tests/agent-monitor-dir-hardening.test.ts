import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { createAgentMonitorService, type AgentMonitorService } from '../src/agent-monitor.js';
import { FleetBus } from '../src/fleet-bus.js';

/**
 * F64 (WS-045 directory-hardening-on-creation class): AgentMonitorService
 * creates each subagent transcript directory via fs.mkdir with no mode and no
 * owner-only hardening. On Windows every file created inside inherits whatever
 * the transcripts root grants. Hardening the directory AT CREATION (icacls
 * (OI)(CI) inheritance) makes the transcript — and anything else created there
 * by a path we do not control — land owner-only.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the subagent directory; real FleetBus events drive the write.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let monitor: AgentMonitorService;
let fleetBus: FleetBus;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ws-f64-'));
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
const fleet = (type: string, payload: Record<string, unknown>) => ({
  subagentId: 'a1',
  ts: Date.now(),
  type,
  payload,
});

describe('agent monitor directory-hardening-on-creation (F64)', () => {
  it('hardens the subagent directory when it is created', async () => {
    fleetBus.emit(fleet('provider.text_delta', { text: 'Hello', iteration: 0 }));
    fleetBus.emit(fleet('tool.started', { name: 'read', iteration: 0 }));
    await waitFor(600);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'subagent dir is hardened').toContain(path.join(dir, 'a1'));
  });
});
