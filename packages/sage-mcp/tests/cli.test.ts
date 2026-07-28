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
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
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
});
