import * as path from 'node:path';
import type * as http from 'node:http';
import {
  buildTranscriptFromEvents,
  resolveHqDataDir,
  type HqTranscriptEntry,
} from '@wrongstack/core/hq';
import type { TranscriptRing } from '../types.js';
import {
  agentRingKey,
  decodePathSegment,
  readLocalSubagentTranscript,
  sanitizeApiError,
} from '../utils.js';

export async function handleApiSessions(res: http.ServerResponse): Promise<void> {
  const { SessionRegistry } = await import('@wrongstack/core/storage');
  const globalRoot = path.dirname(resolveHqDataDir());
  try {
    const registry = new SessionRegistry(globalRoot);
    const sessions = (await registry.list()) as unknown as Array<Record<string, unknown>>;
    const result = sessions
      .filter((s: { status?: string }) => s.status !== 'stale')
      .map((s: Record<string, unknown>) => ({
        sessionId: s.sessionId,
        projectSlug: s.projectSlug,
        projectName: s.projectName,
        projectRoot: s.projectRoot,
        workingDir: s.workingDir,
        status: s.status,
        pid: s.pid,
        startedAt: s.startedAt,
        lastHeartbeatAt: s.lastHeartbeatAt,
        agentCount: s.agentCount,
        agents: (s.agents as Array<Record<string, unknown>>).map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          currentTool: a.currentTool,
          iterations: a.iterations,
          toolCalls: a.toolCalls,
          lastActivityAt: a.lastActivityAt,
        })),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

export async function handleApiSessionEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  transcripts: Map<string, TranscriptRing>,
): Promise<void> {
  const { SessionRegistry, DefaultSessionStore } = await import('@wrongstack/core/storage');
  const { resolveWstackPaths } = await import('@wrongstack/core/utils');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const full = url.searchParams.get('full') === '1';
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  const sessionId = decodePathSegment(match[1]!);
  if (sessionId === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid sessionId encoding' }));
    return;
  }

  const globalRoot = path.dirname(resolveHqDataDir());
  try {
    const registry = new SessionRegistry(globalRoot);
    const entry = await registry.get(sessionId).catch(() => null);

    let entries: HqTranscriptEntry[] = [];
    let source: 'disk' | 'stream' = 'stream';
    let status: string | undefined;
    let clientType: string | undefined;
    let projectName: string | undefined;

    if (entry && 'projectRoot' in entry) {
      const paths = resolveWstackPaths({
        projectRoot: (entry as { projectRoot: string }).projectRoot,
        globalRoot,
      });
      const store = new DefaultSessionStore({ dir: paths.projectSessions });
      const data = await store.load(sessionId).catch(() => null);
      if (data) {
        entries = buildTranscriptFromEvents(
          (data.events as unknown[]).map((e) => e as Record<string, unknown>),
        );
        source = 'disk';
        status = (entry as { status?: string }).status;
        clientType = (entry as { clientType?: string }).clientType;
        projectName = (entry as { projectName?: string }).projectName;
      }
    }

    if (entries.length === 0) {
      const ring = transcripts.get(sessionId);
      if (!ring && !entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      entries = ring ? ring.entries : [];
      source = 'stream';
      if (entry) {
        status = (entry as { status?: string }).status;
        clientType = (entry as { clientType?: string }).clientType;
        projectName = (entry as { projectName?: string }).projectName;
      }
    }

    const total = entries.length;
    const tail = full ? entries : entries.slice(-limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessionId,
        source,
        ...(status !== undefined ? { status } : {}),
        ...(clientType !== undefined ? { clientType } : {}),
        ...(projectName !== undefined ? { projectName } : {}),
        total,
        entries: tail,
      }),
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: sanitizeApiError(err) }));
  }
}

export async function handleApiSessionAgentMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  agentMessages: Map<string, HqTranscriptEntry[]>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sid = decodePathSegment(match[1]!);
  const aid = decodePathSegment(match[2]!);
  if (sid === null || aid === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session or agent id encoding' }));
    return;
  }
  const full = url.searchParams.get('full') === '1';
  const disk = await readLocalSubagentTranscript(sid, aid);
  const source: 'disk' | 'stream' = disk !== null ? 'disk' : 'stream';
  const all =
    disk !== null ? disk : (agentMessages.get(agentRingKey(sid, aid)) ?? agentMessages.get(aid) ?? []);
  const entries = full ? all : all.slice(-200);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ subagentId: aid, sessionId: sid, source, total: all.length, entries }));
}

export async function handleApiAgentMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray,
  agentMessages: Map<string, HqTranscriptEntry[]>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const id = decodePathSegment(match[1]!);
  if (id === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid agent id encoding' }));
    return;
  }
  const full = url.searchParams.get('full') === '1';
  const merged: HqTranscriptEntry[] = [];
  for (const [key, ring] of agentMessages) {
    if (key === id || key.endsWith(`::${id}`)) merged.push(...ring);
  }
  merged.sort((a, b) => a.ts.localeCompare(b.ts));
  const entries = full ? merged : merged.slice(-200);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ subagentId: id, total: merged.length, entries }));
}
