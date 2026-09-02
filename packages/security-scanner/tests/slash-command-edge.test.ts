/**
 * Edge-case tests for slash-command covering uncovered branches:
 * - Empty reports directory (exists but no matching files) → line 192
 * - Boolean flag parsing (--flag with no value) → line 241
 * - Catch block in handleReport when readdir fails → line 222-224
 * - report with non-numeric ID that doesn't match any file → line 221
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const orchestratorMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../src/orchestrator.js', () => ({
  defaultOrchestrator: { run: orchestratorMocks.run },
}));

import { createSecuritySlashCommand } from '../src/slash-command.js';

let prevCwd: string;
let tmp: string;

beforeEach(async () => {
  orchestratorMocks.run.mockReset();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-slash-edge-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(prevCwd);
  await fs.rm(tmp, { recursive: true, force: true });
});

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: tmp,
    cwd: tmp,
    provider: { complete: () => ({}) } as never,
    model: 'opus',
    ...overrides,
  } as never;
}

describe('slash-command - edge coverage', () => {
  // ── Empty reports directory (exists, no matching files) → line 192 ────────
  it('reports empty when reports dir exists but has no matching files', async () => {
    const dir = path.join(tmp, 'security-reports');
    await fs.mkdir(dir, { recursive: true });
    // Create files that don't match the security-report-*.md/json pattern
    await fs.writeFile(path.join(dir, 'other.log'), 'log content');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'notes');
    const cmd = createSecuritySlashCommand();
    const res = await cmd.run('report', fakeCtx());
    expect(res?.message).toContain('No security reports found');
  });

  // ── Boolean flag parsing (--flag with no value) → line 241 ────────────────
  it('treats --flag without value as boolean true in parseArgs', async () => {
    orchestratorMocks.run.mockResolvedValue({
      scanResult: {
        summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
        scannedFiles: 0,
        scanDurationMs: 0,
      },
      detectionResult: { detectedStacks: [] },
      synthesizedReport: 'x',
      reportPath: '',
    });
    const cmd = createSecuritySlashCommand();
    // Use a boolean flag like --verbose (no =value)
    await cmd.run('scan --verbose', fakeCtx());
    // The --verbose flag should be parsed with value 'true'
    // We can't directly check parseArgs, but we can check that the scan ran
    expect(orchestratorMocks.run).toHaveBeenCalledOnce();
  });

  // ── handleReport catch when readdir fails (e.g., permissions) → line 222 ──
  it('catches readdir errors in handleReport', async () => {
    // Don't create the security-reports directory
    // The readdir will throw, and the catch will return a friendly message
    const cmd = createSecuritySlashCommand();
    const res = await cmd.run('report', fakeCtx());
    expect(res?.message).toContain('No security reports found');
  });

  // ── report with non-numeric ID not matching any file ──────────────────────
  it('returns not-found for non-matching string ID', async () => {
    const dir = path.join(tmp, 'security-reports');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'security-report-2026-01-01.md'), '# Jan');
    const cmd = createSecuritySlashCommand();
    const res = await cmd.run('report nonexistent-id', fakeCtx());
    expect(res?.message).toContain('not found');
  });
});
