import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSessionCheckpointTruncatePlan,
  rewriteSessionToCheckpoint,
} from '../../src/storage/session-writer-truncate.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  );
});

async function writeSession(lines: readonly string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writer-truncate-'));
  dirs.push(dir);
  const filePath = path.join(dir, '2026-08-29', 'session.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((line) => `${line}\n`).join(''), 'utf8');
  return filePath;
}

const linked = (transcriptPath: string): string =>
  JSON.stringify({ type: 'agent_session_linked', transcriptPath });
const checkpoint = (promptIndex: number): string =>
  JSON.stringify({ type: 'checkpoint', promptIndex });
const userLine = (content: string): string =>
  JSON.stringify({ type: 'user_input', content });

describe('findSessionCheckpointTruncatePlan', () => {
  it('keeps transcripts still referenced by the retained history (outside-window binding)', async () => {
    // alpha is linked BEFORE the checkpoint (its event survives the rewind)
    // and re-linked INSIDE the removed window; the transcript file must be
    // kept because the retained history still points at it. beta is only
    // referenced inside the removed window, so it is safe to delete.
    const filePath = await writeSession([
      linked('sub-agents/alpha.jsonl'),
      checkpoint(0),
      userLine('turn 1'),
      linked('sub-agents/alpha.jsonl'),
      linked('sub-agents/beta.jsonl'),
      userLine('turn 2'),
    ]);

    const plan = await findSessionCheckpointTruncatePlan(filePath, 0);

    expect(plan).not.toBeNull();
    expect(plan?.checkpointByteOffset).toBeGreaterThan(0);
    expect(plan?.removedCount).toBe(4);
    expect(plan?.removedSubagentTranscriptPaths).toEqual(['sub-agents/beta.jsonl']);
  });

  it('lists transcripts that are only referenced by the removed window', async () => {
    const filePath = await writeSession([
      checkpoint(0),
      userLine('turn 1'),
      linked('sub-agents/gamma.jsonl'),
      userLine('turn 2'),
    ]);

    const plan = await findSessionCheckpointTruncatePlan(filePath, 0);

    expect(plan?.removedSubagentTranscriptPaths).toEqual(['sub-agents/gamma.jsonl']);
  });
});

describe('rewriteSessionToCheckpoint', () => {
  it('keeps the retained prefix (including the surviving transcript link)', async () => {
    const filePath = await writeSession([
      linked('sub-agents/alpha.jsonl'),
      checkpoint(0),
      userLine('turn 1'),
      linked('sub-agents/beta.jsonl'),
      userLine('turn 2'),
    ]);

    const plan = await findSessionCheckpointTruncatePlan(filePath, 0);
    if (!plan) throw new Error('expected a truncate plan');
    await rewriteSessionToCheckpoint(filePath, plan.checkpointByteOffset);

    const text = await fs.readFile(filePath, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('sub-agents/alpha.jsonl');
    expect(lines[1]).toContain('"promptIndex":0');
    expect(text).not.toContain('beta.jsonl');
  });
});
