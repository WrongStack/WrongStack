import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.resetModules();
});

describe('project server entrypoint argument guards', () => {
  it('rejects a Chronicle server launch without project identity arguments', async () => {
    process.argv = [process.execPath, 'chronicle-project-server'];
    await expect(import('../src/chronicle/project-server.js')).rejects.toThrow(
      'Chronicle project server requires --project-root',
    );
  });

  it('rejects a mailbox server launch without its project directory', async () => {
    process.argv = [process.execPath, 'mailbox-project-server'];
    await expect(import('../src/coordination/mailbox-project-server.js')).rejects.toThrow(
      'mailbox project server requires --project-dir',
    );
  });

  it('rejects a SAGE server launch without its project root', async () => {
    process.argv = [process.execPath, 'sage-project-server'];
    await expect(import('../../sage/src/project-server.js')).rejects.toThrow(
      'SAGE project server requires --project-root',
    );
  });

  it('rejects a codebase-index server launch without its project root', async () => {
    process.argv = [process.execPath, 'codebase-index-project-server'];
    await expect(import('../../tools/src/codebase-index/project-server.js')).rejects.toThrow(
      'codebase-index project server requires --project-root',
    );
  });

  it('rejects a Session Catalog launch without its project identity', async () => {
    process.argv = [process.execPath, 'session-catalog-project-server'];
    await expect(import('../src/session-catalog/project-server.js')).rejects.toThrow(
      'Session Catalog project server requires --project-dir',
    );
  });
});
