/**
 * `session_rename`: the model titles the session it is running in — never
 * another one — through the same store rename the history list uses.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { EventBus } from '../../src/kernel/events.js';
import { clampSubagentCapabilities, ToolCapabilities } from '../../src/security/capabilities.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { createSessionRenameTool } from '../../src/tools/session-rename.js';
import type { Provider } from '../../src/types/provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-rename-'));
  const store = new DefaultSessionStore({ dir });
  cleanups.push(async () => {
    await store.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const current = await store.create({ id: '', model: 'm', provider: 'p' });
  cleanups.push(async () => {
    await current.close();
  });
  const other = await store.create({ id: '', model: 'm', provider: 'p' });
  cleanups.push(async () => {
    await other.close();
  });
  const ctx = new Context({
    systemPrompt: [],
    provider: {} as Provider,
    session: current,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: dir,
    projectRoot: dir,
    model: 'm',
  });
  const events = new EventBus();
  const tool = createSessionRenameTool({
    rename: (sessionId, name) => store.rename(sessionId, name),
    events,
  });
  const run = (name: unknown) =>
    tool.execute({ name } as { name: string }, ctx, { signal: new AbortController().signal });
  const nameOf = async (id: string) => (await store.list(50)).find((s) => s.id === id)?.name;
  return { store, current, other, events, run, nameOf };
}

describe('session_rename', () => {
  it('renames the current session only, and announces it', async () => {
    const { current, other, events, run, nameOf } = await fixture();
    const seen: unknown[] = [];
    events.on('session.renamed', (e) => seen.push(e));

    expect(await run('  Fix the\nOAuth   refresh bug ')).toBe(
      'Session renamed to "Fix the OAuth refresh bug".',
    );
    expect(await nameOf(current.id)).toBe('Fix the OAuth refresh bug');
    expect(await nameOf(other.id)).toBeUndefined();
    expect(seen).toEqual([{ sessionId: current.id, name: 'Fix the OAuth refresh bug' }]);
  });

  it('caps a long name to one history line', async () => {
    const { current, run, nameOf } = await fixture();
    await run('x'.repeat(500));
    const name = await nameOf(current.id);
    expect(name).toHaveLength(120);
    expect(name?.endsWith('…')).toBe(true);
  });

  it('refuses an empty name and leaves the session as it was', async () => {
    const { current, run, nameOf } = await fixture();
    await expect(run('   ')).rejects.toThrow(/must not be empty/);
    await expect(run(undefined)).rejects.toThrow(/must not be empty/);
    expect(await nameOf(current.id)).toBeUndefined();
  });

  it('is a leader-only tool — the subagent capability ceiling drops it', () => {
    const { dropped } = clampSubagentCapabilities([ToolCapabilities.SESSION_RENAME]);
    expect(dropped).toEqual([ToolCapabilities.SESSION_RENAME]);
  });
});
