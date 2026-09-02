import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startProjectWatcher } from '../src/server/project-watcher.js';
import type { ConnectedClient } from '../src/server/types.js';
import type { WebSocket } from 'ws';

function createMockClients(): Map<WebSocket, ConnectedClient> {
  return new Map();
}

describe('project-watcher', () => {
  it('broadcasts files.tree.changed when a file is created in the project root', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-test-'));
    const broadcast = vi.fn();
    const clients = createMockClients();

    const dispose = startProjectWatcher({
      projectRoot: tmpDir,
      broadcast,
      clients,
    });

    // Write a new file — the watcher should detect it.
    fs.writeFileSync(path.join(tmpDir, 'new-file.ts'), 'test content');

    // The watcher debounces at 400ms — wait for the broadcast.
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(broadcast).toHaveBeenCalledWith(
      clients,
      expect.objectContaining({
        type: 'files.tree.changed',
        payload: {},
      }),
    );

    dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('broadcasts files.tree.changed when a file is deleted', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-del-'));
    const filePath = path.join(tmpDir, 'to-delete.ts');
    fs.writeFileSync(filePath, 'content');
    const broadcast = vi.fn();
    const clients = createMockClients();

    const dispose = startProjectWatcher({
      projectRoot: tmpDir,
      broadcast,
      clients,
    });

    // Wait for initial settle, then delete.
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.unlinkSync(filePath);

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(broadcast).toHaveBeenCalledWith(
      clients,
      expect.objectContaining({
        type: 'files.tree.changed',
      }),
    );

    dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not broadcast for changes inside node_modules', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-skip-'));
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    const broadcast = vi.fn();
    const clients = createMockClients();

    const dispose = startProjectWatcher({
      projectRoot: tmpDir,
      broadcast,
      clients,
    });

    // Write inside node_modules — should be ignored.
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.json'), '{}');

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(broadcast).not.toHaveBeenCalled();

    dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('coalesces rapid bursts into a single broadcast', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-burst-'));
    const broadcast = vi.fn();
    const clients = createMockClients();

    const dispose = startProjectWatcher({
      projectRoot: tmpDir,
      broadcast,
      clients,
    });

    // Fire 5 rapid writes.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `burst-${i}.ts`), 'x');
    }

    // Wait just past the debounce window.
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Should have fired exactly once (debounced).
    expect(broadcast).toHaveBeenCalledTimes(1);

    dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stops broadcasting after dispose', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-stop-'));
    const broadcast = vi.fn();
    const clients = createMockClients();

    const dispose = startProjectWatcher({
      projectRoot: tmpDir,
      broadcast,
      clients,
    });

    // Dispose immediately.
    dispose();

    // Write a file after disposal — no broadcast should fire.
    fs.writeFileSync(path.join(tmpDir, 'after-dispose.ts'), 'x');

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(broadcast).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
