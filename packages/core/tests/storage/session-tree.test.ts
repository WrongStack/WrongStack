import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, SessionBranchDescriptor } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { SessionCheckpointCas } from '../../src/storage/session-checkpoint-cas.js';
import {
  collectReachableManifestHashes,
  sweepCheckpointCas,
} from '../../src/storage/session-checkpoint-gc.js';
import { DefaultSessionRewinder } from '../../src/storage/session-rewinder.js';
import {
  getSessionTreeSnapshot,
  reconstructSessionTree,
} from '../../src/storage/session-store/tree-replay.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { SessionTreeCoordinator } from '../../src/storage/session-tree-coordinator.js';
import type { VcsRunResult } from '../../src/vcs/vcs-runner.js';

const HEAD = 'b'.repeat(40);
const zeroUsage = { input: 10, output: 10 };

describe('SessionTreeCoordinator & DAG replay', () => {
  let tmpDir: string;
  let sessionsDir: string;
  let projectDir: string;
  let casRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-session-tree-'));
    sessionsDir = path.join(tmpDir, 'sessions');
    projectDir = path.join(tmpDir, 'project');
    casRoot = path.join(sessionsDir, '_cas');
    await Promise.all([
      fs.mkdir(sessionsDir, { recursive: true }),
      fs.mkdir(path.join(projectDir, '.git'), { recursive: true }),
      fs.mkdir(path.join(projectDir, 'src'), { recursive: true }),
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockGitRunner(getDirtyPaths: () => string[]) {
    return {
      runner: async (_binary: string, args: readonly string[]): Promise<VcsRunResult> => {
        if (args[0] === 'rev-parse') return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
        if (args[0] === 'diff') {
          return { code: 0, stdout: `${getDirtyPaths().join('\0')}\0`, stderr: '' };
        }
        if (args[0] === 'ls-files') return { code: 0, stdout: '', stderr: '' };
        if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: 'unexpected git command' };
      },
    };
  }

  it('keeps unbranched journals 100% backward-compatible without stamping branchId or tree', async () => {
    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T10:00:00.000Z',
      content: 'hello world',
    });
    await writer.append({
      type: 'llm_response',
      ts: '2026-11-11T10:00:01.000Z',
      content: [{ type: 'text', text: 'hi there' }],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });
    await writer.close();

    const loaded = await store.load(writer.id);
    expect(loaded.tree).toBeUndefined();
    expect(loaded.events.every((e) => e.branchId === undefined)).toBe(true);
    expect(loaded.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(loaded.messages).toHaveLength(2);

    const summaries = await store.list();
    expect(summaries[0]?.branchCount).toBeUndefined();
    expect(summaries[0]?.activeBranchName).toBeUndefined();

    const synthesizedTree = getSessionTreeSnapshot(loaded);
    expect(synthesizedTree.activeBranchId).toBe('main');
    expect(Object.keys(synthesizedTree.branches)).toEqual(['main']);
  });

  it('isolates multi-branch conversations, nested sub-branches, historical --at forks, and per-branch compaction', async () => {
    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({
      id: '',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
    });
    let liveMessages: Message[] = [];
    let activeDescriptor: SessionBranchDescriptor | undefined;

    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      onMessagesReplaced: (msgs, branch) => {
        liveMessages = msgs;
        activeDescriptor = branch;
      },
    });

    // Turn 0 on main
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T10:00:00.000Z',
      content: 'Prompt 0 on main',
    });
    await writer.append({
      type: 'checkpoint',
      ts: '2026-11-11T10:00:01.000Z',
      promptIndex: 0,
      promptPreview: 'Prompt 0 on main',
    });
    await writer.append({
      type: 'llm_response',
      ts: '2026-11-11T10:00:02.000Z',
      content: [{ type: 'text', text: 'Answer 0 on main' }],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });

    // Turn 1 on main
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T10:00:03.000Z',
      content: 'Prompt 1 on main',
    });
    await writer.append({
      type: 'checkpoint',
      ts: '2026-11-11T10:00:04.000Z',
      promptIndex: 1,
      promptPreview: 'Prompt 1 on main',
    });
    await writer.append({
      type: 'llm_response',
      ts: '2026-11-11T10:00:05.000Z',
      content: [{ type: 'text', text: 'Answer 1 on main' }],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });

    // Fork `try-redis` from current head of main (inherits 4 messages)
    const redisCreated = await coordinator.createBranch({
      name: 'try-redis',
      label: 'Redis cache spike',
    });
    expect(redisCreated.switched).toBe(true);
    expect(liveMessages).toHaveLength(4);
    expect(activeDescriptor?.name).toBe('try-redis');

    // Append turn on `try-redis` AND emit a compaction `context_snapshot` ONLY on `try-redis`
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T10:01:00.000Z',
      content: 'Use Redis streams',
    });
    await writer.append({
      type: 'llm_response',
      ts: '2026-11-11T10:01:01.000Z',
      content: [{ type: 'text', text: 'Redis streams configured' }],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });
    await writer.append({
      type: 'context_snapshot',
      ts: '2026-11-11T10:01:02.000Z',
      reason: 'compaction',
      messages: [
        { role: 'user', content: '[Compacted try-redis summary]', ts: '2026-11-11T10:01:02.000Z' },
      ],
    });

    // Create nested branch `redis-cluster` off `try-redis`
    const nestedCreated = await coordinator.createBranch({
      name: 'redis-cluster',
    });
    expect(nestedCreated.branch.parentBranchId).toBe(redisCreated.branch.id);
    expect(liveMessages).toEqual([
      { role: 'user', content: '[Compacted try-redis summary]', ts: '2026-11-11T10:01:02.000Z' },
    ]);

    // Switch back to `main` — compaction on `try-redis` MUST NOT clobber `main`!
    const backToMain = await coordinator.switchBranch('main');
    expect(backToMain.messages).toHaveLength(4);
    expect(backToMain.messages[0]?.content).toBe('Prompt 0 on main');
    expect(backToMain.messages[3]?.content).toEqual([{ type: 'text', text: 'Answer 1 on main' }]);

    // Create historical branch `alt-at-p1` at checkpoint promptIndex=1 on main
    // (cuts right before Prompt 1, so only Prompt 0 + Answer 0 exist!)
    const historical = await coordinator.createBranch({
      name: 'alt-at-p1',
      fromBranch: 'main',
      atPromptIndex: 1,
    });
    expect(historical.messages).toHaveLength(2);
    expect(historical.messages?.[0]?.content).toBe('Prompt 0 on main');
    expect(historical.messages?.[1]?.content).toEqual([{ type: 'text', text: 'Answer 0 on main' }]);

    await writer.close();

    // Verify cold reload and resume restore active branch (`alt-at-p1`) and summary metadata
    const coldLoaded = await store.load(writer.id);
    expect(coldLoaded.tree?.activeBranchId).toBe(historical.branch.id);
    expect(Object.keys(coldLoaded.tree?.branches ?? {})).toHaveLength(4);
    expect(coldLoaded.messages).toHaveLength(2);

    const summaries = await store.list();
    expect(summaries[0]?.branchCount).toBe(4);
    expect(summaries[0]?.activeBranchName).toBe('alt-at-p1');

    // Resume writer and ensure activeBranchId hydrates from persisted tree
    const resumed = await store.resume(writer.id);
    expect(resumed.writer.activeBranchId).toBe(historical.branch.id);
    await resumed.writer.close();
  });

  it('captures and restores CAS workspace checkpoints across switches and reclaims archived branch CAS blobs', async () => {
    const dirtyFile = path.join(projectDir, 'src', 'config.ts');
    await fs.writeFile(dirtyFile, 'export const backend = "postgres";\n', 'utf8');

    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: projectDir,
      vcs: mockGitRunner(() => ['src/config.ts']),
    });

    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      checkpointCas: cas,
      projectRoot: projectDir,
    });

    // Record initial main checkpoint with postgres version
    const mainBaseCp = await cas.capture(writer.id, 0);
    expect(mainBaseCp).toBeDefined();
    await writer.append({
      type: 'checkpoint',
      ts: '2026-11-11T11:00:00.000Z',
      promptIndex: 0,
      promptPreview: '',
      workspaceCheckpoint: mainBaseCp,
    });

    // Fork `sqlite-spike` and mutate `src/config.ts` on `sqlite-spike`
    const spike = await coordinator.createBranch({ name: 'sqlite-spike' });
    await fs.writeFile(dirtyFile, 'export const backend = "sqlite-experimental";\n', 'utf8');

    // Switch back to `main` -> captures `sqlite-spike` departureCheckpoint AND restores `main` postgres file!
    const switchedToMain = await coordinator.switchBranch('main');
    expect(switchedToMain.workspaceRestored).toBe(true);
    expect(await fs.readFile(dirtyFile, 'utf8')).toBe('export const backend = "postgres";\n');

    // Switch back to `sqlite-spike` -> restores `sqlite-spike` departureCheckpoint!
    const switchedToSpike = await coordinator.switchBranch('sqlite-spike');
    expect(switchedToSpike.workspaceRestored).toBe(true);
    expect(await fs.readFile(dirtyFile, 'utf8')).toBe(
      'export const backend = "sqlite-experimental";\n',
    );
    const spikeHash = switchedToSpike.toBranch.latestWorkspaceCheckpoint?.manifestHash;
    expect(spikeHash).toBeDefined();
    expect(spikeHash).not.toBe(mainBaseCp?.manifestHash);

    // Switch to `main` so we can test GC before and after archiving `sqlite-spike`
    await coordinator.switchBranch('main');
    await writer.flush?.();

    // While `sqlite-spike` is still active, BOTH manifests are reachable
    const reachableBeforeArchive = await collectReachableManifestHashes(sessionsDir);
    expect(reachableBeforeArchive.has(mainBaseCp!.manifestHash)).toBe(true);
    expect(reachableBeforeArchive.has(spikeHash!)).toBe(true);

    // Archive `sqlite-spike` -> its exclusive manifest becomes unreachable!
    await coordinator.archiveBranch(spike.branch.id);
    await writer.close();

    const reachableAfterArchive = await collectReachableManifestHashes(sessionsDir);
    expect(reachableAfterArchive.has(mainBaseCp!.manifestHash)).toBe(true);
    expect(reachableAfterArchive.has(spikeHash!)).toBe(false);

    // Backdate CAS files so age floor permits collection of unreachable manifest
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    const backdate = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await backdate(full);
        else await fs.utimes(full, oldDate, oldDate);
      }
    };
    await backdate(casRoot);

    const gc = await sweepCheckpointCas({
      casRoot,
      reachableManifestHashes: reachableAfterArchive,
      keepNewerThanMs: Date.now(),
    });
    expect(gc.manifestsDeleted).toBe(1);
  });

  it('forks --at from the workspace manifest recorded in a deferred workspace_checkpoint event', async () => {
    const dirtyFile = path.join(projectDir, 'src', 'config.ts');
    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: projectDir,
      vcs: mockGitRunner(() => ['src/config.ts']),
    });
    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      checkpointCas: cas,
      projectRoot: projectDir,
    });

    // The journal shape FileSessionWriter.writeCheckpoint produces: the marker
    // carries no manifest; it follows in `workspace_checkpoint`, or never comes
    // when the capture fails.
    const turn = async (
      promptIndex: number,
      fileContent: string,
      captured: boolean,
    ): Promise<string | undefined> => {
      await fs.writeFile(dirtyFile, fileContent, 'utf8');
      const ts = `2026-11-11T13:0${promptIndex}:00.000Z`;
      await writer.append({ type: 'user_input', ts, content: `Prompt ${promptIndex}` });
      await writer.append({ type: 'checkpoint', ts, promptIndex, promptPreview: '' });
      const cp = captured ? await cas.capture(writer.id, promptIndex) : undefined;
      if (cp) {
        await writer.append({
          type: 'workspace_checkpoint',
          ts,
          promptIndex,
          workspaceCheckpoint: cp,
        });
      }
      await writer.append({
        type: 'llm_response',
        ts,
        content: [{ type: 'text', text: `Answer ${promptIndex}` }],
        usage: zeroUsage,
        stopReason: 'end_turn',
      });
      return cp?.manifestHash;
    };

    await turn(0, 'v0\n', true);
    const cp1Hash = await turn(1, 'v1\n', true);
    await turn(2, 'v2\n', false);
    const cp3Hash = await turn(3, 'v3\n', true);
    expect(cp1Hash).toBeDefined();

    const atP1 = await coordinator.createBranch({ name: 'alt-at-p1', atPromptIndex: 1 });
    expect(atP1.branch.baseWorkspaceCheckpoint?.manifestHash).toBe(cp1Hash);
    expect(await fs.readFile(dirtyFile, 'utf8')).toBe('v1\n');

    // A failed capture stays absent; the next prompt's manifest is not borrowed.
    const atP2 = await coordinator.createBranch({
      name: 'alt-at-p2',
      fromBranch: 'main',
      atPromptIndex: 2,
      switchImmediately: false,
    });
    expect(cp3Hash).toBeDefined();
    expect(atP2.branch.baseWorkspaceCheckpoint).toBeUndefined();
    await writer.close();
  });

  it('scrubs secrets during foldBranch before synthesis and persists clean handoff on target branch', async () => {
    const scrubber = new DefaultSecretScrubber();
    const store = new DefaultSessionStore({ dir: sessionsDir, secretScrubber: scrubber });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const synthesizeSpy = vi.fn(async (prompt: string) => `Synthesized handoff:\n${prompt}`);

    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      secretScrubber: scrubber,
      synthesizeSummary: synthesizeSpy,
    });

    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T12:00:00.000Z',
      content: 'Investigate auth token handling',
    });
    await coordinator.createBranch({ name: 'auth-spike' });

    const leakedSecret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T12:01:00.000Z',
      content: `Testing key ${leakedSecret} against staging endpoint`,
    });
    await writer.append({
      type: 'llm_response',
      ts: '2026-11-11T12:01:02.000Z',
      content: [
        { type: 'text', text: `Endpoint rejected ${leakedSecret}; use OAuth PKCE instead.` },
      ],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });

    const folded = await coordinator.foldBranch({
      focusPrompt: 'Summarize auth conclusion',
      archiveSource: true,
    });

    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    const promptPassedToSynthesizer = synthesizeSpy.mock.calls[0]?.[0] ?? '';
    expect(promptPassedToSynthesizer).not.toContain(leakedSecret);
    expect(folded.summary).not.toContain(leakedSecret);
    expect(JSON.stringify(folded.summaryMessage)).not.toContain(leakedSecret);
    expect(folded.sourceBranch.status).toBe('archived');
    expect(folded.targetBranch.id).toBe('main');

    // Target branch `main` contains original main prompt + single folded summary message, NOT raw exploratory turns
    const { messages } = reconstructSessionTree((await store.load(writer.id)).events, {
      targetBranchId: 'main',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Investigate auth token handling');
    expect(String(messages[1]?.content)).toContain('[Branch Fold-Back: auth-spike]');
    expect(String(messages[1]?.content)).not.toContain(leakedSecret);

    await writer.close();
  });

  it('scrubs beforeCompact customSummary secrets during foldBranch and emits typed kernel events on switch', async () => {
    const { EventBus } = await import('@wrongstack/contracts/kernel');
    const { ExtensionRegistry } = await import('../../src/extension/index.js');

    const dirtyFile = path.join(projectDir, 'src', 'feature.ts');
    await fs.writeFile(dirtyFile, 'export const flag = false;\n', 'utf8');

    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: projectDir,
      vcs: mockGitRunner(() => ['src/feature.ts']),
    });
    const events = new EventBus();
    const extensions = new ExtensionRegistry();
    const rawHookSecret = 'sk-proj-HOOKSECRET1234567890ABCDEFGHIJKLMNOPQRSTUV';
    extensions.register({
      name: 'custom-fold-compactor',
      beforeCompact: async ({ reason, branchName }) => ({
        customSummary: `Custom hook (${reason} on ${branchName}): avoid token ${rawHookSecret}`,
      }),
    });

    const switchedEvents: Array<{ fromBranchId: string; toBranchId: string; branchName: string }> =
      [];
    const materializedEvents: Array<{ writtenFiles: readonly string[] }> = [];
    events.on('session.branch_switched', (ev) => switchedEvents.push(ev));
    events.on('workspace.files_materialized', (ev) => materializedEvents.push(ev));

    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      checkpointCas: cas,
      projectRoot: projectDir,
      events,
      extensionRegistry: extensions,
    });

    const cpMain = await cas.capture(writer.id, 0);
    await writer.append({
      type: 'checkpoint',
      ts: '2026-11-11T13:00:00.000Z',
      promptIndex: 0,
      promptPreview: '',
      workspaceCheckpoint: cpMain,
    });
    await coordinator.createBranch({ name: 'exp-hook' });
    await fs.writeFile(dirtyFile, 'export const flag = true;\n', 'utf8');
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T13:01:00.000Z',
      content: 'Turn flag on',
    });

    const folded = await coordinator.foldBranch();
    expect(folded.summary).toContain('Custom hook (branch_fold on exp-hook)');
    expect(folded.summary).not.toContain(rawHookSecret);
    expect(JSON.stringify(folded.summaryMessage)).not.toContain(rawHookSecret);

    // Switching from exp-hook back to main during foldBranch materialized src/feature.ts and emitted both kernel events
    expect(switchedEvents.length).toBeGreaterThanOrEqual(1);
    expect(switchedEvents.at(-1)?.toBranchId).toBe('main');
    expect(materializedEvents.length).toBeGreaterThanOrEqual(1);
    expect(materializedEvents[0]?.writtenFiles).toContain('src/feature.ts');

    await writer.close();
  });

  it('maintains deterministic replay and CAS reachability across 60 randomized nested branch, compaction, fold, and archive operations', {
    timeout: 120_000,
  }, async () => {
    const trackedFile = path.join(projectDir, 'src', 'state.ts');
    await fs.writeFile(trackedFile, 'export const step = 0;\n', 'utf8');

    const cas = new SessionCheckpointCas({
      rootDir: casRoot,
      projectRoot: projectDir,
      vcs: mockGitRunner(() => ['src/state.ts']),
    });
    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      checkpointCas: cas,
      projectRoot: projectDir,
    });

    // Deterministic xorshift32 PRNG for reproducible property testing.
    let seed = 0x5eed_2026;
    const nextInt = (max: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % max;
    };

    const depthOf = (tree: Awaited<ReturnType<typeof coordinator.getTree>>, id: string): number => {
      let d = 0;
      let cur = tree.branches[id];
      while (cur?.parentBranchId) {
        d += 1;
        cur = tree.branches[cur.parentBranchId];
        if (d > 16) break;
      }
      return d;
    };

    // Seed initial main checkpoint + prompt 0
    const cp0 = await cas.capture(writer.id, 0);
    await writer.append({
      type: 'checkpoint',
      ts: new Date(1_700_000_000_000).toISOString(),
      promptIndex: 0,
      promptPreview: '',
      workspaceCheckpoint: cp0,
    });
    await writer.append({
      type: 'user_input',
      ts: new Date(1_700_000_001_000).toISOString(),
      content: 'seed prompt 0',
    });
    await writer.append({
      type: 'llm_response',
      ts: new Date(1_700_000_002_000).toISOString(),
      content: [{ type: 'text', text: 'seed reply 0' }],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });

    let branchCounter = 0;
    for (let op = 1; op <= 60; op += 1) {
      const tree = await coordinator.getTree();
      const nonArchived = Object.values(tree.branches).filter((b) => b.status !== 'archived');
      const roll = nextInt(100);

      if (roll < 42) {
        // Append prompt + checkpoint + response on active branch
        await fs.writeFile(
          trackedFile,
          `export const step = ${op}; // branch=${tree.activeBranchId}\n`,
          'utf8',
        );
        const active = tree.branches[tree.activeBranchId]!;
        const cp = await cas.capture(writer.id, active.turnCount);
        await writer.append({
          type: 'checkpoint',
          ts: new Date(1_700_000_000_000 + op * 1000).toISOString(),
          promptIndex: active.turnCount,
          promptPreview: '',
          workspaceCheckpoint: cp,
        });
        await writer.append({
          type: 'user_input',
          ts: new Date(1_700_000_000_200 + op * 1000).toISOString(),
          content: `prompt-${op} on ${active.name}`,
        });
        await writer.append({
          type: 'llm_response',
          ts: new Date(1_700_000_000_400 + op * 1000).toISOString(),
          content: [{ type: 'text', text: `reply-${op} on ${active.name}` }],
          usage: zeroUsage,
          stopReason: 'end_turn',
        });
      } else if (roll < 64) {
        // Create nested branch up to depth 5
        const candidates = nonArchived.filter((b) => depthOf(tree, b.id) < 5);
        const parent = candidates[nextInt(candidates.length)] ?? tree.branches.main!;
        branchCounter += 1;
        await coordinator.createBranch({
          name: `b-${branchCounter}`,
          fromBranch: parent.id,
          switchImmediately: nextInt(2) === 0,
        });
      } else if (roll < 80 && nonArchived.length > 1) {
        // Switch to another active/folded branch
        const target = nonArchived[nextInt(nonArchived.length)]!;
        await coordinator.switchBranch(target.id);
      } else if (roll < 90) {
        // Branch-local compaction on active branch
        const loaded = await store.load(writer.id);
        const curMsgs = reconstructSessionTree(loaded.events, {
          targetBranchId: tree.activeBranchId,
        }).messages;
        if (curMsgs.length >= 4) {
          const retained = curMsgs.slice(-2);
          await writer.append({
            type: 'compaction',
            ts: new Date(1_700_000_000_600 + op * 1000).toISOString(),
            before: curMsgs.length,
            after: retained.length + 1,
            digest: `[Compacted ${curMsgs.length - 2} messages at op ${op}]`,
          });
        }
      } else if (roll < 96) {
        // Fold a non-main active branch with >= 1 turn
        const foldable = nonArchived.filter(
          (b) => b.id !== 'main' && b.status === 'active' && b.turnCount > 0,
        );
        if (foldable.length > 0) {
          const src = foldable[nextInt(foldable.length)]!;
          await coordinator.foldBranch({
            sourceBranch: src.id,
            archiveSource: nextInt(2) === 0,
          });
        }
      } else {
        // Archive an inactive non-main leaf branch
        const archivable = nonArchived.filter(
          (b) => b.id !== 'main' && b.id !== tree.activeBranchId,
        );
        if (archivable.length > 0) {
          const victim = archivable[nextInt(archivable.length)]!;
          await coordinator.archiveBranch(victim.id);
        }
      }
    }

    await writer.close();
    const finalLoaded = await store.load(writer.id);
    const finalTree = reconstructSessionTree(finalLoaded.events, { sessionId: writer.id }).tree;
    expect(Object.keys(finalTree.branches).length).toBeGreaterThan(3);

    // Backdate CAS files so age floor permits sweeping any unreachable archived manifests
    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    const backdate = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await backdate(full);
        else await fs.utimes(full, oldDate, oldDate);
      }
    };
    await backdate(casRoot);

    const reachableManifests = await collectReachableManifestHashes(sessionsDir);
    await sweepCheckpointCas({
      casRoot,
      reachableManifestHashes: reachableManifests,
      keepNewerThanMs: Date.now(),
    });

    // Every non-archived branch must replay deterministically AND materialize its CAS checkpoint cleanly!
    for (const branch of Object.values(finalTree.branches)) {
      if (branch.status === 'archived') continue;
      const replayA = reconstructSessionTree(finalLoaded.events, { targetBranchId: branch.id });
      const replayB = reconstructSessionTree(finalLoaded.events, { targetBranchId: branch.id });
      expect(replayA.messages).toEqual(replayB.messages);

      const cp = branch.latestWorkspaceCheckpoint ?? branch.baseWorkspaceCheckpoint;
      if (cp) {
        expect(reachableManifests.has(cp.manifestHash)).toBe(true);
        const mat = await cas.materialize(cp, projectDir);
        expect(mat.errors).toEqual([]);
        expect(mat.writtenFiles).toContain('src/state.ts');
      }
    }
  });

  it('enforces branchFoldMaxTokens budget and records onFoldInsight sageMemoryIds on branch_folded', async () => {
    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });

    const insightCalls: Array<{
      sourceBranchName: string;
      targetBranchId: string;
      touchedFiles: readonly string[];
      summary: string;
    }> = [];

    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      branchFoldMaxTokens: 40, // 40 * 4 = 160 chars ceiling
      synthesizeSummary: async () =>
        `Decision A: keep SQLite WAL mode enabled.\n${'Verbose exploration detail line that exceeds the token ceiling. '.repeat(12)}`,
      onFoldInsight: async (ctx) => {
        insightCalls.push({
          sourceBranchName: ctx.sourceBranch.name,
          targetBranchId: ctx.targetBranch.id,
          touchedFiles: ctx.touchedFiles,
          summary: ctx.summary,
        });
        return ['sage_mem_01', 'sage_mem_02'];
      },
    });

    await coordinator.createBranch({ name: 'wal-tuning' });
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T15:00:00.000Z',
      content: 'Benchmark WAL checkpoint intervals',
    });
    await writer.append({
      type: 'file_snapshot',
      ts: '2026-11-11T15:00:05.000Z',
      promptIndex: 0,
      files: [{ path: 'src/db/wal.ts', action: 'modified', before: 'old', after: 'new' }],
    });

    const folded = await coordinator.foldBranch({ archiveSource: true });
    expect(folded.summary.length).toBeLessThanOrEqual(40 * 4);
    expect(folded.summary).toContain('[...truncated to branchFoldMaxTokens budget]');
    expect(folded.sageMemoryIds).toEqual(['sage_mem_01', 'sage_mem_02']);

    expect(insightCalls).toHaveLength(1);
    expect(insightCalls[0]?.sourceBranchName).toBe('wal-tuning');
    expect(insightCalls[0]?.targetBranchId).toBe('main');
    expect(insightCalls[0]?.touchedFiles).toEqual(['src/db/wal.ts']);

    await writer.close();
    const loaded = await store.load(writer.id);
    const foldEvent = loaded.events.find((ev) => ev.type === 'branch_folded');
    expect(foldEvent?.type).toBe('branch_folded');
    if (foldEvent?.type === 'branch_folded') {
      expect(foldEvent.sageMemoryIds).toEqual(['sage_mem_01', 'sage_mem_02']);
    }
  });

  it('replays cold-archived .jsonl.gz legacy and multi-branch sessions identically and preserves CAS reachability', async () => {
    const store = new DefaultSessionStore({ dir: sessionsDir });

    // 1. Legacy unbranched session compressed to .jsonl.gz
    const legacyWriter = await store.create({ id: '', model: 'claude', provider: 'anthropic' });
    await legacyWriter.append({
      type: 'user_input',
      ts: '2026-11-10T09:00:00.000Z',
      content: 'Legacy unbranched prompt',
    });
    await legacyWriter.append({
      type: 'llm_response',
      ts: '2026-11-10T09:00:02.000Z',
      content: [{ type: 'text', text: 'Legacy unbranched answer' }],
      usage: zeroUsage,
      stopReason: 'end_turn',
    });
    await legacyWriter.close();
    const legacyArchive = await store.archive(legacyWriter.id);
    expect(legacyArchive.action).toBe('archived');

    const loadedLegacyGz = await store.load(legacyWriter.id);
    expect(loadedLegacyGz.tree).toBeUndefined();
    expect(loadedLegacyGz.messages).toHaveLength(2);
    expect(loadedLegacyGz.messages[0]?.content).toBe('Legacy unbranched prompt');

    // 2. Multi-branch session compressed to .jsonl.gz
    const branchedWriter = await store.create({ id: '', model: 'claude', provider: 'anthropic' });
    const coord = new SessionTreeCoordinator({
      sessionId: branchedWriter.id,
      writer: branchedWriter,
      getEvents: async () => {
        await branchedWriter.flush?.();
        return (await store.load(branchedWriter.id)).events;
      },
    });
    await branchedWriter.append({
      type: 'user_input',
      ts: '2026-11-11T10:00:00.000Z',
      content: 'Main root turn',
    });
    await coord.createBranch({ name: 'gz-spike' });
    await branchedWriter.append({
      type: 'user_input',
      ts: '2026-11-11T10:01:00.000Z',
      content: 'Compressed branch turn',
    });
    await branchedWriter.close();

    const branchedArchive = await store.archive(branchedWriter.id);
    expect(branchedArchive.action).toBe('archived');

    const loadedBranchedGz = await store.load(branchedWriter.id);
    expect(loadedBranchedGz.tree?.activeBranchId).toBeTruthy();
    expect(Object.keys(loadedBranchedGz.tree?.branches ?? {})).toHaveLength(2);
    expect(loadedBranchedGz.messages.map((m) => m.content)).toEqual([
      'Main root turn',
      'Compressed branch turn',
    ]);

    const summaries = await store.list(10);
    const branchedSummary = summaries.find((s) => s.id === branchedWriter.id);
    expect(branchedSummary?.storageState).toBe('cold');
    expect(branchedSummary?.branchCount).toBe(2);
    expect(branchedSummary?.activeBranchName).toBe('gz-spike');
  });

  it('keeps the compaction a branch was forked from after the parent compacts again', async () => {
    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
    });
    const appendMessage = (role: 'user' | 'assistant', content: string, ts: string) =>
      writer.append({ type: 'message_appended', ts, version: 1, message: { role, content, ts } });
    const compact = (content: string, ts: string) =>
      writer.append({
        type: 'messages_replaced',
        ts,
        version: 1,
        messages: [{ role: 'user', content, ts }],
      });

    await appendMessage('user', 'p0 on main', '2026-11-13T10:00:00.000Z');
    await appendMessage('assistant', 'a0 on main', '2026-11-13T10:00:01.000Z');
    await compact('[main summary 1]', '2026-11-13T10:00:02.000Z');
    const child = await coordinator.createBranch({ name: 'after-compaction' });
    await appendMessage('user', 'p1 on child', '2026-11-13T10:01:00.000Z');

    // A second compaction on main makes the loader strip the first snapshot's
    // payload, which is the one the child's lineage starts from.
    await coordinator.switchBranch('main');
    await appendMessage('user', 'p1 on main', '2026-11-13T10:02:00.000Z');
    await compact('[main summary 2]', '2026-11-13T10:02:01.000Z');

    const switched = await coordinator.switchBranch(child.branch.id);
    expect(switched.messages.map((m) => m.content)).toEqual(['[main summary 1]', 'p1 on child']);
    const backOnMain = await coordinator.switchBranch('main');
    expect(backOnMain.messages.map((m) => m.content)).toEqual(['[main summary 2]']);
    await writer.close();
  });

  describe('/rewind in a branched session', () => {
    async function branchedSession() {
      const store = new DefaultSessionStore({ dir: sessionsDir });
      const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
      const coordinator = new SessionTreeCoordinator({
        sessionId: writer.id,
        writer,
        getEvents: async () => {
          await writer.flush?.();
          return (await store.load(writer.id)).events;
        },
      });
      let t = Date.parse('2026-11-13T10:00:00.000Z');
      const ts = () => {
        t += 1000;
        return new Date(t).toISOString();
      };
      const turn = async (promptIndex: number, text: string) => {
        await writer.append({ type: 'user_input', ts: ts(), content: text });
        await writer.append({ type: 'checkpoint', ts: ts(), promptIndex, promptPreview: text });
        await writer.append({
          type: 'llm_response',
          ts: ts(),
          content: [{ type: 'text', text: `answer to ${text}` }],
          usage: zeroUsage,
          stopReason: 'end_turn',
        });
      };
      await turn(0, 'p0');
      await turn(1, 'p1');
      const child = await coordinator.createBranch({ name: 'child' });
      await coordinator.switchBranch('main');
      await turn(2, 'p2 on main');
      await coordinator.switchBranch(child.branch.id);
      await turn(2, 'p2 on child');
      return { store, writer, coordinator, child };
    }

    const answers = (messages: readonly Message[]) =>
      messages.filter((m) => m.role === 'assistant').map((m) => JSON.stringify(m.content));

    it("cuts at the active branch's own checkpoint and keeps every other branch", async () => {
      const { store, writer, child } = await branchedSession();

      // Prompt indices restart per lineage: main also has a checkpoint 2, and it
      // comes first in the journal.
      const removed = await writer.truncateToCheckpoint(2);
      expect(removed).toBe(1);
      await writer.close();

      const events = (await store.load(writer.id)).events;
      const tree = reconstructSessionTree(events, { sessionId: writer.id });
      expect(tree.tree.activeBranchId).toBe(child.branch.id);
      const main = reconstructSessionTree(events, { sessionId: writer.id, targetBranchId: 'main' });
      expect(answers(main.messages)).toContain(
        JSON.stringify([{ type: 'text', text: 'answer to p2 on main' }]),
      );
    });

    it('refuses a rewind whose cut would delete other branches, before touching files', async () => {
      const { store, writer, coordinator } = await branchedSession();
      await coordinator.switchBranch('main');
      await writer.flush?.();
      const file = (await fs.readdir(sessionsDir, { recursive: true }))
        .map((p) => path.join(sessionsDir, String(p)))
        .find((p) => p.endsWith(`${path.basename(writer.id)}.jsonl`));
      if (!file) throw new Error('session journal not found');
      const before = await fs.readFile(file, 'utf8');

      const rewinder = new DefaultSessionRewinder(sessionsDir, projectDir);
      await expect(rewinder.rewindToCheckpoint(writer.id, 2)).rejects.toThrow(
        /other session branches/,
      );
      await expect(writer.truncateToCheckpoint(2)).rejects.toThrow(/other session branches/);
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      await writer.close();

      const loaded = await store.load(writer.id);
      expect(Object.keys(loaded.tree?.branches ?? {})).toHaveLength(2);
    });

    it('drops the redo of a rewind once the session tree changed after it', async () => {
      const { store, writer, coordinator, child } = await branchedSession();
      // Rewind child's own turn 2, then leave the branch.
      expect(await writer.truncateToCheckpoint(2)).toBe(1);
      expect(await writer.peekRedo?.()).not.toBeNull();
      await coordinator.switchBranch('main');

      // A redo would rebuild the journal as kept part + stash and drop the
      // switch record: the journal back on `child`, the writer still on main.
      expect(await writer.peekRedo?.()).toBeNull();
      expect(await writer.restoreRedo?.()).toBeNull();
      await writer.close();

      const { tree } = reconstructSessionTree((await store.load(writer.id)).events, {
        sessionId: writer.id,
      });
      expect(tree.activeBranchId).toBe('main');
      expect(writer.activeBranchId).toBe('main');
      expect(tree.branches[child.branch.id]).toBeDefined();
    });

    it('folds only the turns of the source branch that survived its /rewind', async () => {
      const { writer, coordinator } = await branchedSession();
      // Undo child's turn 2 and ask something else instead.
      expect(await writer.truncateToCheckpoint(2)).toBe(1);
      const ts = new Date(Date.parse('2026-11-13T11:00:00.000Z')).toISOString();
      await writer.append({ type: 'user_input', ts, content: 'p2 retry on child' });
      await writer.append({
        type: 'checkpoint',
        ts,
        promptIndex: 2,
        promptPreview: 'p2 retry on child',
      });
      await writer.append({
        type: 'llm_response',
        ts,
        content: [{ type: 'text', text: 'retry conclusion' }],
        usage: zeroUsage,
        stopReason: 'end_turn',
      });

      const folded = await coordinator.foldBranch();
      expect(folded.summary).not.toContain('p2 on child');
      expect(folded.summary).toContain('p2 retry on child');
      expect(folded.summary).toContain('Explored 1 prompt(s)');
      expect(folded.summary).toContain('Latest conclusion: retry conclusion');
      await writer.close();
    });
  });
});
