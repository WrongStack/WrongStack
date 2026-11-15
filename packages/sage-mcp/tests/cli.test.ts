/**
 * CLI argv-parser tests.
 *
 * We test `parseArgs` (pure function) directly. We do NOT spawn the
 * binary here: the IPC attach path is environment-dependent on
 * Windows and is exercised by `adapter.test.ts` via real
 * `MCPServer.handleMessage` — that is a stronger end-to-end contract
 * than a child-process round-trip. Spawning the binary to verify
 * argv parsing is a duplicated cover; the manual smoke test is the
 * right place for that end-to-end check.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, projectRelativeStorageDirectory } from '../src/cli.js';

describe('parseArgs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('defaults to stdio transport and 127.0.0.1:0', () => {
    const args = parseArgs([]);
    expect(args.transport).toBe('stdio');
    expect(args.httpHost).toBe('127.0.0.1');
    expect(args.httpPort).toBe(0);
    expect(args.writable).toBe(false);
    expect(args.help).toBe(false);
    expect(args.projectRoot).toBe('');
    expect(args.httpToken).toBeUndefined();
    expect(args.storageDirectory).toBeUndefined();
  });

  it('keeps a token that starts with a dash and never echoes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = '-Qx7_secretTok3n';
    expect(
      parseArgs(['--project-root', '.', '--http', '--token', token, '--writable'], {}),
    ).toMatchObject({ httpToken: token, writable: true });
    expect(warn.mock.calls.flat().join(' ')).not.toContain(token);
    warn.mockRestore();
  });

  it('--project-root <path> resolves to an absolute path', () => {
    const args = parseArgs(['--project-root', 'foo/bar']);
    expect(args.projectRoot).toBe(path.resolve('foo/bar'));
  });

  it('--storage-dir <path> overrides storage directory', () => {
    const args = parseArgs(['--storage-dir', '/tmp/sage']);
    expect(args.storageDirectory).toBe(path.resolve('/tmp/sage'));
  });

  it('--http and --port flip transport and port', () => {
    const args = parseArgs(['--http', '--port', '8765', '--host', '0.0.0.0']);
    expect(args.transport).toBe('http');
    expect(args.httpPort).toBe(8765);
    expect(args.httpHost).toBe('0.0.0.0');
  });

  it('--token captures the bearer token value', () => {
    const args = parseArgs(['--token', 'secret']);
    expect(args.httpToken).toBe('secret');
  });

  it('--writable flips the writable flag', () => {
    const args = parseArgs(['--writable']);
    expect(args.writable).toBe(true);
  });

  it('--help and -h both set the help flag', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('ignores unknown flags (forward-compat)', () => {
    const args = parseArgs(['--unknown-flag', '--project-root', '/p', '--also-unknown']);
    expect(args.projectRoot).toBe(path.resolve('/p'));
  });

  it('combined flags match the documented CLI shape', () => {
    const args = parseArgs([
      '--project-root',
      '/proj',
      '--storage-dir',
      '/store',
      '--http',
      '--port',
      '9000',
      '--host',
      '127.0.0.1',
      '--token',
      'tok',
      '--writable',
    ]);
    expect(args).toMatchObject({
      projectRoot: path.resolve('/proj'),
      storageDirectory: path.resolve('/store'),
      transport: 'http',
      httpPort: 9000,
      httpHost: '127.0.0.1',
      httpToken: 'tok',
      writable: true,
      help: false,
    });
  });

  it('does not consume a following writable flag as a missing value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseArgs(['--project-root', '--writable'], {})).toMatchObject({
      projectRoot: '',
      writable: true,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('accepts only integer HTTP ports in range', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseArgs(['--port', '99999'], {}).httpPort).toBe(0);
    expect(parseArgs(['--port', '12.5'], {}).httpPort).toBe(0);
    expect(parseArgs(['--port', '65535'], {}).httpPort).toBe(65_535);
    expect(parseArgs(['--port', '8080', '--port', '0'], {}).httpPort).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('falls back to WRONGSTACK_MCP_TOKEN, guards storage-dir traversal, and requires --project-root in main()', async () => {
    expect(parseArgs([], { WRONGSTACK_MCP_TOKEN: '  env-tok-123  ' }).httpToken).toBe(
      'env-tok-123',
    );
    expect(projectRelativeStorageDirectory('/repo/proj', '/repo/proj/.sage')).toBe('.sage');
    expect(() => projectRelativeStorageDirectory('/repo/proj', '/repo/other')).toThrow(
      '--storage-dir must stay inside the project root',
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(main([])).resolves.toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('ignores whitespace-only flag values and preserves env token fallback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseArgs(
      [
        '--project-root',
        '   ',
        '--storage-dir',
        '   ',
        '--host',
        '   ',
        '--token',
        '   ',
        '--port',
        '   ',
      ],
      { WRONGSTACK_MCP_TOKEN: 'env-token' },
    );
    expect(parsed).toMatchObject({
      projectRoot: '',
      httpHost: '127.0.0.1',
      httpToken: 'env-token',
    });
    expect(parsed.storageDirectory).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it('rejects nested non-existent paths under an escaping symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-sage-sym-'));
    try {
      const projectRoot = path.join(root, 'proj');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(projectRoot);
      fs.mkdirSync(outside);
      fs.symlinkSync(
        outside,
        path.join(projectRoot, 'sym'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(() =>
        projectRelativeStorageDirectory(
          projectRoot,
          path.join(projectRoot, 'sym', 'newsub', 'deep'),
        ),
      ).toThrow(/project root/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
