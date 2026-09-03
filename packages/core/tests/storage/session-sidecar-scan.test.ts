/**
 * Sidecar JSONLs must not be mistaken for session transcripts.
 *
 * `ReplayLogStore` and `ToolAuditLog` write `<id>.replay.jsonl` /
 * `<id>.audit.jsonl` next to the transcript, and the mailbox writes
 * `_mailbox.jsonl` into the same directory. Every directory scan used to
 * answer "is this a session?" for itself, and only `SessionRecovery` filtered
 * them: the store's scans excluded `_index.jsonl` and nothing else. So one
 * real session with a replay log appeared as three, in the picker and in
 * `_index.jsonl`, and its id stopped being a unique prefix.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { SessionRecovery } from '../../src/storage/session-recovery.js';
import { isSessionTranscriptFileName } from '../../src/utils/session-scoped-path.js';

let tmp: string;
let store: DefaultSessionStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sidecar-scan-'));
  store = new DefaultSessionStore({ dir: tmp });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeSidecars(base: string): Promise<void> {
  await fs.writeFile(path.join(tmp, `${base}.replay.jsonl`), '{"hash":"sha256:x"}\n');
  await fs.writeFile(path.join(tmp, `${base}.audit.jsonl`), '{"tool":"read"}\n');
  await fs.writeFile(path.join(tmp, '_mailbox.jsonl'), '{"to":"leader"}\n');
}

describe('session directory scans — sidecar exclusion', () => {
  it('classifies transcripts and sidecars', () => {
    expect(isSessionTranscriptFileName('sess_abc.jsonl')).toBe(true);
    expect(isSessionTranscriptFileName('sess_abc.jsonl.gz')).toBe(true);
    expect(isSessionTranscriptFileName('SESS_ABC.JSONL.GZ')).toBe(true);
    expect(isSessionTranscriptFileName('2026-06-11/sess_abc.jsonl')).toBe(true);
    expect(isSessionTranscriptFileName('sess_abc.replay.jsonl.gz')).toBe(false);
    expect(isSessionTranscriptFileName('sess_abc.REPLAY.jsonl')).toBe(false);
    expect(isSessionTranscriptFileName('sess_abc.replay.jsonl')).toBe(false);
    expect(isSessionTranscriptFileName('sess_abc.audit.jsonl')).toBe(false);
    expect(isSessionTranscriptFileName('sess_abc.annotations.jsonl')).toBe(false);
    expect(isSessionTranscriptFileName('_index.jsonl')).toBe(false);
    expect(isSessionTranscriptFileName('_mailbox.jsonl')).toBe(false);
    expect(isSessionTranscriptFileName('sess_abc.summary.json')).toBe(false);
  });

  it('keeps sidecars out of list(), rebuildIndex() and id resolution', async () => {
    const writer = await store.create({ id: 'sess_abc', model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hi' });
    await writer.close();
    await writeSidecars('sess_abc');

    expect(await store.rebuildIndex()).toBe(1);
    expect((await store.list(50)).map((s) => s.id)).toEqual(['sess_abc']);
    // A prefix that is unique among transcripts must stay unique: the sidecars
    // used to join the candidate set and make this throw as ambiguous.
    expect(await store.resolveId('sess_ab')).toBe('sess_abc');
  });

  it('keeps sidecars out of the crash-recovery scan', async () => {
    const writer = await store.create({ id: 'sess_live', model: 'm', provider: 'p' });
    await writer.writeInFlightMarker('iteration 1 / tool: bash');
    await writer.flush();
    await writeSidecars('sess_live');

    const resumable = await new SessionRecovery(tmp).listResumable();
    expect(resumable.map((s) => s.sessionId)).toEqual(['sess_live']);
    await writer.close();
  });
});
