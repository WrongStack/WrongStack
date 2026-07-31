import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KANBAN_SERVER_METHODS } from '../../src/server/protocol.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Kanban IPC ownership boundary', () => {
  it('keeps SQLite construction inside the elected project server storage', () => {
    const productionFiles = walk(path.join(repoRoot, 'packages')).filter(
      (file) =>
        /\.(?:ts|tsx)$/.test(file) &&
        !file.includes(`${path.sep}tests${path.sep}`) &&
        !file.endsWith(`${path.sep}server${path.sep}sqlite-storage.ts`),
    );
    const offenders = productionFiles
      .filter((file) => /\bnew\s+DatabaseSync\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it('makes production storage fail closed to IPC', () => {
    const storage = read('packages/kanban/src/storage.ts');
    const facade = read('packages/kanban/src/server/kanban-store.ts');
    const server = read('packages/kanban/src/server/project-server.ts');

    expect(storage).toContain('getProductionKanbanStorage(projectRoot)');
    expect(storage).toContain("process.env['NODE_ENV'] === 'test'");
    expect(storage).toContain("process.env['VITEST'] === 'true'");
    expect(facade).toContain('clients require the project IPC owner');
    expect(facade).not.toContain("from '../manager.js'");
    expect(facade).not.toContain("from '../storage.js'");
    expect(server).toContain('SqliteKanbanStorage.open(projectRoot,');
    expect(server).toContain('installKanbanStorageBackend(projectRoot, sqliteStorage)');
    const sqliteStorage = read('packages/kanban/src/server/sqlite-storage.ts');
    expect(sqliteStorage).toContain('await removeLegacyFiles(dir, legacyFiles)');
    expect(sqliteStorage.indexOf("this.db.exec('COMMIT')")).toBeLessThan(
      sqliteStorage.lastIndexOf('await removeLegacyFiles(dir, legacyFiles)'),
    );
  });

  it('routes stateful package exports through the daemon domain allowlist', () => {
    const index = read('packages/kanban/src/index.ts');
    const clientDomain = read('packages/kanban/src/client-domain.ts');
    const projectServer = read('packages/kanban/src/server/project-server.ts');

    expect(index).toContain("from './client-domain.js'");
    expect(index).not.toContain('KANBAN_SQLITE_FILE');
    expect(clientDomain).toContain("connection.request('domainCall'");
    expect(clientDomain).toContain('stateful clients require IPC');
    expect(projectServer).toContain("'domainCall'");
    expect(projectServer).toContain('KANBAN_DOMAIN_OPERATIONS');
    expect(projectServer).toContain('protocolMethods.has(req.method)');
    expect([...KANBAN_SERVER_METHODS]).toEqual([
      'ping',
      'shutdown',
      'domainCall',
      'storageListBoardIds',
      'storageReadBoard',
      'storageWriteBoard',
      'storageAppendEvent',
      'storageReadEvents',
      'storageDeleteBoard',
      'storageReadMetadata',
      'storageWriteMetadata',
      'workflowEnqueueCommand',
      'workflowDrainCommands',
      'workflowReadState',
      'workflowWriteState',
      'workflowListStates',
      'workflowDeleteState',
    ]);
  });

  it('keeps raw Kanban paths and SQLite ownership out of other packages', () => {
    const productionFiles = walk(path.join(repoRoot, 'packages')).filter(
      (file) =>
        /\.(?:ts|tsx)$/.test(file) &&
        !file.includes(`${path.sep}tests${path.sep}`) &&
        !file.includes(`${path.sep}packages${path.sep}kanban${path.sep}src${path.sep}`),
    );
    const forbidden =
      /(?:@wrongstack\/kanban\/test-support|getKanbanDir|getKanbanPath|getKanbanEventsPath|SqliteKanbanStorage|_kanban\.sqlite|\.wrongstack[\\/]+kanbans)/;
    const offenders = productionFiles
      .filter((file) => forbidden.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });

  it('uses daemon events instead of production filesystem watchers', () => {
    const hqSync = read('packages/cli/src/kanban-hq-sync.ts');
    const watcher = read('packages/webui-server/src/server/kanban-board-watcher.ts');
    expect(hqSync).not.toMatch(/from ['"]node:fs/);
    expect(hqSync).toContain('bridgeKanbanSupervisor');
    expect(watcher).not.toMatch(/from ['"]node:fs/);
    expect(watcher).toContain('subscribeKanbanDaemonEvents');
  });
});

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}
