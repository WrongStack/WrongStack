import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs, resolveIndexProjectRoot } from '../src/cli.js';

describe('Codebase Index MCP CLI — flag values', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not resolve a value-less --project-root to the cwd', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseArgs(['--project-root'], {}).projectRoot).toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('does not swallow the next flag as a value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(['--project-root', '--writable'], {});
    expect(parsed.projectRoot).toBe('');
    expect(parsed.writable).toBe(true);
  });

  it('does not swallow the short help flag as a value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(['--project-root', '-h'], {});
    expect(parsed.projectRoot).toBe('');
    expect(parsed.help).toBe(true);
  });

  it('accepts --flag=value and never echoes an inline token as an unknown option', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(
      ['--project-root=/p', '--http', '--token=s3cret', '--index-dir=/idx', '--port=9000'],
      {},
    );
    expect(parsed.projectRoot).toBe(path.resolve('/p'));
    expect(parsed.indexDir).toBe(path.resolve('/idx'));
    expect(parsed.httpToken).toBe('s3cret');
    expect(parsed.httpPort).toBe(9000);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('s3cret');
    expect(parseArgs(['--token='], {}).tokenMissing).toBe(true);
  });

  it('rejects an out-of-range port and warns on unknown options', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(['--project-root', '.', '--port', '70000', '--writeable'], {});
    expect(parsed.httpPort).toBe(0);
    expect(parsed.writable).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /not a valid port[\s\S]*unknown option --writeable/,
    );
  });

  it('keeps a linked Git worktree as a distinct physical index root', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codebase-index-mcp-worktree-'));
    const main = path.join(tmp, 'main-repo');
    const linked = path.join(tmp, 'task-checkout');
    const linkedGitDir = path.join(main, '.git', 'worktrees', 'task-checkout');
    try {
      await fs.mkdir(linkedGitDir, { recursive: true });
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
      await fs.writeFile(path.join(linkedGitDir, 'commondir'), '../..\n');
      await fs.writeFile(path.join(linkedGitDir, 'gitdir'), `${path.join(linked, '.git')}\n`);

      expect(resolveIndexProjectRoot(linked)).toBe(path.resolve(linked));
      expect(resolveIndexProjectRoot(linked)).not.toBe(path.resolve(main));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects blank or whitespace-only flag values instead of resolving to cwd or port 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(
      [
        '--project-root',
        '   ',
        '--index-dir',
        '',
        '--port',
        '8080',
        '--port',
        '   ',
        '--token',
        '   ',
      ],
      { WRONGSTACK_MCP_TOKEN: 'env-token' },
    );
    expect(parsed.projectRoot).toBe('');
    expect(parsed.indexDir).toBeUndefined();
    expect(parsed.httpPort).toBe(8080);
    expect(parsed.httpToken).toBe('env-token');
    expect(parsed.tokenMissing).toBe(false);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('does not swallow a following known flag when --token has no value (F652)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(['--http', '--token', '--writable'], {});
    expect(parsed.httpToken).toBeUndefined();
    expect(parsed.tokenMissing).toBe(true);
    expect(parsed.writable).toBe(true);
  });
});
