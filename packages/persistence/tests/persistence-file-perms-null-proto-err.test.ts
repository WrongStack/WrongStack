import { describe, expect, it } from 'vitest';
import { _filePermOps, restrictFilePermissions } from '../src/file-permissions.js';

describe('restrictFilePermissions null-prototype error handling', () => {
  it('warns without throwing when chmod rejects with a null-prototype object', async () => {
    const origPlatform = _filePermOps.platform;
    const origChmod = _filePermOps.chmod;
    const origStat = _filePermOps.stat;
    let warned = '';
    try {
      _filePermOps.platform = 'linux';
      _filePermOps.chmod = async () => {
        throw Object.create(null);
      };
      _filePermOps.stat = async () => ({});
      await restrictFilePermissions('/tmp/secret.key', {
        warn: (m) => {
          warned = m;
        },
      });
    } finally {
      _filePermOps.platform = origPlatform;
      _filePermOps.chmod = origChmod;
      _filePermOps.stat = origStat;
    }
    expect(warned).toContain('unknown error');
  });
});
