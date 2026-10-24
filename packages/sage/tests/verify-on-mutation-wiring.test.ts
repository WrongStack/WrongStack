import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { createDefaultPipelines, type ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { setupSage } from '../src/host-wiring.js';
import { getSageRetrieval, SqliteMemoryPort } from '../src/memory-port.js';
import { isSqliteAvailable } from '../src/sqlite-store.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(hygiene?: { autoOnFileChange?: boolean }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-verify-on-mutation-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', 'tax.ts'),
    'export function calculateTax(x: number) { return Math.ceil(x * 0.2); }\n',
  );
  const memory = new SqliteMemoryPort({ projectRoot: dir });
  const pipelines = createDefaultPipelines();
  const teardown = setupSage({
    config: {
      features: { memory: true },
      Sage: { inject: { turnContext: false }, ...(hygiene ? { hygiene } : {}) },
    } as Config,
    pipelines,
    memoryStore: memory,
    events: new EventBus(),
    logger: { debug: vi.fn() } as never,
    getSessionId: () => 'session-a',
  });
  cleanups.push(async () => {
    await teardown();
    memory.close();
    await removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 100 });
  });
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    session: { id: 'session-a' },
    signal: new AbortController().signal,
    memoryEvidence: [] as Array<{ source: string; text: string }>,
  };
  const edit = (file: string) =>
    pipelines.toolCall.run({
      toolUse: { type: 'tool_use', id: `edit-${file}`, name: 'edit', input: { path: file } },
      result: { type: 'tool_result', tool_use_id: `edit-${file}`, content: 'ok' },
      ctx,
    } as unknown as ToolCallPipelinePayload);
  const symbolNote = await memory.rememberSage({
    kind: 'decision',
    text: 'calculateTax rounds up because of regulation X.',
    importance: 0.8,
    anchors: [{ type: 'symbol', path: 'src/tax.ts', symbol: 'calculateTax' }],
  });
  const unrelatedNote = await memory.rememberSage({
    kind: 'decision',
    text: 'Unrelated module keeps its own cache.',
    importance: 0.8,
    anchors: [{ type: 'symbol', path: 'src/other.ts', symbol: 'missingEverywhere' }],
  });
  return { dir, memory, edit, symbolNote, unrelatedNote };
}

describe.skipIf(!isSqliteAvailable())('SAGE verify-on-mutation wiring', () => {
  it('exposes verifyForPaths on the retrieval capability', () => {
    const port = new SqliteMemoryPort({ projectRoot: os.tmpdir() });
    try {
      expect(typeof getSageRetrieval(port)?.verifyForPaths).toBe('function');
    } finally {
      port.close();
    }
  });

  it('marks a symbol memory stale when an edit removes the symbol', async () => {
    const { dir, memory, edit, symbolNote, unrelatedNote } = await fixture();
    await fs.writeFile(
      path.join(dir, 'src', 'tax.ts'),
      'export function computeTax(x: number) { return Math.ceil(x * 0.2); }\n',
    );

    await edit('src/tax.ts');

    expect((await memory.getSage(symbolNote.id))?.status).toBe('stale');
    // Only memories anchored to the edited path are verified.
    expect((await memory.getSage(unrelatedNote.id))?.status).toBe('active');
  });

  it('reactivates the memory once an edit restores the symbol', async () => {
    const { dir, memory, edit, symbolNote } = await fixture();
    const file = path.join(dir, 'src', 'tax.ts');
    await fs.writeFile(file, 'export const unrelated = 1;\n');
    await edit('src/tax.ts');
    expect((await memory.getSage(symbolNote.id))?.status).toBe('stale');

    await fs.writeFile(file, 'export function calculateTax(x: number) { return x; }\n');
    await edit('src/tax.ts');

    expect((await memory.getSage(symbolNote.id))?.status).toBe('active');
  });

  it('matches anchors when the edited path is reached through the real root', async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-verify-real-'));
    const link = `${real}-link`;
    await fs.mkdir(path.join(real, 'src'), { recursive: true });
    const file = path.join(real, 'src', 'tax.ts');
    await fs.writeFile(file, 'export function calculateTax() {}\n');
    // A junction needs no privilege on Windows; the type is ignored elsewhere.
    await fs.symlink(real, link, 'junction');
    const memory = new SqliteMemoryPort({ projectRoot: link });
    cleanups.push(async () => {
      memory.close();
      await fs.rm(link, { recursive: false, force: true });
      await removeProjectFixtureDirectory(real, { maxRetries: 5, retryDelay: 100 });
    });
    const note = await memory.rememberSage({
      kind: 'decision',
      text: 'calculateTax rounds up because of regulation X.',
      importance: 0.8,
      anchors: [{ type: 'symbol', path: 'src/tax.ts', symbol: 'calculateTax' }],
    });

    await fs.writeFile(file, 'export const unrelated = 1;\n');
    await getSageRetrieval(memory)?.verifyForPaths?.([file]);

    expect((await memory.getSage(note.id))?.status).toBe('stale');
  });

  it('honors hygiene.autoOnFileChange: false', async () => {
    const { dir, memory, edit, symbolNote } = await fixture({ autoOnFileChange: false });
    await fs.writeFile(path.join(dir, 'src', 'tax.ts'), 'export const unrelated = 1;\n');

    await edit('src/tax.ts');

    expect((await memory.getSage(symbolNote.id))?.status).toBe('active');
  });
});
