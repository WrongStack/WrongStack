import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '@wrongstack/core/registry';
import { isSqliteAvailable, SqliteMemoryPort } from '@wrongstack/sage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCanonicalHostTools } from '../src/tool-registration.js';

let tempDir: string;
let store: SqliteMemoryPort;

beforeEach(async () => {
  if (!isSqliteAvailable()) {
    throw new Error('node:sqlite is required for this test (Node >= 22.5).');
  }
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wrongstack-runtime-sqlite-'));
  store = new SqliteMemoryPort({ projectRoot: tempDir });
  await store.initialize();
});

afterEach(async () => {
  try {
    store.close();
  } catch {
    // already closed
  }
  await new Promise((r) => setTimeout(r, 10));
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

describe('registerCanonicalHostTools with real SqliteMemoryPort', () => {
  it('registers and executes the SAGE remember tool end-to-end', async () => {
    const registry = new ToolRegistry();
    const result = registerCanonicalHostTools({
      registry,
      tier: 'minimal',
      memory: { enabled: true, store },
    });

    // The SQLite store satisfies the Sage service contract directly, so the
    // canonical Sage `remember` tool should be registered.
    expect(result.memoryBackend).toBe('sage');
    const rememberTool = registry.get('remember');
    expect(rememberTool).toBeDefined();
    expect(rememberTool?.inputSchema.properties).toHaveProperty('type');

    const executed = await rememberTool?.execute(
      {
        text: 'Always verify migration reversibility.',
        type: 'convention',
        scope: 'project',
        priority: 'high',
      } as never,
      {} as never,
      { signal: new AbortController().signal } as never,
    );

    expect(executed).toMatchObject({
      text: 'Always verify migration reversibility.',
      scope: 'project',
      kind: 'convention',
    });

    // Round-trip through the MemoryStore surface to prove the Sage tool wrote
    // the expected row.
    const list = await store.list('project-memory');
    expect(list.map((entry) => entry.text)).toContain('Always verify migration reversibility.');
    expect(list.find((entry) => entry.text.startsWith('Always verify'))?.type).toBe('convention');

    // The original failure mode (TypeError) cannot recur because registration
    // now recognizes the full Sage contract.
  });
});
