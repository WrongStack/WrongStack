import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which session `--resume` (no id) and `--recover` land on.
 *
 * The two switches existed as parsed-but-unread booleans, so `wstack --recover`
 * silently started a brand-new session — the one moment a user is certain they
 * want the previous one back. The pick has three rules and each of them has
 * cost someone a conversation:
 *
 *  1. `--recover` means UNCLOSED, not "most recent". The last session may well
 *     have ended cleanly; the one that crashed is the one to reopen.
 *  2. Never a session another process is writing to. Two writers on one JSONL
 *     interleave two runtimes into one transcript.
 *  3. Never an error. Finding nothing means "start fresh", which is what the
 *     boot would have done anyway.
 */

const registryEntries: Array<{ sessionId: string }> = [];
vi.mock('@wrongstack/core/storage', async () => {
  const actual = await vi.importActual<typeof import('@wrongstack/core/storage')>(
    '@wrongstack/core/storage',
  );
  return {
    ...actual,
    getSessionRegistry: () => ({ list: async () => registryEntries }),
  };
});

const { pickResumeCandidate } = await import('../src/wiring/resume-candidate.js');

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-candidate-'));
  registryEntries.length = 0;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLog(sessionId: string, events: unknown[], mtimeMs?: number): Promise<void> {
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  if (mtimeMs !== undefined) await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

const start = (id: string) => ({ type: 'session_start', ts: '2026-01-01T00:00:00Z', id });
const CLEAN = { type: 'session_end', ts: '2026-01-01T00:01:00Z' };
const HUNG = { type: 'in_flight_end', ts: '2026-01-01T00:01:00Z', reason: 'clean' };

function options(unclosedOnly: boolean, list: Array<{ id: string; messageCount?: number }> = []) {
  return {
    sessionsDir: dir,
    globalRoot: path.join(dir, '.global'),
    sessionStore: { list: async () => list as never },
    unclosedOnly,
  };
}

describe('pickResumeCandidate', () => {
  it('--recover picks the newest UNCLOSED session, not the newest session', async () => {
    await writeLog('crashed', [start('crashed'), HUNG], Date.UTC(2026, 0, 1));
    await writeLog('finished', [start('finished'), CLEAN], Date.UTC(2026, 0, 2));

    expect(await pickResumeCandidate(options(true))).toBe('crashed');
  });

  it('--recover skips a session another process is still writing to', async () => {
    await writeLog('held', [start('held'), HUNG], Date.UTC(2026, 0, 2));
    await writeLog('free', [start('free'), HUNG], Date.UTC(2026, 0, 1));
    registryEntries.push({ sessionId: 'held' });

    expect(await pickResumeCandidate(options(true))).toBe('free');
  });

  it('--recover returns nothing when every session ended cleanly', async () => {
    await writeLog('finished', [start('finished'), CLEAN]);

    expect(await pickResumeCandidate(options(true))).toBeUndefined();
  });

  it('bare --resume takes the newest session with something in it', async () => {
    const list = [
      { id: 'empty-launch', messageCount: 0 },
      { id: 'real', messageCount: 12 },
    ];

    // A launch that got a writer and never a prompt reads exactly like a fresh
    // start; resuming it costs a claim and a transcript read for nothing.
    expect(await pickResumeCandidate(options(false, list))).toBe('real');
  });

  it('bare --resume also refuses a session held by another process', async () => {
    registryEntries.push({ sessionId: 'real' });
    const list = [
      { id: 'real', messageCount: 12 },
      { id: 'older', messageCount: 3 },
    ];

    expect(await pickResumeCandidate(options(false, list))).toBe('older');
  });
});

describe('announceRecoverableSession', () => {
  const announce = async () => {
    const { announceRecoverableSession } = await import('../src/wiring/resume-candidate.js');
    const hints: string[] = [];
    await announceRecoverableSession({
      sessionsDir: dir,
      globalRoot: path.join(dir, '.global'),
      onHint: (m) => hints.push(m),
    });
    return hints;
  };

  it('names the unclosed session and how it stopped', async () => {
    await writeLog('crashed', [start('crashed')], Date.now());

    const hints = await announce();
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('crashed');
    expect(hints[0]).toContain('--recover');
  });

  it('says nothing about a session that closed its log', async () => {
    await writeLog('finished', [start('finished'), CLEAN], Date.now());

    expect(await announce()).toEqual([]);
  });

  it('says nothing about a hung session from days ago', async () => {
    // A crash the user has already moved on from is history. Announcing it on
    // every launch forever is noise, and noise is how a real one gets ignored.
    await writeLog('ancient', [start('ancient'), HUNG], Date.now() - 3 * 24 * 60 * 60 * 1000);

    expect(await announce()).toEqual([]);
  });

  it('says nothing about a session another process is still writing', async () => {
    await writeLog('held', [start('held'), HUNG], Date.now());
    registryEntries.push({ sessionId: 'held' });

    expect(await announce()).toEqual([]);
  });
});
