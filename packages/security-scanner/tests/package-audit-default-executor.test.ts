import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => childProcess.execFile(...args),
}));

import { PackageAuditRunner } from '../src/package-audit.js';

let root: string;
let originalPlatform: NodeJS.Platform;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-executor-'));
  await fs.writeFile(path.join(root, 'package-lock.json'), '');
  originalPlatform = process.platform;
  childProcess.execFile.mockReset();
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  await fs.rm(root, { recursive: true, force: true });
});

function respond(error: (Error & { code?: string | number }) | null, stdout?: string): void {
  childProcess.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => callback(error, stdout, undefined),
  );
}

describe('default package audit executor', () => {
  it('runs the bare executable on POSIX and maps a successful exit', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    respond(null, JSON.stringify({ vulnerabilities: {} }));
    const result = await new PackageAuditRunner().run(root);
    expect(childProcess.execFile.mock.calls[0]?.[0]).toBe('npm');
    expect(result.exitCode).toBe(0);
  });

  it('uses the cmd shim on Windows and preserves numeric audit exit codes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const error = Object.assign(new Error('vulnerabilities found'), { code: 1 });
    respond(error, JSON.stringify({ vulnerabilities: {} }));
    const result = await new PackageAuditRunner().run(root);
    expect(childProcess.execFile.mock.calls[0]?.[0]).toBe('npm.cmd');
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(true);
  });

  it('maps non-numeric process failures to a null exit code', async () => {
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    respond(error);
    const result = await new PackageAuditRunner().run(root);
    expect(result.exitCode).toBeNull();
    expect(result.success).toBe(false);
  });
});
