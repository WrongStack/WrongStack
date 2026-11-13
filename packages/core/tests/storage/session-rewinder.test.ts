import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionRewinder } from '../../src/storage/session-rewinder.js';

describe('DefaultSessionRewinder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-rewind-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeSession(events: object[]): Promise<string> {
    const id = Math.random().toString(36).slice(2);
    const file = path.join(tmp, `${id}.jsonl`);
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return id;
  }

  function makeCheckpoint(promptIndex: number, preview: string) {
    return {
      type: 'checkpoint' as const,
      ts: new Date().toISOString(),
      promptIndex,
      promptPreview: preview,
    };
  }

  function makeFileSnapshot(
    promptIndex: number,
    files: Array<{ path: string; action: string; before: string | null; after: string | null }>,
  ) {
    return { type: 'file_snapshot' as const, ts: new Date().toISOString(), promptIndex, files };
  }

  describe('the prompt a checkpoint belongs to', () => {
    const input = (content: unknown) => ({
      type: 'user_input',
      ts: new Date().toISOString(),
      content,
    });

    it('hands back the text of the prompt a rewind takes back', async () => {
      // The agent records the input, then the checkpoint (agent-loop.ts).
      const id = await writeSession([
        input('first prompt'),
        makeCheckpoint(0, 'first prompt'),
        input([
          { type: 'text', text: 'second prompt' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
          { type: 'text', text: 'with a second line' },
        ]),
        makeCheckpoint(3, 'second prompt'),
        input('third prompt'),
        makeCheckpoint(5, 'third prompt'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      expect(await rewind.promptAt(id, 0)).toBe('first prompt');
      expect(await rewind.promptAt(id, 3)).toBe('second prompt\nwith a second line');
      expect(await rewind.promptAt(id, 9)).toBeUndefined();
      const result = await rewind.rewindToCheckpoint(id, 3);
      expect(result.promptText).toBe('second prompt\nwith a second line');
      // The image block is not in the text, so a resend of the text alone would lose it.
      expect(result.promptHasAttachments).toBe(true);
      expect(result.removedEvents).toBe(2);
    });

    it('hands back the newest prompt when an earlier rewind left the index behind', async () => {
      const id = await writeSession([
        input('first prompt'),
        makeCheckpoint(0, 'first prompt'),
        input('rewound prompt'),
        makeCheckpoint(1, 'rewound prompt'),
        { type: 'rewound', ts: new Date().toISOString(), toPromptIndex: 1, revertedFiles: [] },
        input('prompt sent after the rewind'),
        makeCheckpoint(1, 'prompt sent after the rewind'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      expect(await rewind.promptAt(id, 1)).toBe('prompt sent after the rewind');
      const result = await rewind.rewindToCheckpoint(id, 1);
      expect(result.promptText).toBe('prompt sent after the rewind');
      expect(result.promptHasAttachments).toBe(false);
    });

    it('reports no prompt when the journal holds no input before the checkpoint', async () => {
      const id = await writeSession([makeCheckpoint(0, 'legacy')]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      expect(await rewind.promptAt(id, 0)).toBeUndefined();
      expect((await rewind.rewindToCheckpoint(id, 0)).promptText).toBeUndefined();
    });
  });

  describe('listCheckpoints', () => {
    it('reads checkpoints from date-sharded session ids', async () => {
      const id = '2026-06-11/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
      const shardDir = path.join(tmp, '2026-06-11');
      await fs.mkdir(shardDir, { recursive: true });
      await fs.writeFile(
        path.join(shardDir, 'sess_01JX2S9V7T5M6N7P8Q9R0STXVW.jsonl'),
        JSON.stringify(makeCheckpoint(0, 'sharded prompt')) + '\n',
        'utf8',
      );

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      expect(await rewind.listCheckpoints(id)).toMatchObject([
        { promptIndex: 0, promptPreview: 'sharded prompt' },
      ]);
    });

    it('returns empty array when no checkpoints', async () => {
      const id = await writeSession([
        {
          type: 'session_start',
          ts: new Date().toISOString(),
          id: 's1',
          model: 'm',
          provider: 'p',
        },
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const checkpoints = await rewind.listCheckpoints(id);
      expect(checkpoints).toEqual([]);
    });

    it('returns all checkpoints with correct data', async () => {
      const id = await writeSession([
        makeCheckpoint(0, 'first prompt'),
        makeCheckpoint(1, 'second prompt'),
        makeCheckpoint(2, 'third prompt'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const checkpoints = await rewind.listCheckpoints(id);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0]).toMatchObject({ promptIndex: 0, promptPreview: 'first prompt' });
      expect(checkpoints[1]).toMatchObject({ promptIndex: 1, promptPreview: 'second prompt' });
      expect(checkpoints[2]).toMatchObject({ promptIndex: 2, promptPreview: 'third prompt' });
    });

    it('includes fileCount from file_snapshot events', async () => {
      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [
          { path: '/a.txt', action: 'modified', before: 'x', after: 'y' },
          { path: '/b.txt', action: 'created', before: null, after: 'z' },
        ]),
        makeCheckpoint(1, 'second'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const checkpoints = await rewind.listCheckpoints(id);
      expect(checkpoints[0]).toMatchObject({ promptIndex: 0, fileCount: 2 });
      expect(checkpoints[1]).toMatchObject({ promptIndex: 1, fileCount: 0 });
    });
  });

  describe('rewindToCheckpoint', () => {
    it('reverts files after target checkpoint', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'changed2', 'utf8');

      // Real writer layout: writeCheckpoint(N) appends checkpoint(N) and only
      // THEN sets activePromptIndex = N, so prompt N's file_snapshot(N) always
      // follows its checkpoint (file-session-writer.ts:652-659, :194-199).
      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [
          { path: testFile, action: 'modified', before: 'original', after: 'changed0' },
        ]),
        makeCheckpoint(1, 'second'),
        makeFileSnapshot(1, [
          { path: testFile, action: 'modified', before: 'changed0', after: 'changed1' },
        ]),
        makeCheckpoint(2, 'third'),
        makeFileSnapshot(2, [
          { path: testFile, action: 'modified', before: 'changed1', after: 'changed2' },
        ]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 1);

      expect(result.revertedFiles).toContain(testFile);
      // Rewinding to checkpoint 1 undoes prompt 1 AND every later prompt, so
      // the file returns to the state checkpoint 1 was taken at.
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('changed0');
      expect(result.toPromptIndex).toBe(1);
      expect(result.removedEvents).toBeGreaterThanOrEqual(0);
    });

    it('reverts EVERY later prompt, not just the target one', async () => {
      // Regression: the scan used to break at the first checkpoint after the
      // target, reverting only the target prompt's files while the caller
      // truncated the journal all the way back.
      const a = path.join(tmp, 'a.txt');
      const b = path.join(tmp, 'b.txt');
      await fs.writeFile(a, 'a-prompt1', 'utf8');
      await fs.writeFile(b, 'b-prompt2', 'utf8');

      const id = await writeSession([
        makeCheckpoint(1, 'p1'),
        makeFileSnapshot(1, [
          { path: a, action: 'modified', before: 'a-original', after: 'a-prompt1' },
        ]),
        makeCheckpoint(2, 'p2'),
        makeFileSnapshot(2, [
          { path: b, action: 'modified', before: 'b-original', after: 'b-prompt2' },
        ]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 1);

      expect(result.revertedFiles).toEqual(expect.arrayContaining([a, b]));
      expect(await fs.readFile(a, 'utf8')).toBe('a-original');
      expect(await fs.readFile(b, 'utf8')).toBe('b-original');
    });

    it('throws when checkpoint not found', async () => {
      const id = await writeSession([makeCheckpoint(0, 'first')]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      await expect(rewind.rewindToCheckpoint(id, 999)).rejects.toThrow('Checkpoint 999 not found');
    });

    it('handles file creation revert (deletes created file)', async () => {
      const createdFile = path.join(tmp, 'created.txt');

      // The correct event order in session:
      // checkpoint(n) is written AFTER prompt n is processed
      // file_snapshot(n) tracks changes MADE during prompt n
      // So file_snapshot(0) comes AFTER checkpoint(0) but REVERT means undoing prompt 1's changes
      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        // file_snapshot(0) represents changes from prompt 0 - this is what we want to REVERT when going to checkpoint 1
        makeFileSnapshot(0, [
          { path: createdFile, action: 'created', before: null, after: 'content' },
        ]),
        makeCheckpoint(1, 'second'),
      ]);

      // File needs to exist (simulating state after prompt 0 ran)
      await fs.writeFile(createdFile, 'content', 'utf8');

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      // Rewind to checkpoint 1 means "go back to state after prompt 0, before prompt 1"
      const result = await rewind.rewindToCheckpoint(id, 0);

      expect(result.revertedFiles).toContain(createdFile);
      await expect(fs.access(createdFile)).rejects.toThrow();
    });

    it('handles file deletion revert (restores deleted file)', async () => {
      const deletedFile = path.join(tmp, 'deleted.txt');
      await fs.writeFile(deletedFile, 'original content', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [
          { path: deletedFile, action: 'deleted', before: 'original content', after: null },
        ]),
        makeCheckpoint(1, 'second'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 0);

      expect(result.revertedFiles).toContain(deletedFile);
      const content = await fs.readFile(deletedFile, 'utf8');
      expect(content).toBe('original content');
    });

    // Test error collection is available (actual I/O errors are hard to trigger in temp dirs)
    it('returns empty errors for successful reverts', async () => {
      const testFile = path.join(tmp, 'success.txt');
      await fs.writeFile(testFile, 'modified content', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'first'),
        makeFileSnapshot(0, [
          { path: testFile, action: 'modified', before: 'modified content', after: 'new content' },
        ]),
        makeCheckpoint(1, 'second'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToCheckpoint(id, 0);

      expect(result.revertedFiles).toContain(testFile);
      expect(result.errors).toEqual([]);
    });

    it('reverts repeated edits of the same file in reverse execution order', async () => {
      const testFile = path.join(tmp, 'repeated.txt');
      await fs.writeFile(testFile, 'v2', 'utf8');
      const id = await writeSession([
        makeCheckpoint(0, 'start'),
        makeFileSnapshot(0, [
          { path: testFile, action: 'modified', before: 'v0', after: 'v1' },
          { path: testFile, action: 'modified', before: 'v1', after: 'v2' },
        ]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      await rewind.rewindToCheckpoint(id, 0);

      expect(await fs.readFile(testFile, 'utf8')).toBe('v0');
    });
  });

  describe('rewindLastN', () => {
    it('undoes exactly the last prompt for n=1', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'v2', 'utf8');

      // Real layout: each checkpoint(N) is followed by its own file_snapshot(N).
      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: testFile, action: 'modified', before: 'v0', after: 'v1' }]),
        makeCheckpoint(1, 'p1'),
        makeFileSnapshot(1, [{ path: testFile, action: 'modified', before: 'v1', after: 'v2' }]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 1);

      // n=1 must undo ONLY prompt 1 (the newest), leaving prompt 0's edit.
      expect(result.toPromptIndex).toBe(1);
      expect(result.revertedFiles).toContain(testFile);
      expect(await fs.readFile(testFile, 'utf8')).toBe('v1');
    });

    it('undoes two prompts for n=2', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'v2', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: testFile, action: 'modified', before: 'v0', after: 'v1' }]),
        makeCheckpoint(1, 'p1'),
        makeFileSnapshot(1, [{ path: testFile, action: 'modified', before: 'v1', after: 'v2' }]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 2);

      expect(result.toPromptIndex).toBe(0);
      expect(await fs.readFile(testFile, 'utf8')).toBe('v0');
    });

    it('is a no-op for n=0 rather than rewinding everything', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'v1', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: testFile, action: 'modified', before: 'v0', after: 'v1' }]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 0);

      expect(result.revertedFiles).toEqual([]);
      expect(await fs.readFile(testFile, 'utf8')).toBe('v1');
    });

    it('reverts all when N exceeds checkpoint count', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'v1', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: testFile, action: 'modified', before: 'v0', after: 'v1' }]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 10);

      expect(result.revertedFiles).toContain(testFile);
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('v0');
    });

    it('returns empty result when no snapshots', async () => {
      const id = await writeSession([makeCheckpoint(0, 'only checkpoint')]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 1);
      expect(result.revertedFiles).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('deduplicates checkpoints left behind by an earlier rewind and rewinds non-zero-based sessions when N exceeds count', async () => {
      const dupFile = path.join(tmp, 'dup.txt');
      await fs.writeFile(dupFile, 'v2', 'utf8');
      const dupId = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: dupFile, action: 'modified', before: 'v0', after: 'v1' }]),
        makeCheckpoint(1, 'p1-old'),
        { type: 'rewound', ts: new Date().toISOString(), toPromptIndex: 1, revertedFiles: [] },
        makeCheckpoint(1, 'p1-new'),
        makeFileSnapshot(1, [{ path: dupFile, action: 'modified', before: 'v1', after: 'v2' }]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const listed = await rewind.listCheckpoints(dupId);
      expect(listed).toMatchObject([
        { promptIndex: 0, promptPreview: 'p0', fileCount: 1 },
        { promptIndex: 1, promptPreview: 'p1-new', fileCount: 1 },
      ]);

      const dupResult = await rewind.rewindLastN(dupId, 2);
      expect(dupResult.toPromptIndex).toBe(0);
      expect(await fs.readFile(dupFile, 'utf8')).toBe('v0');

      const oneBasedFile = path.join(tmp, 'onebased.txt');
      await fs.writeFile(oneBasedFile, 'b2', 'utf8');
      const oneBasedId = await writeSession([
        makeCheckpoint(1, 'p1'),
        makeFileSnapshot(1, [
          { path: oneBasedFile, action: 'modified', before: 'b0', after: 'b1' },
        ]),
        makeCheckpoint(2, 'p2'),
        makeFileSnapshot(2, [
          { path: oneBasedFile, action: 'modified', before: 'b1', after: 'b2' },
        ]),
      ]);
      const oneBasedResult = await rewind.rewindLastN(oneBasedId, 10);
      expect(oneBasedResult.toPromptIndex).toBe(1);
      expect(await fs.readFile(oneBasedFile, 'utf8')).toBe('b0');
    });
  });

  describe('rewindLastN on a branched journal', () => {
    // Writer-realistic stamping (session-writer-append.ts stampBranchAndSeq):
    // main's lines stay unstamped, every event of another branch carries its
    // branchId, and prompt indices restart per lineage.
    const branchCreated = (branchId: string) => ({
      type: 'branch_created',
      ts: new Date().toISOString(),
      newBranchId: branchId,
      name: branchId.replace(/^br-/, ''),
      parentBranchId: 'main',
      forkSeq: 6,
    });
    const branchSwitched = (from: string, to: string) => ({
      type: 'branch_switched',
      ts: new Date().toISOString(),
      fromBranchId: from,
      toBranchId: to,
    });
    const branchSnapshot = (
      branchId: string,
      promptIndex: number,
      files: Array<{ path: string; action: string; before: string | null; after: string | null }>,
    ) => ({ type: 'file_snapshot', ts: new Date().toISOString(), promptIndex, files, branchId });
    const branchCheckpoint = (branchId: string, promptIndex: number, preview: string) => ({
      type: 'checkpoint',
      ts: new Date().toISOString(),
      promptIndex,
      promptPreview: preview,
      branchId,
    });

    it('reverts only the active branch’s newest prompt when indices collide across branches', async () => {
      // main: prompt0 edits a.txt, prompt1 edits b.txt; then fork to br-explore
      // (active at journal end) whose prompt0 edits c.txt. `--last 1` must undo
      // br-explore's prompt only — before the branch scoping, the shared
      // promptIndex 0 collapsed main's checkpoint out of the selection map and
      // the revert spanned both branches.
      const aTxt = path.join(tmp, 'branch-a.txt');
      const bTxt = path.join(tmp, 'branch-b.txt');
      const cTxt = path.join(tmp, 'branch-c.txt');
      await fs.writeFile(aTxt, 'a1', 'utf8');
      await fs.writeFile(bTxt, 'b1', 'utf8');
      await fs.writeFile(cTxt, 'c1', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: aTxt, action: 'modified', before: 'a0', after: 'a1' }]),
        makeCheckpoint(1, 'p1'),
        makeFileSnapshot(1, [{ path: bTxt, action: 'modified', before: 'b0', after: 'b1' }]),
        branchCreated('br-explore'),
        branchSwitched('main', 'br-explore'),
        branchCheckpoint('br-explore', 0, 'explore prompt'),
        branchSnapshot('br-explore', 0, [
          { path: cTxt, action: 'modified', before: 'c0', after: 'c1' },
        ]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindLastN(id, 1);

      expect(result.toPromptIndex).toBe(0);
      expect(result.revertedFiles).toEqual([cTxt]);
      expect(await fs.readFile(aTxt, 'utf8')).toBe('a1');
      expect(await fs.readFile(bTxt, 'utf8')).toBe('b1');
      expect(await fs.readFile(cTxt, 'utf8')).toBe('c0');
    });

    it('refuses and changes nothing when other branches’ events follow the target checkpoint', async () => {
      // Active branch is main again after the switch-back; rewinding its last
      // two prompts would also cut br-x's turn, so the rewind must throw
      // BEFORE any file is reverted (same rule as rewindToCheckpoint).
      const aTxt = path.join(tmp, 'guard-a.txt');
      const bTxt = path.join(tmp, 'guard-b.txt');
      const cTxt = path.join(tmp, 'guard-c.txt');
      const dTxt = path.join(tmp, 'guard-d.txt');
      for (const [file, value] of [
        [aTxt, 'a1'],
        [bTxt, 'b1'],
        [cTxt, 'c1'],
        [dTxt, 'd1'],
      ] as const) {
        await fs.writeFile(file, value, 'utf8');
      }

      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: aTxt, action: 'modified', before: 'a0', after: 'a1' }]),
        makeCheckpoint(1, 'p1'),
        makeFileSnapshot(1, [{ path: bTxt, action: 'modified', before: 'b0', after: 'b1' }]),
        branchCreated('br-x'),
        branchSwitched('main', 'br-x'),
        branchCheckpoint('br-x', 0, 'x prompt'),
        branchSnapshot('br-x', 0, [{ path: cTxt, action: 'modified', before: 'c0', after: 'c1' }]),
        branchSwitched('br-x', 'main'),
        makeCheckpoint(2, 'p2'),
        makeFileSnapshot(2, [{ path: dTxt, action: 'modified', before: 'd0', after: 'd1' }]),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      await expect(rewind.rewindLastN(id, 2)).rejects.toThrow(/other session branches/);

      // The refused rewind changed nothing on disk.
      expect(await fs.readFile(aTxt, 'utf8')).toBe('a1');
      expect(await fs.readFile(bTxt, 'utf8')).toBe('b1');
      expect(await fs.readFile(cTxt, 'utf8')).toBe('c1');
      expect(await fs.readFile(dTxt, 'utf8')).toBe('d1');
    });

    const branchInput = (branchId: string | undefined, text: string) => ({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: [
        { type: 'text', text },
        ...(branchId === 'main'
          ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }]
          : []),
      ],
      ...(branchId && branchId !== 'main' ? { branchId } : {}),
    });

    it('hands back only the rewound branch’s own prompt when branches interleave', async () => {
      // br-explore prompt 0, back to main for a prompt (with an image), then
      // br-explore again: the line just before br-explore's checkpoint 1 is
      // main's prompt. Rewinding br-explore to 1 (and promptAt) must return
      // br-explore's own prompt and its attachment flag, never main's.
      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        branchCreated('br-explore'),
        branchSwitched('main', 'br-explore'),
        branchInput('br-explore', 'explore prompt 0'),
        branchCheckpoint('br-explore', 0, 'explore prompt 0'),
        branchSwitched('br-explore', 'main'),
        branchInput('main', 'main prompt 1'),
        makeCheckpoint(1, 'main prompt 1'),
        branchSwitched('main', 'br-explore'),
        branchInput('br-explore', 'explore prompt 1'),
        branchInput('main', 'late main line'),
        branchCheckpoint('br-explore', 1, 'explore prompt 1'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);

      expect(await rewind.promptAt(id, 1)).toBe('explore prompt 1');
      expect(await rewind.promptAt(id, 0)).toBe('explore prompt 0');
      const result = await rewind.rewindToCheckpoint(id, 1);
      expect(result.promptText).toBe('explore prompt 1');
      expect(result.promptHasAttachments).toBe(false);
    });

    it('never borrows another branch’s prompt when the rewound checkpoint has no input of its own', async () => {
      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        branchCreated('br-explore'),
        branchSwitched('main', 'br-explore'),
        branchSwitched('br-explore', 'main'),
        branchInput('main', 'main prompt 1'),
        makeCheckpoint(1, 'main prompt 1'),
        branchSwitched('main', 'br-explore'),
        // Legacy-style checkpoint without a recorded input on br-explore.
        branchCheckpoint('br-explore', 0, 'explore prompt 0'),
      ]);
      const rewind = new DefaultSessionRewinder(tmp, tmp);

      expect(await rewind.promptAt(id, 0)).toBeUndefined();
      const result = await rewind.rewindToCheckpoint(id, 0);
      expect(result.promptText).toBeUndefined();
      expect(result.promptHasAttachments).toBeUndefined();
    });

    it('refuses a rewind to the session start and reverts no file of any branch', async () => {
      // main edits a.txt, br-x edits b.txt, and the journal ends back on main.
      // `/rewind --all` would restore br-x's b.txt and cut br-x's events
      // (which the writer then refuses), so it must throw before any revert.
      const aTxt = path.join(tmp, 'start-a.txt');
      const bTxt = path.join(tmp, 'start-b.txt');
      await fs.writeFile(aTxt, 'a1', 'utf8');
      await fs.writeFile(bTxt, 'b1', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'p0'),
        makeFileSnapshot(0, [{ path: aTxt, action: 'modified', before: 'a0', after: 'a1' }]),
        branchCreated('br-x'),
        branchSwitched('main', 'br-x'),
        branchCheckpoint('br-x', 0, 'x prompt'),
        branchSnapshot('br-x', 0, [{ path: bTxt, action: 'modified', before: 'b0', after: 'b1' }]),
        branchSwitched('br-x', 'main'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      await expect(rewind.rewindToStart(id)).rejects.toMatchObject({
        code: 'SESSION_WRITE_FAILED',
        message: expect.stringMatching(/other session branches/),
      });
      expect(await fs.readFile(aTxt, 'utf8')).toBe('a1');
      expect(await fs.readFile(bTxt, 'utf8')).toBe('b1');
    });
  });

  describe('rewindToStart', () => {
    it('reverts all changes to session start', async () => {
      const testFile = path.join(tmp, 'test.txt');
      await fs.writeFile(testFile, 'original', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'start'),
        makeFileSnapshot(1, [
          { path: testFile, action: 'modified', before: 'original', after: 'changed' },
        ]),
        makeCheckpoint(1, 'after change'),
        makeFileSnapshot(2, [
          { path: testFile, action: 'modified', before: 'changed', after: 'changed2' },
        ]),
        makeCheckpoint(2, 'final'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToStart(id);

      expect(result.revertedFiles).toContain(testFile);
      const content = await fs.readFile(testFile, 'utf8');
      expect(content).toBe('original');
    });

    it('handles multiple file changes', async () => {
      const file1 = path.join(tmp, 'file1.txt');
      const file2 = path.join(tmp, 'file2.txt');
      await fs.writeFile(file1, 'f1v0', 'utf8');
      await fs.writeFile(file2, 'f2v0', 'utf8');

      const id = await writeSession([
        makeCheckpoint(0, 'start'),
        makeFileSnapshot(1, [
          { path: file1, action: 'modified', before: 'f1v0', after: 'f1v1' },
          { path: file2, action: 'modified', before: 'f2v0', after: 'f2v1' },
        ]),
        makeCheckpoint(1, 'after'),
      ]);

      const rewind = new DefaultSessionRewinder(tmp, tmp);
      const result = await rewind.rewindToStart(id);

      expect(result.revertedFiles).toContain(file1);
      expect(result.revertedFiles).toContain(file2);
      expect(await fs.readFile(file1, 'utf8')).toBe('f1v0');
      expect(await fs.readFile(file2, 'utf8')).toBe('f2v0');
    });
  });

  describe('truncateToCheckpoint', () => {
    async function makeSessionStore(tmpDir: string) {
      const { DefaultSessionStore } = await import('../../src/storage/session-store.js');
      return new DefaultSessionStore({ dir: tmpDir });
    }

    it('removes events after target promptIndex', async () => {
      const store = await makeSessionStore(tmp);
      const writer = await store.create({ id: 's1', model: 'gpt4', provider: 'openai' });

      // promptIndex 0: user_input + llm_response + checkpoint
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'first' });
      await writer.append({
        type: 'llm_response',
        ts: '2024-01-01T00:00:01Z',
        content: [],
        stopReason: 'end_turn',
        usage: { input: 10, output: 20 },
      });
      await writer.writeCheckpoint(0, 'first prompt');

      // promptIndex 1
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:02Z', content: 'second' });
      await writer.append({
        type: 'llm_response',
        ts: '2024-01-01T00:00:03Z',
        content: [],
        stopReason: 'end_turn',
        usage: { input: 30, output: 40 },
      });
      await writer.writeCheckpoint(1, 'second prompt');

      // promptIndex 2
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:04Z', content: 'third' });
      await writer.append({
        type: 'llm_response',
        ts: '2024-01-01T00:00:05Z',
        content: [],
        stopReason: 'end_turn',
        usage: { input: 50, output: 60 },
      });
      await writer.writeCheckpoint(2, 'third prompt');

      await writer.close();

      // Reload and truncate
      const store2 = await makeSessionStore(tmp);
      const writer2 = await (await store2.resume('s1')).writer;
      const removed = await writer2.truncateToCheckpoint(1);
      await writer2.close();

      // Verify remaining events
      const data = await store2.load('s1');
      expect(data.events.filter((e) => e.type === 'user_input')).toHaveLength(2); // first + second
      expect(removed).toBeGreaterThan(0);
    });

    it('writes rewound event after truncate', async () => {
      const store = await makeSessionStore(tmp);
      const writer = await store.create({ id: 's2', model: 'gpt4', provider: 'openai' });
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:00Z', content: 'first' });
      await writer.writeCheckpoint(0, 'first');
      await writer.append({ type: 'user_input', ts: '2024-01-01T00:00:01Z', content: 'second' });
      await writer.writeCheckpoint(1, 'second');
      await writer.close();

      const store2 = await makeSessionStore(tmp);
      const writer2 = await (await store2.resume('s2')).writer;
      await writer2.truncateToCheckpoint(0);
      await writer2.close();

      const data = await store2.load('s2');
      const rewound = data.events.find((e) => e.type === 'rewound');
      expect(rewound).toBeDefined();
      expect((rewound as { toPromptIndex: number }).toPromptIndex).toBe(0);
    });

    it('returns 0 when no filePath', async () => {
      const store = await makeSessionStore(tmp);
      const writer = await store.create({ id: 's3', model: 'gpt4', provider: 'openai' });
      const removed = await writer.truncateToCheckpoint(0);
      await writer.close();
      expect(removed).toBe(0);
    });
  });
});
