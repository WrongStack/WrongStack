/**
 * A desktop conversation's Session Story, end to end below the native shell: the engine's
 * agents emit on its EventBus, the standalone WebUI host (the desktop engine) records them in
 * the project Chronicle, the desktop asks for the history with `chronicle.query` through its
 * request/reply correlation, and the shared story turns the reply into context points, model,
 * tool and file rows. The engine used to record nothing, so every one of them was empty.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createChronicleProjectAccess } from '@wrongstack/chronicle';
import { EventBus } from '@wrongstack/contracts/kernel';
import { buildContextTimeline } from '@wrongstack/project-surfaces/story/session-context-timeline';
import { sessionModelStats } from '@wrongstack/project-surfaces/story/session-model-stats';
import { buildSessionStory } from '@wrongstack/project-surfaces/story/session-story';
import { storyStats } from '@wrongstack/project-surfaces/story/session-story-stats';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleChronicleRoute } from '../../../packages/webui-server/src/server/chronicle-routes';
import { wireStandaloneChronicle } from '../../../packages/webui-server/src/server/start-webui-chronicle';
import { type DesktopStoryValue, desktopStoryFeed } from '../src/desktop-story-feed';
import { EngineOperations } from '../src/engine-operations';
import type { EngineState } from '../src/engine-state';

const SESSION = 'desk-session';
const OTHER = 'other-tab';

let root: string;
let projectRoot: string;
let close: (() => Promise<void>) | undefined;

beforeEach(async () => {
  vi.stubEnv('WRONGSTACK_CHRONICLE_INLINE', '1');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-story-chronicle-'));
  projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const wpaths = () => ({
  globalRoot: path.join(root, 'global'),
  projectSlug: 'project',
  projectHash: 'project-hash',
  projectDir: path.join(root, 'global', 'projects', 'project-hash'),
});

const residency = (seq: number, total: number) => ({
  sessionId: SESSION,
  agentId: 'leader',
  seq,
  provider: 'openai',
  model: 'model-a',
  mechanism: 'automatic' as const,
  maxContext: 200000,
  total,
  cached: total - 400,
  written: 0,
  uncached: 400,
  usageInput: 400,
  usageCacheRead: total - 400,
  usageCacheWrite: 0,
  verdict: 'hit' as const,
  breakers: [],
  segments: [{ kind: 'history', tokens: total, lane: 'cached' as const, count: seq }],
  live: [],
  historyMessages: seq * 2,
  liveTokens: 0,
});

/** One answered request with a read and an edit, as the agent loop emits it. */
function runTurn(events: EventBus, sessionId: string, seq: number) {
  const at = (s: number) => `2026-11-08T10:0${seq}:0${s}.000Z`;
  const attempt = {
    sessionId,
    agentId: 'leader',
    logicalRequestId: `request-${seq}`,
    attemptId: `${sessionId}-attempt-${seq}`,
    attempt: 0,
    providerId: 'openai',
    model: 'model-a',
  };
  events.emit('provider.attempt.started', {
    ...attempt,
    streaming: true,
    messageCount: seq * 2,
    toolCount: 2,
    startedAt: at(0),
  });
  events.emit('provider.attempt.completed', {
    ...attempt,
    startedAt: at(0),
    endedAt: at(1),
    durationMs: 1000,
    stopReason: 'tool_use',
    usage: { input: 400, output: 50 },
  });
  if (sessionId === SESSION) events.emit('context.residency', residency(seq, 1000 * seq) as never);
  for (const [name, id] of [
    ['read', `read-${seq}`],
    ['edit', `edit-${seq}`],
  ] as const) {
    events.emit('tool.started', {
      sessionId,
      agentId: 'leader',
      name,
      id,
      input: { path: 'src/a.ts' },
    });
    events.emit('tool.executed', {
      sessionId,
      agentId: 'leader',
      name,
      id,
      ok: true,
      durationMs: 7,
      output: name === 'read' ? '1→one\n2→two' : 'Edited src/a.ts',
      input: { path: 'src/a.ts' },
    } as never);
  }
}

/** The desktop's own request path: `EngineOperations` correlation over the engine's route. */
function desktopCommand(): DesktopStoryValue['command'] {
  const p = wpaths();
  const access = createChronicleProjectAccess({
    projectRoot,
    projectPaths: {
      globalRoot: p.globalRoot,
      projectId: p.projectHash,
      projectDir: p.projectDir,
      workspaceId: p.projectSlug,
    },
  });
  close = () => access.close();
  const operations: EngineOperations = new EngineOperations(async (type, payload) => {
    await handleChronicleRoute(
      {
        getProjectRoot: () => projectRoot,
        getChronicleAccess: () => access,
        send: (_ws, reply) =>
          operations.receive({
            type: reply.type,
            payload: (reply.payload ?? {}) as Record<string, unknown>,
          }),
      },
      {} as WebSocket,
      { type, payload } as never,
    );
  });
  return operations.request;
}

function feedFor(command: DesktopStoryValue['command']) {
  const state = {
    sessionId: SESSION,
    results: { 'session.start': { protocolCapabilities: ['chronicle.query'] } },
  } as unknown as EngineState;
  return desktopStoryFeed(() => ({
    state,
    projectRoot,
    send: async () => undefined,
    command,
    onBack: () => undefined,
  }));
}

describe('desktop Session Story over the engine Chronicle', () => {
  it("delivers the conversation's context, model, tool and file history to the story", async () => {
    const events = new EventBus();
    const chronicle = wireStandaloneChronicle({
      opts: {},
      events,
      config: {},
      projectRoot,
      wpaths: wpaths(),
      getSessionId: () => SESSION,
      logger: { warn: () => undefined },
    });
    runTurn(events, SESSION, 1);
    runTurn(events, OTHER, 1);
    runTurn(events, SESSION, 2);
    await chronicle?.dispose();

    const feed = feedFor(desktopCommand());
    expect(feed.supportsChronicle()).toBe(true);
    // The query `useStoryHistory` sends, and the scope filter it applies to the reply.
    const reply = await feed.queryChronicle(
      { sessionId: SESSION, order: 'desc', limit: 5000 },
      new AbortController().signal,
    );
    const history = reply.events.filter((event) => event.scope['sessionId'] === SESSION);
    expect(history.length).toBeGreaterThan(0);

    const timeline = buildContextTimeline(history);
    expect(timeline.points.map((point) => point.total)).toEqual([1000, 2000]);
    expect(timeline.maxContext).toBe(200000);

    const story = buildSessionStory(SESSION, history, [], [], [], projectRoot);
    const models = sessionModelStats(story);
    const model = models.find((row) => row.model === 'model-a');
    expect(model && [model.provider, model.attempts, model.completed]).toEqual(['openai', 2, 2]);
    const { tools, files } = storyStats(story, projectRoot);
    expect(tools.map((tool) => [tool.name, tool.calls, tool.success])).toEqual([
      ['edit', 2, 2],
      ['read', 2, 2],
    ]);
    expect(files.map((file) => file.path)).toEqual(['src/a.ts']);
  });
});
