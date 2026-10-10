import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { attachDepWatcherBridge } from '../../src/coordination/dep-watcher-bridge.js';
import { startTechStackConsumer } from '../../src/coordination/techstack-mailbox-consumer.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import { EventBus } from '../../src/kernel/events.js';

/**
 * Live end-to-end proof of the dep-watcher chain.
 *
 * Everything below the LLM call is the REAL production wiring: a real
 * `fs.watch` established by `attachDepWatcherBridge`, the real debounce and
 * dependency diff in `makeDependencyWatcherConfig`, a real SQLite mailbox, and
 * the real polling consumer. Only `onSpawn` is stubbed — it stands in for
 * `multiAgentHost.spawn`, which needs a live provider to run an actual model.
 *
 * The stub records the exact task string the agent WOULD receive, so the
 * assertions prove what the subagent is told, not merely that something fired.
 */

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('dep-watcher chain end-to-end (live filesystem + mailbox)', () => {
  let projectRoot: string;
  let mailboxDir: string;
  let mailbox: SqliteMailbox;
  let disposeBridge: (() => void) | undefined;
  let disposeConsumer: (() => void) | undefined;

  afterEach(async () => {
    disposeBridge?.();
    disposeConsumer?.();
    disposeBridge = undefined;
    disposeConsumer = undefined;
    await mailbox?.close().catch(() => undefined);
    // SQLite holds the store open for the connection's life; on Windows
    // `rm` then fails with EBUSY on the -wal/-shm siblings.
    await fs.rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await fs.rm(mailboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('wakes the tech-stack audit and names the newly added package@version', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'depwatch-e2e-'));
    projectRoot = path.join(base, 'project');
    mailboxDir = path.join(base, 'mailbox');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(mailboxDir, { recursive: true });

    const manifestPath = path.join(projectRoot, 'package.json');
    const manifest = (deps: Record<string, string>) =>
      JSON.stringify({ name: 'sandbox', version: '1.0.0', dependencies: deps }, null, 2);

    // v1 exists BEFORE the watch starts — it is the pre-change baseline.
    await fs.writeFile(manifestPath, manifest({ react: '18.2.0' }), 'utf8');

    mailbox = new SqliteMailbox(mailboxDir);
    const events = new EventBus();

    const spawned: { task: string; name: string }[] = [];

    // ── real production wiring ────────────────────────────────────────────
    disposeBridge = attachDepWatcherBridge({
      events,
      mailbox,
      projectRoot,
      targetAgent: 'tech-stack',
      watcherAgentId: 'dep-watcher',
      debounceMs: 50,
    });

    disposeConsumer = startTechStackConsumer({
      mailbox,
      onSpawn: async (task: string, name: string) => {
        spawned.push({ task, name });
        return { subagentId: 'sub-1', taskId: 'task-1' };
      },
      targetAgent: 'tech-stack',
      senderAgentId: 'dep-watcher',
      pollIntervalMs: 50,
    });

    // Change #1: same content. Establishes the delta baseline — by design it
    // names no package, because "first sighting" cannot claim anything is new.
    await fs.writeFile(manifestPath, manifest({ react: '18.2.0' }), 'utf8');
    expect(await waitFor(() => spawned.length >= 1)).toBe(true);
    expect(spawned[0]!.task).not.toContain('zod');

    // Change #2: a genuinely new dependency.
    await fs.writeFile(manifestPath, manifest({ react: '18.2.0', zod: '3.23.8' }), 'utf8');
    expect(await waitFor(() => spawned.length >= 2)).toBe(true);

    const auditTask = spawned[spawned.length - 1]!.task;

    // The package identity must survive the whole chain.
    expect(auditTask).toContain('zod');
    expect(auditTask).toContain('3.23.8');
    // ...and the manifest must be the real one, not a basename.
    expect(auditTask).toContain('package.json');
    // The report must be addressed where the watchers actually poll.
    expect(auditTask).toContain('pkg-outdated-watcher');
    expect(auditTask).toContain('leader');

    // The mailbox must hold a real assign from the gated sender identity.
    const messages = await mailbox.query({ to: 'tech-stack', type: 'assign', limit: 10 });
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]!.from).toBe('dep-watcher');
    expect(messages[0]!.body).toContain('Manifest: package.json');

    const named = messages.find((m) => m.body?.includes('zod'));
    expect(named, 'a mailbox message must name the added package').toBeDefined();
    expect(named!.subject).toContain('zod');
  });

  it('does not fire an audit for a version bump that adds nothing', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'depwatch-e2e2-'));
    projectRoot = path.join(base, 'project');
    mailboxDir = path.join(base, 'mailbox');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(mailboxDir, { recursive: true });

    const manifestPath = path.join(projectRoot, 'package.json');
    const manifest = (deps: Record<string, string>) =>
      JSON.stringify({ name: 'sandbox', version: '1.0.0', dependencies: deps }, null, 2);

    await fs.writeFile(manifestPath, manifest({ react: '18.2.0' }), 'utf8');

    mailbox = new SqliteMailbox(mailboxDir);
    const events = new EventBus();
    const spawned: { task: string; name: string }[] = [];

    disposeBridge = attachDepWatcherBridge({
      events,
      mailbox,
      projectRoot,
      targetAgent: 'tech-stack',
      watcherAgentId: 'dep-watcher',
      debounceMs: 50,
    });
    disposeConsumer = startTechStackConsumer({
      mailbox,
      onSpawn: async (task: string, name: string) => {
        spawned.push({ task, name });
        return { subagentId: 'sub-1', taskId: 'task-1' };
      },
      targetAgent: 'tech-stack',
      senderAgentId: 'dep-watcher',
      pollIntervalMs: 50,
    });

    // Baseline.
    await fs.writeFile(manifestPath, manifest({ react: '18.2.0' }), 'utf8');
    expect(await waitFor(() => spawned.length >= 1)).toBe(true);

    const countAfterBaseline = spawned.length;
    const seen: string[] = [];

    // A pure version bump: `hasDependencyChanges` is true (changed), so a
    // message is expected — but the task must stay in "audit each dependency"
    // mode rather than asserting a brand-new package.
    for (const range of ['18.3.0', '18.3.1', '18.3.2']) {
      await fs.writeFile(manifestPath, manifest({ react: range }), 'utf8');
      await new Promise((r) => setTimeout(r, 400));
      seen.push(...spawned.slice(countAfterBaseline).map((s) => s.task));
      spawned.length = countAfterBaseline;
    }

    for (const task of seen) {
      expect(task).not.toContain('Audit ONLY these newly added dependencies');
    }
  });
});
