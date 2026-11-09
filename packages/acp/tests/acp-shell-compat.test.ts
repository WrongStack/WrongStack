import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rewriteAgentMessage, runProxy } from '../../../scripts/acp-shell-compat.mjs';

describe('the opt-in ACP shell compatibility proxy', () => {
  it('turns a complete shell line into explicit argv before host permission checks', () => {
    const message = {
      jsonrpc: '2.0',
      id: 0,
      method: 'terminal/create',
      params: {
        sessionId: 's1',
        command: 'bun run verify.ts && echo done',
        cwd: '/fixture',
        env: [{ name: 'MODE', value: 'test' }],
        outputByteLimit: 4096,
      },
    };
    expect(rewriteAgentMessage(message, '/bin/bash', () => false)).toEqual({
      ...message,
      params: { ...message.params, command: '/bin/bash', args: ['-c', message.params.command] },
    });
    expect(message.params.command).toBe('bun run verify.ts && echo done');
  });

  it('preserves executable paths containing spaces and explicit argv', () => {
    const path = { method: 'terminal/create', params: { command: 'C:/Program Files/Bun/bun.exe' } };
    expect(rewriteAgentMessage(path, '/bin/bash', () => true)).toBe(path);
    const argv = {
      method: 'terminal/create',
      params: { command: 'bun', args: ['run', 'verify.ts'] },
    };
    expect(rewriteAgentMessage(argv, '/bin/bash', () => false)).toBe(argv);
  });

  it('leaves permission, cancellation, result and malformed frames untouched', () => {
    for (const message of [
      null,
      {},
      { id: 2, result: {} },
      { method: 'session/cancel', params: { sessionId: 's1' } },
      { method: 'session/request_permission', params: { command: 'bun --version' } },
      { method: 'terminal/create', params: { command: 42 } },
      { method: 'terminal/create', params: { command: 'bun' } },
    ])
      expect(rewriteAgentMessage(message, '/bin/bash', () => false)).toBe(message);
  });

  it('rejects an invalid invocation before starting an agent', async () => {
    await expect(runProxy([])).rejects.toThrow('Usage:');
  });

  it('forwards client input, rewrites agent requests and exits with its child', () => {
    const proxy = fileURLToPath(new URL('../../../scripts/acp-shell-compat.mjs', import.meta.url));
    const request = {
      jsonrpc: '2.0',
      id: 0,
      method: 'terminal/create',
      params: {
        sessionId: 's1',
        command: 'bun --version',
      },
    };
    const child = `console.log(${JSON.stringify(JSON.stringify(request))}); process.stdin.on('data', chunk => process.stdout.write(chunk));`;
    const cancel = { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } };
    const result = spawnSync(
      process.execPath,
      [proxy, '--shell', process.execPath, '--', process.execPath, '-e', child],
      {
        input: `${JSON.stringify(cancel)}\n`,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const frames = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(frames).toContainEqual(cancel);
    expect(frames).toContainEqual({
      ...request,
      params: {
        ...request.params,
        command: process.execPath,
        args: ['-c', 'bun --version'],
      },
    });
  });
});
