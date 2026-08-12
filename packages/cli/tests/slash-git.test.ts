import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGit } from '../src/services/run-git.js';
import {
  buildCommitCommand,
  buildGitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from '../src/slash-commands/git.js';

describe('/git family', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-cmd-'));
    await runGit(['init'], tmpDir);
    await runGit(['config', 'user.email', 'test@example.com'], tmpDir);
    await runGit(['config', 'user.name', 'Test'], tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns help for unknown subcommand', async () => {
    const cmd = buildGitCommand({ cwd: tmpDir } as never);
    const res = await cmd.run('unknown');
    expect((res as { message?: string })?.message).toContain('Unknown subcommand');
  });

  it('shows branch and head as JSON', async () => {
    const cmd = buildGitCommand({ cwd: tmpDir } as never);
    const res = await cmd.run('branch --json');
    const payload = JSON.parse((res as { message?: string })?.message ?? '{}');
    expect(typeof payload.branch).toBe('string');
    expect(payload.head === null || typeof payload.head === 'string').toBe(true);
    expect((res as { metadata?: Record<string, unknown> })?.metadata?.['git']).toEqual(payload);
  });

  it('renders an overview in status mode', async () => {
    const cmd = buildGitCommand({ cwd: tmpDir } as never);
    const res = await cmd.run('status');
    expect((res as { message?: string })?.message).toContain('Git overview');
    expect((res as { message?: string })?.message).toContain('Branch:');
  });

  it('gitcheck returns empty in a clean repo', async () => {
    const cmd = buildGitcheckCommand({ cwd: tmpDir } as never);
    const res = await cmd.run('');
    expect((res as { message?: string })?.message).toBe('');
  });

  it('commit refuses when working tree is clean', async () => {
    const cmd = buildCommitCommand({ cwd: tmpDir, projectRoot: tmpDir } as never);
    const res = await cmd.run('');
    expect((res as { message?: string })?.message).toContain('Nothing to commit');
  });

  it('push reports no remote configured', async () => {
    const cmd = buildPushCommand({ cwd: tmpDir } as never);
    const res = await cmd.run('--dry-run');
    expect((res as { message?: string })?.message).toContain('No remote configured');
  });
});
