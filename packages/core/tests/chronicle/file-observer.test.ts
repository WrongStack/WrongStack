import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  createChronicleContext,
  startChronicleFileObserver,
} from '../../src/chronicle/index.js';
import { EventBus } from '../../src/kernel/events.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitForEvent(journal: ChronicleJournal, predicate: (type: string) => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = (await journal.readAll()).find((event) => predicate(event.eventType));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out waiting for Chronicle filesystem event');
}

describe('startChronicleFileObserver', () => {
  it('records external edits and deletes with previous content identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-'));
    tempDirs.push(root);
    await mkdir(path.join(root, 'src'));
    const file = path.join(root, 'src', 'value.ts');
    await writeFile(file, 'export const value = 1;\n');
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      debounceMs: 25,
    });

    await writeFile(file, 'export const value = 2;\n');
    const modified = await waitForEvent(journal, (type) => type === 'file.external.modified');
    expect(modified.resource).toMatchObject({ kind: 'file', path: 'src/value.ts' });
    expect(modified.attributes).toMatchObject({
      actor: 'external',
      operation: 'edit',
      source: 'external',
    });
    expect(modified.attributes?.['previousHash']).toMatch(/^[a-f0-9]{64}$/);

    await unlink(file);
    const deleted = await waitForEvent(journal, (type) => type === 'file.external.deleted');
    expect(deleted.attributes).toMatchObject({ actor: 'external', operation: 'delete' });
    await observer.close();
  });

  it('correlates watcher mutations with a recent tool call and detects rename lineage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-tool-'));
    tempDirs.push(root);
    const original = path.join(root, 'old.ts');
    const renamed = path.join(root, 'new.ts');
    await writeFile(original, 'same content\n');
    const journal = new ChronicleJournal({
      filePath: path.join(root, '.wrongstack', 'chronicle.jsonl'),
    });
    const events = new EventBus();
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      events,
      debounceMs: 40,
    });

    events.emit('tool.progress', {
      sessionId: 'session',
      agentId: 'leader',
      name: 'edit',
      id: 'tool-42',
      event: { type: 'file_changed', path: 'old.ts', operation: 'edit' },
    });
    await writeFile(original, 'changed by tool\n');
    const toolMutation = await waitForEvent(journal, (type) => type === 'file.tool.modified');
    expect(toolMutation.correlation.toolCallId).toBe('tool-42');
    expect(toolMutation.scope).toMatchObject({ sessionId: 'session', agentId: 'leader' });
    expect(toolMutation.attributes).toMatchObject({
      actor: 'agent',
      source: 'tool',
      toolName: 'edit',
    });

    await rename(original, renamed);
    const renameEvent = await waitForEvent(journal, (type) => type === 'file.external.renamed');
    expect(renameEvent.resource?.path).toBe('new.ts');
    expect(renameEvent.attributes).toMatchObject({ previousPath: 'old.ts', operation: 'rename' });
    expect(renameEvent.attributes?.['previousResourceId']).toMatch(/^file_[a-f0-9]{24}$/);
    await observer.close();
  });

  it('never feeds Chronicle runtime storage changes back into its own journal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-files-runtime-'));
    tempDirs.push(root);
    const chronicleDirectory = path.join(root, 'project-state', 'chronicle');
    await mkdir(chronicleDirectory, { recursive: true });
    const journal = new ChronicleJournal({
      filePath: path.join(chronicleDirectory, 'events.jsonl'),
    });
    const context = createChronicleContext(
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );
    const observer = await startChronicleFileObserver({
      projectRoot: root,
      journal,
      context,
      excludedPaths: [chronicleDirectory],
      debounceMs: 25,
    });

    await writeFile(path.join(chronicleDirectory, 'server.json'), '{}');
    await writeFile(path.join(root, 'source.ts'), 'export const source = true;\n');
    await waitForEvent(journal, (type) => type === 'file.external.created');
    const events = await journal.readAll();

    expect(events.some((event) => event.resource?.path === 'source.ts')).toBe(true);
    expect(
      events.some((event) => event.resource?.path?.startsWith('project-state/chronicle')),
    ).toBe(false);
    await observer.close();
  });
});
