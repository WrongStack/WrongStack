import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { WstackPaths } from '@wrongstack/core/utils';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupProviderStatus } from '../src/wiring/provider-status.js';

/**
 * F51 (WS-045 class): setupProviderStatus.appendAuditLine appends the CLI
 * provider waiting-room audit trail — error messages, session/agent ids — via
 * fs.appendFile + mode 0o600 (a Windows no-op) with no owner-only hardening
 * (the status document uses atomicWrite, which hardens, but the audit append
 * did not). On Windows the audit log stayed readable by other local accounts
 * where inheritance was not owner-only. The audit file is hardened once
 * (best-effort) and re-hardened after rotation.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the audit path; a real EventBus emits provider.status_changed.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let events: EventBus;
let teardownHandlers: Array<() => void>;
let auditFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f51-'));
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
  events = new EventBus();
  teardownHandlers = [];
  auditFile = path.join(dir, 'provider-status-audit.jsonl');
  const paths = {
    profileName: 'default',
    profileProviderStatus: () => path.join(dir, 'provider-status.json'),
    profileProviderAudit: () => auditFile,
  } as unknown as WstackPaths;
  await setupProviderStatus({
    events,
    paths,
    fallbackProfileManager: { setStatusTracker: () => {} } as never,
    logger: { info: () => {}, warn: () => {} },
    teardownHandlers,
  });
});

afterEach(async () => {
  for (const teardown of teardownHandlers) teardown();
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const countFor = (t: string) =>
  icaclsCalls.filter((c) => c.file === 'icacls' && c.args[0] === t).length;
const changed = (reason: string) => ({
  providerId: 'openai',
  model: 'gpt-5',
  oldState: 'healthy',
  newState: 'blocked',
  reason,
  timestamp: Date.now(),
  lastErrorKind: 'http',
  lastErrorStatus: 429,
  lastErrorMessage: 'quota exceeded',
  lastSessionId: 's1',
  lastAgentId: 'a1',
});

async function waitForAuditLines(lines: number): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const raw = await fs.readFile(auditFile, 'utf8').catch(() => '');
    if (raw.trim().split('\n').filter(Boolean).length >= lines && countFor(auditFile) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('CLI provider-status audit owner-only hardening (F51)', () => {
  it('hardens the audit log on a status transition', async () => {
    events.emit('provider.status_changed', changed('rate_limit') as never);
    await waitForAuditLines(1);
    expect(countFor(auditFile), 'transition issues icacls for the audit log').toBeGreaterThan(0);
  });

  it('hardens ONCE across multiple transitions', async () => {
    events.emit('provider.status_changed', changed('rate_limit') as never);
    events.emit('provider.status_changed', changed('manual_clear') as never);
    await waitForAuditLines(2);
    expect(countFor(auditFile)).toBe(1);
  });
});
