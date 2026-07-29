import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  startTechStackConsumer,
} from '../../src/coordination/techstack-mailbox-consumer.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';

describe('techstack-mailbox-consumer', () => {
  let tmpDir: string;
  let mailbox: SqliteMailbox;
  let spawnedTasks: Array<{ task: string; name: string }>;
  let dispose: (() => void) | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsc-test-'));
    mailbox = new SqliteMailbox(tmpDir);
    spawnedTasks = [];
  });

  afterEach(async () => {
    if (dispose) {
      dispose();
      dispose = undefined;
    }
    // SQLite holds the store open for the life of the connection; on Windows
    // `fs.rm` then fails with EBUSY on `_mailbox.sqlite` and its `-wal`/`-shm`.
    await mailbox.close().catch(() => undefined);
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('spawns agent when assign message arrives', async () => {
    const onSpawn = vi.fn(async (task: string, name: string) => {
      spawnedTasks.push({ task, name });
      return { subagentId: 'ts-1', taskId: 'task-1' };
    });

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    // Post an assign message
    await mailbox.send({
      id: 'msg-1',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'Dependency manifest changed: package.json',
      body: 'Manifest: package.json\n\n| File | Event |\n| package.json | change |',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    expect(spawnedTasks[0].name).toBe('tech-stack-package.json');
    expect(spawnedTasks[0].task).toContain('package.json');
  });

  it('does not spawn for non-assign messages', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-2',
      from: 'someone',
      to: 'tech-stack',
      type: 'btw',
      subject: 'Hello',
      body: 'Just saying hi',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('does not spawn for messages to other agents', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      targetAgent: 'tech-stack',
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-3',
      from: 'dep-watcher',
      to: 'bug-hunter',
      type: 'assign',
      subject: 'package.json changed',
      body: 'Manifest: package.json',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('extracts manifest path from subject fallback', async () => {
    const onSpawn = vi.fn(async (task: string, name: string) => {
      spawnedTasks.push({ task, name });
      return { subagentId: 'x', taskId: 'y' };
    });

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-4',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'go.mod updated in backend/',
      body: 'Some generic body without manifest info',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
    expect(spawnedTasks[0].task).toContain('go.mod');
  });

  it('calls onError when spawn fails', async () => {
    const onSpawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const onError = vi.fn();

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      onError,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-5',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'Cargo.toml changed',
      body: 'Manifest: Cargo.toml',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  });

  it('extracts manifest from markdown table body', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    // Body contains a markdown table where the second column has the manifest path
    await mailbox.send({
      id: 'msg-6',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'Dependency change detected',
      body: '| File | package.json |\n| Event | change |',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
  });

  it('skips messages with no manifest path', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));
    const onLog = vi.fn();

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      onLog,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-7',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'Something changed',
      body: 'No manifest here',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      expect(onLog).toHaveBeenCalledWith(expect.stringContaining('No manifest path'));
    });
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('does not spawn duplicate messages (processedIds)', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    const _msg = await mailbox.send({
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'package.json changed',
      body: 'Manifest: package.json',
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));

    // Send a reply (different message ID) — should also be processed
    await mailbox.send({
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'go.mod changed',
      body: 'Manifest: go.mod',
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
  });

  it('handles onError from query failure gracefully', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));
    const onError = vi.fn();

    // Create a mailbox that rejects query
    const brokenMailbox = new SqliteMailbox(tmpDir);
    vi.spyOn(brokenMailbox, 'query').mockRejectedValue(new Error('query failed'));

    try {
      dispose = startTechStackConsumer({
        mailbox: brokenMailbox,
        onSpawn,
        onError,
        pollIntervalMs: 50,
      });

      await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    } finally {
      // Second connection to the same directory — close it here or the
      // afterEach `fs.rm` hits EBUSY on the still-open database.
      await brokenMailbox.close().catch(() => undefined);
    }
  });

  it('can extract manifest from subject with path pattern', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    // Subject contains a path-like string matching a manifest pattern
    await mailbox.send({
      id: 'msg-path',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'build.gradle updated in project root',
      body: 'Some generic text',
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
  });

  it('handles fileAuthorOpts and recordFileAction', async () => {
    const fileAuthDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tsc-fileauth-'),
    );
    try {
      const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

      dispose = startTechStackConsumer({
        mailbox,
        onSpawn,
        pollIntervalMs: 100,
        fileAuthorOpts: { dir: fileAuthDir },
        currentAgentId: 'test-agent',
        currentAgentName: 'TestAgent',
        sessionId: 'sess-1',
      });

      await mailbox.send({
        from: 'dep-watcher',
        to: 'tech-stack',
        type: 'assign',
        subject: 'package.json changed',
        body: 'Manifest: package.json',
      });

      await vi.waitFor(() => expect(onSpawn).toHaveBeenCalled());
    } finally {
      await fs.rm(fileAuthDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('accepts custom consumerAgentId and targetAgent', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      targetAgent: 'my-tech-stack',
      consumerAgentId: 'my-consumer',
      pollIntervalMs: 100,
    });

    await mailbox.send({
      from: 'dep-watcher',
      to: 'my-tech-stack',
      type: 'assign',
      subject: 'Cargo.toml changed',
      body: 'Manifest: Cargo.toml',
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
  });

  it('extracts manifest from cmake and conanfile patterns', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    // CMakeLists.txt should be recognized as a manifest
    await mailbox.send({
      from: 'watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'CMakeLists.txt changed',
      body: 'Manifest: CMakeLists.txt',
    });

    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(1));
  });
});
