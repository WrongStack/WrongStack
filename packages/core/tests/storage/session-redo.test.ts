/**
 * `/redo` undoes `/rewind`: the rewound file changes come back and the
 * journal is restored byte for byte. It refuses (and changes nothing) when a
 * file was edited after the rewind, and a new prompt ends the redo history.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionWriter } from '@wrongstack/contracts/types/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSessionRewinder, DefaultSessionStore } from '../../src/index.js';
import {
  applyRewindToConversation,
  redoLastRewind,
} from '../../src/storage/session-rewind-apply.js';

let root: string;
let sessionsDir: string;
let fileA: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-redo-')));
  sessionsDir = path.join(root, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  fileA = path.join(root, 'project', 'a.txt');
  await fs.mkdir(path.dirname(fileA), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ts = () => new Date().toISOString();
const state = () => ({ replaceMessages: vi.fn() });

/** Prompt `n`: user turn, checkpoint, a file change on disk and in the journal. */
async function prompt(writer: SessionWriter, n: number, before: string | null, after: string) {
  await writer.append({ type: 'user_input', ts: ts(), content: `prompt ${n}` });
  await writer.append({
    type: 'message_appended',
    ts: ts(),
    version: 1,
    message: { role: 'user', content: [{ type: 'text', text: `prompt ${n}` }] },
  } as never);
  await writer.writeCheckpoint(n, `prompt ${n}`);
  await fs.writeFile(fileA, after);
  await writer.writeFileSnapshot(n, [
    { path: fileA, action: before === null ? 'created' : 'modified', before, after },
  ]);
  await writer.flush();
}

async function rewind(writer: SessionWriter, to: number) {
  const reverted = await new DefaultSessionRewinder(sessionsDir, root).rewindToCheckpoint(
    writer.id,
    to,
  );
  await applyRewindToConversation({
    session: writer,
    state: state(),
    sessionsDir,
    promptIndex: to,
    revertedFiles: reverted.revertedFiles,
  });
}

const journalPath = (writer: SessionWriter) => path.join(sessionsDir, `${writer.id}.jsonl`);
const journal = (writer: SessionWriter) => fs.readFile(journalPath(writer), 'utf8');
const redo = (
  writer: SessionWriter,
  onMessagesReplaced?: Parameters<typeof redoLastRewind>[0]['onMessagesReplaced'],
) =>
  redoLastRewind({
    session: writer,
    state: state(),
    sessionsDir,
    projectRoot: root,
    onMessagesReplaced,
  });

describe('redoLastRewind', () => {
  it('puts back the rewound file change and the journal, byte for byte', async () => {
    const writer = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'redo-a',
      model: 'm',
      provider: 'p',
    });
    await prompt(writer, 0, null, 'one');
    await prompt(writer, 1, 'one', 'two');
    const before = await journal(writer);

    await rewind(writer, 1);
    expect(await fs.readFile(fileA, 'utf8')).toBe('one');
    expect(await journal(writer)).not.toBe(before);

    const onMessagesReplaced = vi.fn();
    const result = await redo(writer, onMessagesReplaced);
    expect(result?.conflicts).toEqual([]);
    expect(result?.reappliedFiles).toEqual([fileA]);
    expect(await fs.readFile(fileA, 'utf8')).toBe('two');
    expect((await journal(writer)).startsWith(before)).toBe(true);
    expect(onMessagesReplaced).toHaveBeenCalledWith(result?.conversation?.messages);
    // Nothing left to redo.
    expect(await redo(writer)).toBeNull();
    await writer.close();
  });

  it('refuses without changing anything when a file was edited after the rewind', async () => {
    const writer = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'redo-b',
      model: 'm',
      provider: 'p',
    });
    await prompt(writer, 0, null, 'one');
    await prompt(writer, 1, 'one', 'two');
    await rewind(writer, 1);
    await fs.writeFile(fileA, 'edited by hand');
    const journalAfterRewind = await journal(writer);

    const result = await redo(writer);
    expect(result?.conflicts.join()).toMatch(/changed since the rewind/);
    expect(result?.restoredEvents).toBe(0);
    expect(await fs.readFile(fileA, 'utf8')).toBe('edited by hand');
    expect(await journal(writer)).toBe(journalAfterRewind);
    await writer.close();
  });

  it('refuses when the kept part of the journal changed after the rewind', async () => {
    const writer = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'redo-f',
      model: 'm',
      provider: 'p',
    });
    await prompt(writer, 0, null, 'one');
    await prompt(writer, 1, 'one', 'two');
    await rewind(writer, 1);
    // Something rewrote history the rewind kept (another tool, a bad merge).
    const file = journalPath(writer);
    const content = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, content.replace('prompt 0', 'prompt X'));

    expect(await redo(writer)).toBeNull();
    expect(await fs.readFile(fileA, 'utf8')).toBe('one');
    await writer.close();
  });

  it('a new prompt ends the redo history', async () => {
    const writer = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'redo-c',
      model: 'm',
      provider: 'p',
    });
    await prompt(writer, 0, null, 'one');
    await prompt(writer, 1, 'one', 'two');
    await rewind(writer, 1);
    await prompt(writer, 1, 'one', 'three');
    expect(await redo(writer)).toBeNull();
    await writer.close();
  });

  it('two rewinds are redone newest first, back to the original', async () => {
    const writer = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'redo-d',
      model: 'm',
      provider: 'p',
    });
    await prompt(writer, 0, null, 'one');
    await prompt(writer, 1, 'one', 'two');
    await prompt(writer, 2, 'two', 'three');
    const before = await journal(writer);

    await rewind(writer, 2);
    await rewind(writer, 1);
    expect(await fs.readFile(fileA, 'utf8')).toBe('one');

    expect((await redo(writer))?.toPromptIndex).toBe(1);
    expect(await fs.readFile(fileA, 'utf8')).toBe('two');
    expect((await redo(writer))?.toPromptIndex).toBe(2);
    expect(await fs.readFile(fileA, 'utf8')).toBe('three');
    expect((await journal(writer)).startsWith(before)).toBe(true);
    await writer.close();
  });

  it('keeps a rewound subagent transcript for the redo instead of deleting it', async () => {
    const emit = vi.fn();
    const writer = await new DefaultSessionStore({ dir: sessionsDir, events: { emit } }).create({
      id: 'redo-e',
      model: 'm',
      provider: 'p',
    });
    await prompt(writer, 0, null, 'one');
    const transcript = path.join(sessionsDir, 'subagents', 'child.jsonl');
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, '{"type":"session_start"}\n');
    await writer.append({ type: 'user_input', ts: ts(), content: 'prompt 1' });
    await writer.writeCheckpoint(1, 'prompt 1');
    await writer.append({
      type: 'agent_session_linked',
      ts: ts(),
      agentId: 'child',
      agentSessionId: 'child',
      transcriptPath: transcript,
    } as never);
    await writer.flush();

    await rewind(writer, 1);
    await expect(fs.access(transcript)).rejects.toThrow();
    // Stashed, not deleted: no deletion event claims it.
    expect(emit.mock.calls.map((c) => c[0])).not.toContain('session.rewind_subagents_deleted');
    await redo(writer);
    expect(await fs.readFile(transcript, 'utf8')).toContain('session_start');
    await writer.close();
  });
});
