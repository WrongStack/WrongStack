/**
 * HQ serves the FULL on-disk subagent transcript for local sessions (not just
 * the ≤4000-entry live ring), by reading the agent monitor's
 * <projectSessions>/<sessionId>/subagents/transcripts/<subId>/transcript.jsonl.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRegistry } from '@wrongstack/core/storage';
import { resolveWstackPaths, sessionScopedPath } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLocalSubagentTranscript } from '../src/hq-server.js';

let tmp: string;
let prevEnv: string | undefined;
let registries: SessionRegistry[];
let catalogProjects: Array<{ projectDir: string; projectRoot: string }>;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-disk-'));
  prevEnv = process.env['WRONGSTACK_HQ_DATA_DIR'];
  // globalRoot = dirname(resolveHqDataDir()) → set data dir under tmp so
  // globalRoot === tmp.
  process.env['WRONGSTACK_HQ_DATA_DIR'] = path.join(tmp, 'hq');
  registries = [];
  catalogProjects = [];
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env['WRONGSTACK_HQ_DATA_DIR'];
  else process.env['WRONGSTACK_HQ_DATA_DIR'] = prevEnv;
  await Promise.all(registries.map((registry) => registry.dispose()));
  const { SessionCatalogProjectClient } = await import('@wrongstack/core/session-catalog');
  await Promise.all(
    catalogProjects.map(({ projectDir, projectRoot }) =>
      new SessionCatalogProjectClient({ projectDir, projectRoot }).shutdown('test cleanup'),
    ),
  );
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('readLocalSubagentTranscript', () => {
  it('returns the full disk transcript for a registered local session', async () => {
    const globalRoot = tmp;
    const projectRoot = path.join(tmp, 'proj');
    const sessionId = '2026-07-10/sess_TESTDISK01';
    const subId = 'bug-hunter-abc123';

    // Register the session so HQ recognizes it as local.
    const registry = new SessionRegistry(globalRoot);
    registries.push(registry);
    catalogProjects.push({ projectDir: path.join(globalRoot, 'projects', 'proj-x'), projectRoot });
    await registry.register({
      sessionId,
      projectSlug: 'proj-x',
      projectRoot,
      projectName: 'proj',
      workingDir: projectRoot,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    // Write the subagent transcript exactly where the agent monitor does.
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const dir = path.join(
      sessionScopedPath(paths.projectSessions, sessionId, ''),
      'subagents',
      'transcripts',
      subId,
    );
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      {
        id: '1',
        subagentId: subId,
        agentName: 'bug-hunter',
        ts: '2026-07-10T00:00:01.000Z',
        kind: 'system',
        content: '🤖 Agent spawned',
        iteration: 0,
      },
      {
        id: '2',
        subagentId: subId,
        agentName: 'bug-hunter',
        ts: '2026-07-10T00:00:02.000Z',
        kind: 'text',
        content: 'looking into it',
        iteration: 1,
      },
      {
        id: '3',
        subagentId: subId,
        agentName: 'bug-hunter',
        ts: '2026-07-10T00:00:03.000Z',
        kind: 'tool_use',
        content: 'grep foo',
        iteration: 1,
        toolName: 'grep',
      },
      {
        id: '4',
        subagentId: subId,
        agentName: 'bug-hunter',
        ts: '2026-07-10T00:00:04.000Z',
        kind: 'text',
        content: 'found it',
        iteration: 2,
      },
    ];
    await fs.writeFile(
      dir + '/transcript.jsonl',
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );

    const entries = await readLocalSubagentTranscript(sessionId, subId);
    expect(entries).not.toBeNull();
    expect(entries!).toHaveLength(4);
    expect(entries![0]).toMatchObject({ role: 'system', text: '🤖 Agent spawned' });
    expect(entries![1]).toMatchObject({ role: 'assistant', text: 'looking into it' });
    expect(entries![2]).toMatchObject({ role: 'tool', tool: 'grep' });
    expect(entries![3]).toMatchObject({ role: 'assistant', text: 'found it' });
  });

  it('returns null for a session that is not registered locally (remote)', async () => {
    const entries = await readLocalSubagentTranscript('2026-07-10/sess_NOTLOCAL', 'agent-x');
    expect(entries).toBeNull();
  });

  it('tolerates a torn trailing line', async () => {
    const globalRoot = tmp;
    const projectRoot = path.join(tmp, 'proj2');
    const sessionId = '2026-07-10/sess_TORN01';
    const subId = 'critic-def456';
    const registry = new SessionRegistry(globalRoot);
    registries.push(registry);
    catalogProjects.push({ projectDir: path.join(globalRoot, 'projects', 'proj-y'), projectRoot });
    await registry.register({
      sessionId,
      projectSlug: 'proj-y',
      projectRoot,
      projectName: 'proj2',
      workingDir: projectRoot,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const dir = path.join(
      sessionScopedPath(paths.projectSessions, sessionId, ''),
      'subagents',
      'transcripts',
      subId,
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      dir + '/transcript.jsonl',
      JSON.stringify({ subagentId: subId, ts: 't1', kind: 'text', content: 'ok' }) +
        '\n{"partial":',
      'utf8',
    );
    const entries = await readLocalSubagentTranscript(sessionId, subId);
    expect(entries).not.toBeNull();
    expect(entries!).toHaveLength(1);
    expect(entries![0]!.text).toBe('ok');
  });
});
