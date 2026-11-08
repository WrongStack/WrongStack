/**
 * Which agent session each WrongStack session was led by, so a resumed
 * WrongStack session continues the agent's own conversation (`session/resume`)
 * instead of starting it over from a text recap. Kept per project, next to the
 * project's sessions; best-effort: a lost record only costs the recap path.
 */
import { mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';

const FILE = 'acp-leader-sessions.json';
/** Newest records kept; older WrongStack sessions start the agent afresh. */
const MAX_RECORDS = 200;

export interface LeaderSessionRecord {
  agentId: string;
  agentSessionId: string;
  updatedAt: string;
}

type Records = Record<string, LeaderSessionRecord>;

async function readRecords(stateDir: string): Promise<Records> {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, FILE), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, record]) =>
          record &&
          typeof record === 'object' &&
          typeof record.agentId === 'string' &&
          typeof record.agentSessionId === 'string' &&
          typeof record.updatedAt === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** The agent session that led `sessionId` with `agentId`, if one is on record. */
export async function readLeaderSession(
  stateDir: string,
  sessionId: string,
  agentId: string,
): Promise<string | undefined> {
  const record = (await readRecords(stateDir))[sessionId];
  return record?.agentId === agentId && typeof record.agentSessionId === 'string'
    ? record.agentSessionId
    : undefined;
}

let writing: Promise<void> = Promise.resolve();

/** Remember that `agentSessionId` leads `sessionId`. Writes are serialized and atomic. */
export function writeLeaderSession(
  stateDir: string,
  sessionId: string,
  record: Omit<LeaderSessionRecord, 'updatedAt'>,
): Promise<void> {
  writing = writing
    .catch(() => undefined)
    .then(async () => {
      const records = await readRecords(stateDir);
      records[sessionId] = { ...record, updatedAt: new Date().toISOString() };
      const kept = Object.entries(records)
        .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_RECORDS);
      await mkdir(stateDir, { recursive: true });
      await atomicWrite(
        path.join(stateDir, FILE),
        `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`,
      );
    });
  return writing.catch(() => undefined);
}
