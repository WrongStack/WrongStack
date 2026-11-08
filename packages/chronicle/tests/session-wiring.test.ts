/**
 * wireChronicleSession is the one producer path from a host's EventBus into
 * the project Chronicle — the CLI host and the standalone WebUI host (the
 * desktop engine) both record through it.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChronicleProjectAccess } from '../src/project-access.js';
import {
  chronicleLimit,
  resolveChronicleRetentionDays,
  wireChronicleSession,
} from '../src/session-wiring.js';

let root: string;

beforeEach(async () => {
  vi.stubEnv('WRONGSTACK_CHRONICLE_INLINE', '1');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-session-wiring-'));
  await fs.mkdir(path.join(root, 'project'), { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const paths = () => ({
  globalRoot: path.join(root, 'global'),
  projectSlug: 'project',
  projectHash: 'project-hash',
  projectDir: path.join(root, 'global', 'projects', 'project-hash'),
});

async function recorded(sessionId: string) {
  const p = paths();
  const access = createChronicleProjectAccess({
    projectRoot: path.join(root, 'project'),
    projectPaths: {
      globalRoot: p.globalRoot,
      projectId: p.projectHash,
      projectDir: p.projectDir,
      workspaceId: p.projectSlug,
    },
  });
  try {
    return await access.call('query', { query: { sessionId, order: 'asc' } });
  } finally {
    await access.close();
  }
}

describe('wireChronicleSession', () => {
  it("records a tab's events under its own session and the rest under the host's", async () => {
    const events = new EventBus();
    const wiring = wireChronicleSession({
      events,
      config: {},
      projectRoot: path.join(root, 'project'),
      paths: paths(),
      sessionId: () => 'leader',
    });
    expect(wiring).toBeDefined();
    events.emit('tool.started', {
      sessionId: 'tab-2',
      agentId: 'leader',
      name: 'read',
      id: 'tool-1',
      input: { path: 'src/a.ts' },
    });
    events.emit('tool.executed', {
      sessionId: 'tab-2',
      agentId: 'leader',
      name: 'read',
      id: 'tool-1',
      ok: true,
      durationMs: 5,
      output: 'one\ntwo',
    });
    // No session of its own: the host's current session owns it.
    events.emit('context.residency', {
      seq: 1,
      provider: 'openai',
      model: 'model-a',
      mechanism: 'automatic',
      maxContext: 200000,
      total: 1200,
      cached: 800,
      written: 0,
      uncached: 400,
      usageInput: 400,
      usageCacheRead: 800,
      usageCacheWrite: 0,
      verdict: 'hit',
      breakers: [],
      segments: [],
      live: [],
    } as never);
    await wiring?.dispose();
    // Unsubscribed: nothing after dispose reaches the (closed) journal.
    events.emit('tool.started', {
      sessionId: 'tab-2',
      agentId: 'leader',
      name: 'read',
      id: 'tool-late',
      input: { path: 'src/b.ts' },
    });

    const tab = await recorded('tab-2');
    expect(tab.events.map((event) => event.eventType)).toEqual(['tool.started', 'tool.executed']);
    expect(tab.events.every((event) => event.scope['sessionId'] === 'tab-2')).toBe(true);
    const leader = await recorded('leader');
    expect(leader.events.map((event) => event.eventType)).toContain('context.residency');
  });

  it('records nothing without a project data directory', () => {
    const { projectDir: _omitted, ...rest } = paths();
    expect(
      wireChronicleSession({
        events: new EventBus(),
        config: {},
        projectRoot: path.join(root, 'project'),
        paths: rest,
        sessionId: () => 'leader',
      }),
    ).toBeUndefined();
  });

  it('degrades to no telemetry when the journal cannot open', () => {
    vi.unstubAllEnvs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(
        wireChronicleSession({
          events: new EventBus(),
          config: {},
          projectRoot: path.join(root, 'project'),
          paths: paths(),
          sessionId: () => 'leader',
        }),
      ).toBeUndefined();
      expect(warn.mock.calls.some(([line]) => String(line).includes('chronicle.disabled'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('reads retention and limits from the chronicle config block', () => {
    expect(resolveChronicleRetentionDays({})).toBe(7);
    expect(resolveChronicleRetentionDays({ chronicle: { retentionDays: 0 } })).toBe(0);
    expect(resolveChronicleRetentionDays({ chronicle: { retentionDays: 2 } })).toBe(7);
    expect(resolveChronicleRetentionDays({ chronicle: { retentionDays: 30 } })).toBe(30);
    expect(chronicleLimit({ chronicle: { maxEvents: 500 } }, 'maxEvents')).toBe(500);
    expect(chronicleLimit({ chronicle: { maxEvents: -1 } }, 'maxEvents')).toBeUndefined();
  });
});
