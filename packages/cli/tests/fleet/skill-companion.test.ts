import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type {
  SkillLoader,
  SkillManifest,
  SubagentConfig,
  TaskResult,
} from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { renderInstructionLayer } from '@wrongstack/core/agent';
import type { Director } from '@wrongstack/core/coordination';
import { DEFAULT_SUBAGENT_BASELINE, makeSubagentResultTool } from '@wrongstack/core/coordination';
import {
  markRecommendedSkillLoaded,
  markRecommendedSkillUnavailable,
  readSkillCompanionState,
} from '@wrongstack/core/skills';
import { estimateTextTokens } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSkillCompanion } from '../../src/fleet/host-skill-companion.js';
import {
  loadSkillOutcomes,
  recordSkillOutcomes,
} from '../../src/fleet/skill-companion-outcomes.js';
import {
  constrainSkillCompanion,
  isSkillCompanion,
  parseSkillCompanionPick,
  SKILL_COMPANION_PROMPT,
} from '../../src/fleet/skill-companion-policy.js';

function manifest(name: string, description: string): SkillManifest {
  return { name, description, path: `/skills/${name}/SKILL.md`, source: 'project' };
}

const CATALOG = [
  manifest('frontend-design', 'Distinctive UI design for new screens.'),
  manifest('cloudflare', 'Workers, wrangler and edge deployment.'),
  manifest('testing', 'Write and fix tests.'),
];

const instances: HostSkillCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
});

function leaderCtx(sessionId = 'S1') {
  return {
    meta: {} as Record<string, unknown>,
    messages: [] as unknown[],
    session: { id: sessionId },
    tools: [{ name: 'skill' }, { name: 'edit' }, { name: 'read' }],
  } as unknown as Context;
}

function harness(
  options: {
    enforce?: 'speed-bump' | 'off';
    maxProbes?: number;
    timeoutMs?: number;
    catalog?: SkillManifest[];
    pathRules?: boolean;
    projectRoot?: string;
  } = {},
) {
  const events = new EventBus();
  let completed: (event: { result: TaskResult }) => void = () => {};
  let enabled = true;
  const note = vi.fn();
  const spawn = vi.fn(async (_config: SubagentConfig) => 'worker');
  const assignInternal = vi.fn(
    async (_task: { id: string; subagentId: string; description: string }) => {},
  );
  const terminate = vi.fn(async () => {});
  const director = {
    spawnCompanion: spawn,
    assignInternal,
    terminate,
    status: () => ({ subagents: [{ id: 'worker' }] }),
    on: (_event: string, handler: typeof completed) => {
      completed = handler;
      return () => {};
    },
  } as unknown as Director;
  const loader = {
    list: vi.fn(async () => options.catalog ?? CATALOG),
  } as unknown as SkillLoader;
  const companion = new HostSkillCompanion({
    director,
    events,
    skillLoader: () => loader,
    enabled: () => enabled,
    config: {
      ...(options.enforce ? { enforce: options.enforce } : {}),
      ...(options.maxProbes ? { maxProbesPerSession: options.maxProbes } : {}),
      ...(options.timeoutMs ? { probeTimeoutMs: options.timeoutMs } : {}),
      ...(options.pathRules === false ? { pathRules: false } : {}),
    },
    scrub: (text) => text.replaceAll('secret-fixture', '[redacted]'),
    note,
    projectRoot: options.projectRoot,
  });
  instances.push(companion);
  const ctx = leaderCtx();
  const run = (text: string, target: Context = ctx, sessionId = 'S1') =>
    events.emit('agent.run.started', {
      sessionId,
      ctx: target,
      model: 'm',
      at: new Date().toISOString(),
      inputText: text,
    });
  const finish = (body: object, status: TaskResult['status'] = 'success') => {
    const task = assignInternal.mock.calls.at(-1)![0];
    completed({
      result: {
        taskId: task.id,
        subagentId: 'worker',
        status,
        result: JSON.stringify(body),
      } as TaskResult,
    });
  };
  const finishWithProseSummary = (body: object) => {
    const task = assignInternal.mock.calls.at(-1)![0];
    completed({
      result: {
        taskId: task.id,
        subagentId: 'worker',
        status: 'success',
        report: {
          summary: 'Picked frontend-design for the settings screen.',
          findings: [],
          files_examined: [],
          confidence: 0.9,
          suggested_next_steps: [],
        },
        result: JSON.stringify(body),
        iterations: 1,
        toolCalls: 0,
        durationMs: 1,
      } as TaskResult,
    });
  };
  return {
    events,
    ctx,
    run,
    finish,
    finishWithProseSummary,
    note,
    spawn,
    assignInternal,
    terminate,
    disable: () => {
      enabled = false;
    },
  };
}

const PICK = {
  skills: [{ name: 'frontend-design', reason: 'new settings screen' }],
  confidence: 0.9,
};

describe('Skill Companion', () => {
  it.each([
    '/bughunt --rounds 10 packages/webui',
    '# ROLE: Autonomous Proof-Driven Bug Hunter & Fixer\n\nHunt one proven bug.',
    '<!-- wrongstack-bug-hunt scope="packages/webui" max-bugs="10" round="2" -->\nThis is round 2/10.',
    "This is round 2/10; we're continuing the bug hunt. Stay within the original scope: packages/webui.",
  ])('skips the skill judge for a proof-driven bughunt request: %s', async (request) => {
    vi.useFakeTimers();
    const h = harness();
    h.run(request);
    h.events.emit('tool.executed', {
      sessionId: 'S1',
      name: 'edit',
      ok: true,
      input: { path: 'test.ts' },
    } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.assignInternal).not.toHaveBeenCalled();
    h.run('Redesign the settings page after the hunt');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.assignInternal).toHaveBeenCalledTimes(1);
  });

  it('clears a previous skill recommendation when the proof-driven hunt starts', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(readSkillCompanionState(h.ctx)?.recommended).toHaveLength(1);
    h.run('/bughunt packages/webui');
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
    expect(h.terminate).toHaveBeenCalledWith('worker');
  });

  it('retires an in-flight picker when bughunt starts and discards its late result', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.run('/bughunt packages/webui');
    h.finish(PICK);
    await vi.waitFor(() => expect(h.terminate).toHaveBeenCalledWith('worker'));
    expect(h.note).not.toHaveBeenCalled();
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
    h.run('Redesign the settings page after the hunt');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
  });

  it('stays out of a session an agent leads (ACP, WrongForge) and returns after it', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    const led = h.ctx as unknown as { provider?: unknown };
    led.provider = { capabilities: { keepsOwnContext: true } };

    h.run('Now redesign the profile page as well');
    // No hold left behind for an agent the executor never holds.
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
    expect(h.terminate).toHaveBeenCalledWith('worker');
    h.events.emit('tool.executed', {
      sessionId: 'S1',
      name: 'edit',
      ok: true,
      input: { path: 'src/profile.tsx' },
    } as never);
    expect(h.assignInternal).toHaveBeenCalledTimes(1);

    led.provider = { capabilities: {} };
    h.run('Back on a WrongStack model: redesign the billing page');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
  });

  it('judges a new turn with a tool-less resident and arms a one-time hold', async () => {
    const h = harness();
    h.run('Redesign the settings page with secret-fixture tokens');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));

    const config = h.spawn.mock.calls[0]![0];
    expect(isSkillCompanion(config)).toBe(true);
    expect(config.tools).toEqual([]);
    // Sealed: the coordinator, agent loop and budget keep it on this one job.
    expect(config.sealed).toBe(true);
    expect(config.originSessionId).toBe('S1');
    const task = h.assignInternal.mock.calls[0]![0].description;
    expect(task).toContain('"frontend-design"');
    expect(task).toContain('[redacted]');
    expect(task).not.toContain('secret-fixture');

    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(h.note.mock.calls[0]![1]).toBe('[skill:recommend]');
    expect(h.note.mock.calls[0]![2]).toContain('skill({ name: "frontend-design" })');
    expect(h.note.mock.calls[0]![2]).toContain('held once');
    expect(readSkillCompanionState(h.ctx)?.recommended).toEqual([
      { name: 'frontend-design', reason: 'new settings screen' },
    ]);
  });

  it('drops names it did not offer and low-confidence picks', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [{ name: 'made-up-skill', reason: 'x' }], confidence: 0.95 });
    h.run('Now deploy the worker to production');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    h.finish({ skills: [{ name: 'cloudflare', reason: 'deploy' }], confidence: 0.3 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.note).not.toHaveBeenCalled();
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
  });

  it('never offers a skill the leader already loaded or the user mentioned', async () => {
    const h = harness();
    (h.ctx.messages as unknown[]).push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'k1', name: 'skill', input: { name: 'testing' } }],
    });
    h.run('Fix the settings page, use $cloudflare for deploy');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    const task = h.assignInternal.mock.calls[0]![0].description;
    expect(task).toContain('"frontend-design"');
    expect(task).not.toContain('"testing"');
    expect(task).not.toContain('"cloudflare"');
  });

  it('notes without holding edits when enforcement is off', async () => {
    const h = harness({ enforce: 'off' });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(h.note.mock.calls[0]![2]).not.toContain('held once');
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
  });

  it('ignores short turns, workers and disabled sessions', async () => {
    const h = harness();
    h.run('continue');
    const worker = leaderCtx('S1');
    (worker.meta as Record<string, unknown>)['agentRole'] = 'reviewer';
    h.run('Review the settings page carefully', worker);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.spawn).not.toHaveBeenCalled();
    h.disable();
    h.run('Redesign the settings page please');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('still judges a todo or file-family edit after a short opening turn like "continue"', async () => {
    const h = harness();
    h.run('continue');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.assignInternal).not.toHaveBeenCalled();

    h.events.emit('session.agents_updated', {
      sessionId: 'S1',
      agents: [
        {
          id: 'leader',
          todos: [{ id: 't1', content: 'Deploy workers with wrangler', status: 'in_progress' }],
        },
      ],
    } as never);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.assignInternal.mock.calls[0]![0].description).toContain('"todo"');
    h.finish({
      skills: [{ name: 'cloudflare', reason: 'wrangler deployment' }],
      confidence: 0.9,
    });
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
  });

  it('re-probes when the leader starts editing a new kind of file, within the cap', async () => {
    const h = harness({ maxProbes: 2 });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [], confidence: 0 });
    const edit = (path: string) =>
      h.events.emit('tool.executed', {
        sessionId: 'S1',
        id: path,
        name: 'edit',
        ok: true,
        durationMs: 1,
        input: { path },
      } as never);
    edit('wrangler.toml');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    expect(h.assignInternal.mock.calls[1]![0].description).toContain('"file_family"');
    h.finish({ skills: [], confidence: 0 });
    edit('src/app.test.ts');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Cap reached: no third judge call.
    expect(h.assignInternal).toHaveBeenCalledTimes(2);
  });

  const DECLARED = [
    ...CATALOG.filter((skill) => skill.name !== 'cloudflare'),
    { ...manifest('cloudflare', 'Workers and edge deployment.'), paths: ['wrangler.{toml,jsonc}'] },
  ];
  const edit = (h: ReturnType<typeof harness>, path: string) =>
    h.events.emit('tool.executed', {
      sessionId: 'S1',
      id: path,
      name: 'edit',
      ok: true,
      durationMs: 1,
      input: { path },
    } as never);

  it('recommends a skill whose declared paths cover an edit, without a model call', async () => {
    const h = harness({ catalog: DECLARED });
    h.run('Tune the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    // Armed for the executor, which holds the matching change before it runs.
    expect(readSkillCompanionState(h.ctx)?.pathRules).toEqual([
      { name: 'cloudflare', globs: ['wrangler.{toml,jsonc}'] },
    ]);
    h.finish({ skills: [], confidence: 0 });
    // An edit that ran anyway (arming raced it) still gets the note.
    edit(h, 'apps/edge/wrangler.toml');
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    const body = h.note.mock.calls[0]![2] as string;
    expect(body).toContain(
      'cloudflare: declares paths wrangler.{toml,jsonc}, matched wrangler.toml',
    );
    expect(body).toContain('Deterministic match');
    expect(readSkillCompanionState(h.ctx)?.recommended.map((rec) => rec.name)).toEqual([
      'cloudflare',
    ]);
    // The declared rule covered the file: no file-family judge call.
    expect(h.assignInternal).toHaveBeenCalledTimes(1);
    // Once per conversation: a second matching edit raises nothing new.
    edit(h, 'wrangler.jsonc');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.note).toHaveBeenCalledTimes(1);
  });

  it('resolves post-edit declared paths from the active working directory', async () => {
    const projectRoot = join(process.cwd(), 'skill-companion-project');
    const nestedDeclared = [
      ...CATALOG.filter((skill) => skill.name !== 'cloudflare'),
      {
        ...manifest('cloudflare', 'Workers and edge deployment.'),
        paths: ['apps/edge/wrangler.toml'],
      },
    ];
    const h = harness({ catalog: nestedDeclared });
    Object.assign(h.ctx, {
      projectRoot,
      cwd: projectRoot,
      workingDir: join(projectRoot, 'apps', 'edge'),
    });
    h.run('Tune the edge config please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [], confidence: 0 });

    edit(h, 'wrangler.toml');

    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    const body = h.note.mock.calls[0]![2] as string;
    expect(body).toContain(
      'cloudflare: declares paths apps/edge/wrangler.toml, matched wrangler.toml',
    );
    expect(h.assignInternal).toHaveBeenCalledTimes(1);
  });

  it('keeps a declared recommendation open when a later judge answer arrives', async () => {
    const h = harness({ catalog: DECLARED });
    h.run('Tune the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [], confidence: 0 });
    edit(h, 'wrangler.toml');
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    h.run('Now redesign the settings screen');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(2));
    expect(readSkillCompanionState(h.ctx)?.recommended.map((rec) => rec.name)).toEqual([
      'cloudflare',
      'frontend-design',
    ]);
  });

  it('leaves declared paths to the judge when path rules are off', async () => {
    const h = harness({ catalog: DECLARED, pathRules: false });
    h.run('Tune the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(readSkillCompanionState(h.ctx)?.pathRules).toBeUndefined();
    h.finish({ skills: [], confidence: 0 });
    edit(h, 'wrangler.toml');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    expect(h.note).not.toHaveBeenCalled();
  });

  it('offers the overlapping candidates first, with the overlapping words', async () => {
    const h = harness();
    h.run('Ship the workers with wrangler today');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    const task = h.assignInternal.mock.calls[0]![0].description;
    const payload = JSON.parse(task.slice(task.indexOf('Payload:\n') + 9)) as {
      CANDIDATES: Array<{ name: string; match?: string[] }>;
    };
    expect(payload.CANDIDATES[0]).toEqual({
      name: 'cloudflare',
      description: 'Workers, wrangler and edge deployment.',
      match: ['workers', 'wrangler'],
    });
  });

  it('does not re-ask a todo whose overlap the judge already found empty', async () => {
    const h = harness();
    const todos = (items: Array<{ id: string; content: string; status: string }>) =>
      h.events.emit('session.agents_updated', {
        sessionId: 'S1',
        agents: [{ id: 'leader', todos: items }],
      } as never);
    h.run('Ship the workers with wrangler today');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    h.finish({ skills: [], confidence: 0.2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Adds no overlapping word: same evidence, same answer, no model call.
    todos([{ id: 't1', content: 'Kick off the rollout', status: 'in_progress' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.assignInternal).toHaveBeenCalledTimes(1);
    // New overlap ("tests") is new evidence: the judge is asked.
    todos([
      { id: 't1', content: 'Kick off the rollout', status: 'completed' },
      { id: 't2', content: 'Write tests for the rollout', status: 'in_progress' },
    ]);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
  });

  it('records loaded and refused recommendations for the project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstack-skill-companion-'));
    try {
      const h = harness({ projectRoot: dir });
      h.run('Redesign the settings page please');
      await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
      h.finish({
        skills: [
          { name: 'frontend-design', reason: 'new screen' },
          { name: 'testing', reason: 'tests' },
        ],
        confidence: 0.9,
      });
      await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
      // The leader loads one and the skill tool cannot provide the other.
      markRecommendedSkillLoaded(h.ctx, 'frontend-design');
      markRecommendedSkillUnavailable(h.ctx, 'testing');
      // A skill loaded without a recommendation is not the companion's outcome.
      markRecommendedSkillLoaded(h.ctx, 'cloudflare');
      h.run('Now polish the settings page');
      h.run('And once more for good measure');
      expect(loadSkillOutcomes(dir).skills).toEqual({
        'frontend-design': expect.objectContaining({ accepted: 1, declined: 0 }),
        testing: expect.objectContaining({ accepted: 0, declined: 1 }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops offering a skill the leader keeps refusing in this project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wstack-skill-companion-'));
    try {
      for (let i = 0; i < 3; i++)
        recordSkillOutcomes(dir, { accepted: [], declined: ['frontend-design'] });
      const h = harness({
        projectRoot: dir,
        catalog: [...CATALOG, { ...manifest('vue', 'Vue components.'), paths: ['*.vue'] }],
      });
      recordSkillOutcomes(dir, { accepted: [], declined: ['vue', 'vue', 'vue'] });
      h.run('Redesign the settings page please');
      await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
      const task = h.assignInternal.mock.calls[0]![0].description;
      expect(task).not.toContain('"frontend-design"');
      expect(task).toContain('"testing"');
      expect(readSkillCompanionState(h.ctx)?.pathRules).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retires a resident that misses the deadline', async () => {
    const h = harness({ timeoutMs: 20 });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.terminate).toHaveBeenCalledWith('worker'));
    expect(h.note).not.toHaveBeenCalled();
  });

  it('accepts a judge answer after the former 45-second deadline', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.spawn.mock.calls[0]![0].timeoutMs).toBe(300_000);
    expect(h.assignInternal.mock.calls[0]![0]).toMatchObject({ timeoutMs: 300_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.terminate).not.toHaveBeenCalled();
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
  });

  it('honors a configured deadline above five minutes in the host and worker', async () => {
    vi.useFakeTimers();
    const h = harness({ timeoutMs: 900_000 });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.spawn.mock.calls[0]![0].timeoutMs).toBe(900_000);
    expect(h.assignInternal.mock.calls[0]![0]).toMatchObject({ timeoutMs: 900_000 });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.terminate).not.toHaveBeenCalled();
    h.finish(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
  });

  it('does not recommend into a context that moved to another conversation', async () => {
    const h = harness();
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    (h.ctx.session as { id: string }).id = 'S2';
    h.finish(PICK);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.note).not.toHaveBeenCalled();
    expect(readSkillCompanionState(h.ctx)).toBeUndefined();
  });

  it('falls back to result.result when report.summary is prose and retires a failed resident', async () => {
    const h = harness({ maxProbes: 4 });
    h.run('Redesign the settings page please');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    // First probe fails: resident is retired and a fresh resident is spawned on the next turn.
    h.finish(PICK, 'failed');
    await vi.waitFor(() => expect(h.terminate).toHaveBeenCalledWith('worker'));
    h.run('Now redesign the dashboard settings screen');
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(2));
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.finishWithProseSummary(PICK);
    await vi.waitFor(() => expect(h.note).toHaveBeenCalledTimes(1));
    expect(readSkillCompanionState(h.ctx)?.recommended).toEqual([
      { name: 'frontend-design', reason: 'new settings screen' },
    ]);
  });
});

describe('Skill Companion policy', () => {
  it('honors explicit budgets and strips tools after project overrides', () => {
    const limited = constrainSkillCompanion({
      id: 'skill-companion-x',
      name: 'Skill Companion',
      role: 'skill-companion',
      tools: ['bash', 'write'],
      maxToolCalls: 500,
      maxCostUsd: 5,
      maxIterations: 10,
      maxTokens: 256_000,
      timeoutMs: 900_000,
      skillNames: ['testing'],
    });
    expect(limited.tools).toEqual([]);
    expect(limited.sealed).toBe(true);
    expect(limited.skillNames).toEqual([]);
    expect(limited.maxToolCalls).toBe(500);
    expect(limited.maxCostUsd).toBe(5);
    expect(limited.maxIterations).toBe(10);
    expect(limited.maxTokens).toBe(256_000);
    expect(limited.timeoutMs).toBe(900_000);
    expect(isSkillCompanion({ id: 'skill-companion-x', name: 'x', role: 'reviewer' })).toBe(false);
  });

  it('default budget holds one full-payload judge call', () => {
    // Regression: a 6000-token cap with a ~23k-token first call killed every
    // probe after the judge had already answered.
    const tool = makeSubagentResultTool();
    const system = [
      renderInstructionLayer(DEFAULT_SUBAGENT_BASELINE, {
        toolNames: new Set([tool.name]),
        tier: 'off',
        subagent: true,
        strictToolReferences: true,
      }),
      SKILL_COMPANION_PROMPT,
      JSON.stringify({ description: tool.description, schema: tool.inputSchema }),
    ].join('\n');
    const payload = `${SKILL_COMPANION_PROMPT}\nPayload:\n${JSON.stringify({
      trigger: 'turn',
      detail: 'The user sent a new request.',
      request: 'r'.repeat(2000),
      todos: Array.from({ length: 6 }, () => ({ status: 'pending', content: 't'.repeat(160) })),
      recentFiles: Array.from({ length: 8 }, (_, i) => `packages/some/deep/path/file-${i}.ts`),
      CANDIDATES: Array.from({ length: 80 }, (_, i) => ({
        name: `candidate-skill-name-${i}`,
        description: 'word '.repeat(44),
        match: ['overlapping', 'request', 'words', 'shown'],
      })),
    })}`;
    const answerAllowance = 2000;
    const call = estimateTextTokens(system) + estimateTextTokens(payload) + answerAllowance;
    const limited = constrainSkillCompanion({
      id: 'skill-companion-x',
      name: 'Skill Companion',
      role: 'skill-companion',
    });
    expect(call).toBeLessThan(limited.maxTokens!);
    expect(limited).toMatchObject({ maxTokens: 128_000, maxCostUsd: 1, timeoutMs: 300_000 });
  });

  it('parses fenced answers and keeps only offered names', () => {
    const offered = [
      { name: 'testing', description: '' },
      { name: 'debugging', description: '' },
    ];
    const pick = parseSkillCompanionPick(
      '```json\n{"skills":[{"name":"Testing","reason":"r"},{"name":"other"},{"name":"testing"}],"confidence":2}\n```',
      offered,
    );
    expect(pick).toEqual({ skills: [{ name: 'testing', reason: 'r' }], confidence: 1 });
    expect(parseSkillCompanionPick('no json here', offered)).toBeUndefined();
  });

  it('cancels queued probes on director.onSessionTerminate and allows re-probing later', async () => {
    let terminateListener: ((sessionId: string) => void) | undefined;
    const events = new EventBus();
    let completed: (event: { result: TaskResult }) => void = () => {};
    const spawn = vi.fn(async () => 'worker');
    const assignInternal = vi.fn(async () => {});
    const terminate = vi.fn(async () => {});
    const director = {
      spawnCompanion: spawn,
      assignInternal,
      terminate,
      status: () => ({ subagents: [{ id: 'worker' }] }),
      on: (_event: string, handler: typeof completed) => {
        completed = handler;
        return () => {};
      },
      onSessionTerminate: (cb: (sessionId: string) => void) => {
        terminateListener = cb;
        return () => {};
      },
    } as unknown as Director;
    const c2 = new HostSkillCompanion({
      director,
      events,
      skillLoader: () => ({ list: vi.fn(async () => CATALOG) }) as unknown as SkillLoader,
      enabled: () => true,
      scrub: (t) => t,
      note: vi.fn(),
    });
    instances.push(c2);
    void completed;
    const ctx = leaderCtx('S1');
    events.emit('agent.run.started', {
      sessionId: 'S1',
      ctx,
      model: 'm',
      at: new Date().toISOString(),
      inputText: 'Design a distinctive new UI screen and deploy to cloudflare workers',
    });
    await vi.waitFor(() => expect(assignInternal).toHaveBeenCalledTimes(1));
    // Queue a second probe while first is in flight
    events.emit('session.agents_updated', {
      sessionId: 'S1',
      agents: [
        {
          id: 'leader',
          name: 'leader',
          status: 'running',
          iterations: 1,
          toolCalls: 1,
          lastActivityAt: new Date().toISOString(),
          todos: [{ id: 't1', content: 'Write unit tests for worker', status: 'in_progress' }],
        },
      ],
    });
    terminateListener?.('S1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Queued todo probe was dropped — no second assignment happened
    expect(assignInternal).toHaveBeenCalledTimes(1);
  });
});
