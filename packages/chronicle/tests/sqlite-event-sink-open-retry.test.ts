import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChronicleEventJournal } from '../src/project-access.js';

const event = {
  eventType: 'tool.started',
  scope: { installationId: 'i', machineId: 'm' },
  correlation: { traceId: 't', spanId: 's' },
} as const;

describe('ChronicleSqliteEventSink lazy open, retry, and dispose', () => {
  let root: string;

  beforeEach(async () => {
    vi.stubEnv('WRONGSTACK_CHRONICLE_INLINE', '1');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-sink-retry-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not reject unhandled when idle on a blocked directory and resolves dispose()', async () => {
    const projectDir = path.join(root, 'idle-blocked');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'chronicle'), 'blocker');

    const handle = createChronicleEventJournal({
      projectRoot: path.join(root, 'project'),
      projectPaths: { globalRoot: root, projectId: 'proj', projectDir, workspaceId: 'ws' },
    });

    await expect(handle.journal.flush()).resolves.toBeUndefined();
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it('retries opening after a transient mkdir failure and resolves dispose() after failed open', async () => {
    const projectDir = path.join(root, 'retry-blocked');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'chronicle'), 'blocker');

    const handle = createChronicleEventJournal({
      projectRoot: path.join(root, 'project'),
      projectPaths: { globalRoot: root, projectId: 'proj', projectDir, workspaceId: 'ws' },
    });

    await expect(handle.journal.append(event as never)).rejects.toThrow(/EEXIST|mkdir/);
    await fs.rm(path.join(projectDir, 'chronicle'), { force: true });

    const appended = await handle.journal.append(event as never);
    expect(appended.sequence).toBe(1);
    await expect(handle.dispose()).resolves.toBeUndefined();
  });
});
