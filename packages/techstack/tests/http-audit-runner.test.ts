import { describe, expect, it, vi } from 'vitest';
import { createAuditRunner } from '../src/advisory/native-audit.js';
import { retryAfterMs } from '../src/registry/http-fetch.js';

describe('shared HTTP retry policy', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(retryAfterMs({ 'retry-after': '2' }, 0)).toBe(2_000);
    expect(retryAfterMs({ 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' }, 1_000)).toBe(2_000);
    expect(retryAfterMs({ 'retry-after': 'invalid' })).toBeUndefined();
  });
});

describe('createAuditRunner', () => {
  it('uses an injected command strategy for dispatch and availability', async () => {
    const command = vi
      .fn()
      .mockResolvedValue({ status: 0, stdout: '{"vulnerabilities":{}}', stderr: '' });
    const runner = createAuditRunner(command);
    await expect(runner.run('npm', '/workspace')).resolves.toMatchObject({ advisories: [] });
    await expect(runner.isAvailable('npm', '/workspace')).resolves.toBe(true);
    expect(command).toHaveBeenNthCalledWith(1, 'npm', ['audit', '--json'], '/workspace');
    expect(command).toHaveBeenNthCalledWith(2, 'npm', ['--version'], '/workspace');
  });

  it('does not invoke commands for unsupported ecosystems', async () => {
    const command = vi.fn();
    const runner = createAuditRunner(command);
    await expect(runner.isAvailable('swift')).resolves.toBe(false);
    expect(command).not.toHaveBeenCalled();
  });
});
