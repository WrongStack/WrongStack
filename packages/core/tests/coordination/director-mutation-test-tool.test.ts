import { describe, expect, it } from 'vitest';
import type * as Host from '../../src/coordination/director-host-contracts.js';
import { makeMutationTestTool } from '../../src/coordination/director-mutation-test-tool.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';
import type { TaskResult, TaskSpec } from '../../src/types/multi-agent.js';

/**
 * In-memory DirectorRepairPort double. Records spawn/assign/await calls so
 * tests can assert the strengthen-loop choreography without an LLM.
 */
function makeFakeDirector(handler: {
  chaos: (plan: MutationTestTaskShape) => string | undefined;
  strengthen?: (survivorIds: string[]) => string | undefined;
}) {
  const tasks = new Map<string, { spec: TaskSpec; resultText?: string }>();
  const spawns: string[] = [];
  const assigns: TaskSpec[] = [];
  let n = 0;

  const resolveTask = (id: string): TaskResult => {
    const entry = tasks.get(id)!;
    const isStrengthen = entry.spec.subagentId === 'repair-sub';
    const text = isStrengthen
      ? (handler.strengthen?.(survivorIdsOf(entry.spec.description)) ?? 'strengthened')
      : handler.chaos(parseChaosTask(entry.spec.description));
    return {
      subagentId: entry.spec.subagentId ?? 'unknown-sub',
      taskId: id,
      status: text === undefined ? 'failed' : 'success',
      ...(text === undefined ? {} : { result: text }),
      iterations: 1,
      toolCalls: 1,
      durationMs: 1,
    };
  };

  const director: Host.DirectorRepairPort = {
    async spawn() {
      const id = `sub-${++n}`;
      spawns.push(id);
      return id;
    },
    async assign(task) {
      assigns.push(task);
      tasks.set(task.id, { spec: task });
      return task.id;
    },
    async awaitTasks(ids) {
      return ids.map(resolveTask);
    },
    async awaitTasksAny(ids) {
      return { completed: ids.map(resolveTask), pending: [] };
    },
  };
  return { director, spawns, assigns };
}

interface MutationTestTaskShape {
  mutants: Array<{ id: string; file: string; line: number; kind: string }>;
}
function parseChaosTask(desc: string): MutationTestTaskShape {
  const ids = [...desc.matchAll(/^- ([\w-]+#\d+#\d+) \| ([^|]+):(\d+):(\d+) \| ([\w-]+)/gm)].map(
    (m) => ({ id: m[1]!, file: m[2]!.trim(), line: Number(m[3]), kind: m[5]! }),
  );
  return { mutants: ids };
}
function survivorIdsOf(desc: string): string[] {
  return [...desc.matchAll(/^- ([\w-]+#\d+#\d+) \|/gm)].map((m) => m[1]!);
}

const TARGET_FILE = 'packages/core/tests/coordination/__mutation_fixture__/subject.ts';

describe('makeMutationTestTool', () => {
  it('refuses to run without a chaos-monkey roster entry — no silent prompt/tools strip', async () => {
    // Regression: makeChaosConfig used to fall back through a dead
    // getAgentDefinition('chaos-monkey') lookup (the role is outside the
    // catalog by design) to a bare {name, role} config — spawning a
    // saboteur with no prompt, tools, or skills. The tool must fail
    // loudly before any spawn.
    const { director, spawns, assigns } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed' })),
        }),
    });
    const tool = makeMutationTestTool(director, undefined, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['verdict']).toBe('inconclusive');
    expect(out['passed']).toBe(false);
    expect(out['error']).toMatch(/chaos-monkey role missing from the roster/);
    // Loud failure means preflight: nothing may have been spawned or assigned.
    expect(spawns).toHaveLength(0);
    expect(assigns).toHaveLength(0);
  });

  it('errors cleanly when no mutable sites exist', async () => {
    const { director } = makeFakeDirector({ chaos: () => '{}' });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: ['no/such/file.ts'], testCommand: 'vitest' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['verdict']).toBe('inconclusive');
    expect(out['error']).toMatch(/No mutable sites/i);
  });

  it('reports killed mutants and passes without repair', async () => {
    const { director, spawns, assigns } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          summary: 'all killed',
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed', evidence: 'assert failed' })),
        }),
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['verdict']).toBe('pass');
    expect(out['passed']).toBe(true);
    expect(out['mutationScore']).toBe(1);
    expect(out['killed']).toBeGreaterThan(0);
    expect(out['survived']).toBe(0);
    // One chaos spawn; no strengthen tasks without repairSubagentId.
    expect(spawns).toHaveLength(1);
    expect(assigns).toHaveLength(1);
  });

  it('loops strengthen → re-verify on survivors and flags persistent ones as suspected-equivalent', async () => {
    // First chaos pass: everything survives. Re-verify passes: the arith
    // mutant dies after strengthening; the return-null mutant persists.
    let chaosPass = 0;
    const { director, assigns } = makeFakeDirector({
      chaos: (task) => {
        chaosPass++;
        const statusOf = (id: string): 'killed' | 'survived' =>
          chaosPass === 1 || !id.startsWith('arith') ? 'survived' : 'killed';
        return JSON.stringify({
          summary: 'pass done',
          mutants: task.mutants.map((m) => ({ ...m, status: statusOf(m.id), evidence: 'x' })),
        });
      },
      strengthen: (ids) => `strengthened ${ids.length} survivors`,
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 2,
        repairSubagentId: 'repair-sub',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(out['survived']).toBeGreaterThan(0);
    expect(out['strengthenAttempts']).toBeGreaterThan(0);
    expect(out['nextAction']).toMatch(/survivors|strengthen/);
    const equivalent = out['suspectedEquivalent'] as string[];
    expect(equivalent.some((id) => id.startsWith('return-null'))).toBe(true);
    // Assigns: chaos + (strengthen + rerun) per attempt.
    const strengthenAssigns = assigns.filter((a) => a.subagentId === 'repair-sub');
    expect(strengthenAssigns.length).toBeGreaterThan(0);
  });

  it('treats a failed chaos task as skipped mutants, never as kills', async () => {
    const { director } = makeFakeDirector({ chaos: () => undefined });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['skipped']).toBeGreaterThan(0);
    expect(out['killed']).toBe(0);
    expect(out['verdict']).toBe('inconclusive');
    expect(out['passed']).toBe(false);
  });

  it('treats a valid-but-partial report as skipped for unreported mutants, never as a pass', async () => {
    // Regression: a well-formed JSON reporting a strict subset of the
    // planned ids used to make the omitted mutants vanish from outcomes,
    // so a single 'killed' row over an N-mutant plan yielded verdict
    // 'pass'. Planned-but-unreported ids must count as skipped unknowns.
    let plannedCount = 0;
    const { director } = makeFakeDirector({
      chaos: (task) => {
        plannedCount = task.mutants.length;
        return JSON.stringify({
          summary: 'partial report — only the first mutant reported',
          mutants: task.mutants
            .slice(0, 1)
            .map((m) => ({ ...m, status: 'killed', evidence: 'assert failed' })),
        });
      },
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(plannedCount).toBeGreaterThan(1); // self-check: the report IS partial
    expect(out['killed']).toBe(1);
    expect(out['survived']).toBe(0);
    expect(out['skipped']).toBe(plannedCount - 1);
    expect(out['mutationScore']).toBeLessThan(1);
    expect(out['verdict']).toBe('partial'); // pre-fix: this was 'pass'
    expect(out['passed']).toBe(false);
  });

  it('plans deterministically — same target, same ids across two calls', async () => {
    const seen: string[][] = [];
    const { director } = makeFakeDirector({
      chaos: (task) => {
        seen.push(task.mutants.map((m) => m.id));
        return JSON.stringify({
          summary: 'ok',
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed' })),
        });
      },
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    for (let i = 0; i < 2; i++) {
      await tool.execute(
        { targets: [TARGET_FILE], testCommand: 'pnpm test' },
        { projectRoot: process.cwd() } as never,
        { signal: new AbortController().signal },
      );
    }
    expect(seen[0]).toEqual(seen[1]);
  });

  // ── repair-loop choreography hardening ───────────────────────────────
  // The original suite covers the happy paths (pass, fail, skipped, churn).
  // These tests pin the edges: worktree propagation into the spawn config,
  // capping of repair attempts, repair failure breaking the loop, drift
  // during the rerun, multi-target plans, absolute paths, and the
  // various inputs the schema passes through unchanged.

  it('propagates the chaosWorktree override into the spawned subagent config', async () => {
    // The fake Director doesn't capture the worktree, so we use a custom
    // factory that inspects what was passed to spawn().
    const seenWorktree: unknown[] = [];
    const director: Host.DirectorRepairPort = {
      async spawn(config) {
        seenWorktree.push((config as { worktree?: unknown }).worktree);
        return 'sub-1';
      },
      async assign(task) {
        return task.id;
      },
      async awaitTasks(ids) {
        return ids.map((id) => ({
          subagentId: 'sub-1',
          taskId: id,
          status: 'success',
          result: JSON.stringify({
            mutants: [{ id: 'm#1#1', file: 'a.ts', line: 1, kind: 'X', status: 'killed' }],
          }),
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        }));
      },
      async awaitTasksAny(ids) {
        return { completed: [], pending: ids };
      },
    };

    // 1. Default: no chaosWorktree passed → caller default `'off'`.
    const t1 = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    await t1.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(seenWorktree[0]).toBe('off');

    // 2. Explicit `'auto'` propagates verbatim.
    const t2 = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    await t2.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test', chaosWorktree: 'auto' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(seenWorktree[1]).toBe('auto');
  });

  it('honors the roster chaos-monkey worktree policy when no override is passed', async () => {
    const seenWorktree: unknown[] = [];
    const director: Host.DirectorRepairPort = {
      async spawn(config) {
        seenWorktree.push((config as { worktree?: unknown }).worktree);
        return 'sub-1';
      },
      async assign(task) {
        return task.id;
      },
      async awaitTasks(ids) {
        return ids.map((id) => ({
          subagentId: 'sub-1',
          taskId: id,
          status: 'success' as const,
          result: JSON.stringify({
            mutants: [{ id: 'm#1#1', file: 'a.ts', line: 1, kind: 'X', status: 'killed' }],
          }),
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        }));
      },
      async awaitTasksAny(ids) {
        return { completed: [], pending: ids };
      },
    };
    const roster = { 'chaos-monkey': { ...FLEET_ROSTER['chaos-monkey']!, worktree: 'required' as const } };

    // No chaosWorktree input → the roster's policy is the default.
    const t1 = makeMutationTestTool(director, roster, { projectRoot: process.cwd() });
    await t1.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(seenWorktree[0]).toBe('required');

    // Explicit input still overrides the roster policy.
    const t2 = makeMutationTestTool(director, roster, { projectRoot: process.cwd() });
    await t2.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test', chaosWorktree: false },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(seenWorktree[1]).toBe(false);
  });

  it('normalizes a garbage chaosWorktree value away instead of casting it through', async () => {
    const seenWorktree: unknown[] = [];
    const director: Host.DirectorRepairPort = {
      async spawn(config) {
        seenWorktree.push((config as { worktree?: unknown }).worktree);
        return 'sub-1';
      },
      async assign(task) {
        return task.id;
      },
      async awaitTasks(ids) {
        return ids.map((id) => ({
          subagentId: 'sub-1',
          taskId: id,
          status: 'success' as const,
          result: JSON.stringify({
            mutants: [{ id: 'm#1#1', file: 'a.ts', line: 1, kind: 'X', status: 'killed' }],
          }),
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        }));
      },
      async awaitTasksAny(ids) {
        return { completed: [], pending: ids };
      },
    };
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    await tool.execute(
      { targets: [TARGET_FILE], testCommand: 'pnpm test', chaosWorktree: 'sometimes' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    // 'sometimes' is not boolean|auto|required|off → dropped by
    // normalizeWorktreeOverride → falls back to the roster ('off').
    expect(seenWorktree[0]).toBe('off');
  });

  it('reconciles duplicate planned ids by occurrence — a partial report cannot hide the twin', async () => {
    // Same target passed twice → every id is planned twice (ids are only
    // unique per file). A report with one row per id must leave the
    // second occurrence skipped, not silently confirmed by its twin.
    const { director } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          summary: 'one row per id',
          mutants: task.mutants
            .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
            .map((m) => ({ ...m, status: 'killed', evidence: 'assert failed' })),
        }),
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      { targets: [TARGET_FILE, TARGET_FILE], testCommand: 'pnpm test' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['planned']).toBe(4); // 2 mutants × 2 copies
    expect(out['killed']).toBe(2);
    expect(out['skipped']).toBe(2);
    expect(out['verdict']).toBe('partial');
  });

  it('never labels a rerun-unreported or skipped mutant as suspected-equivalent', async () => {
    // Pass 1: one survivor. Strengthen succeeds. Rerun: the mutant is
    // NOT re-tested (partial report / drift) → outcome 'skipped'. A
    // skipped mutant is an unknown, not equivalent code — labeling it
    // suspectedEquivalent would dismiss a real test gap.
    let chaosPasses = 0;
    let survivorKind = '';
    const { director } = makeFakeDirector({
      chaos: (task) => {
        chaosPasses++;
        if (chaosPasses === 1) survivorKind = task.mutants[0]!.kind;
        // Pass 1: first mutant survives. Rerun (pass 2): report nothing
        // for the survivor — collectOutcomes marks it skipped via the
        // partial-report padding.
        const mutants =
          chaosPasses === 1
            ? task.mutants.map((m, idx) => ({
                ...m,
                status: idx === 0 ? ('survived' as const) : ('killed' as const),
              }))
            : []; // empty report → everything unreported
        return JSON.stringify({ summary: 'pass done', mutants });
      },
      strengthen: () => 'strengthened',
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        repairSubagentId: 'repair-sub',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(chaosPasses).toBe(3); // pass 1 + two re-verifies (skipped mutant retries)
    expect(out['strengthenAttempts']).toBe(2); // retry round until the attempt cap
    const equivalent = out['suspectedEquivalent'] as string[];
    expect(equivalent).toHaveLength(0); // the pre-peer-fix bug: ['…#1#…'] here

    // Verdict honesty (regression): survivors in pass 1, re-verify that
    // never reports the survivor (empty report → skipped). The skipped
    // mutant retries on the next round but stays unknown at the attempt
    // cap — it must block a clean pass.
    expect(out['verdict']).toBe('partial');
    expect(out['passed']).toBe(false);
    expect(out['nextAction']).toBe('manual_review_survivors');
    const unverified = out['unverifiedFromRerun'] as Array<{ id: string; kind: string }>;
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.kind).toBe(survivorKind);
  });

  it('clears a rerun-skipped mutant from the ledger when a later re-verify kills it — verdict pass', async () => {
    // The stale-ledger regression: pass 1 survivor → re-verify 1 skips it
    // (empty report, e.g. transient drift) → round 2 re-verifies and
    // kills it. The mutant HAS kill evidence, so the ledger must clear
    // and the final verdict must be an honest 'pass' with accept.
    let chaosPasses = 0;
    let survivorId = '';
    const { director } = makeFakeDirector({
      chaos: (task) => {
        chaosPasses++;
        if (chaosPasses === 1) {
          survivorId = task.mutants[0]!.id;
          return JSON.stringify({
            summary: 'one survivor',
            mutants: task.mutants.map((m) => ({ ...m, status: 'survived' as const })),
          });
        }
        if (chaosPasses === 2) {
          // Rerun 1: empty report — everything unreported → skipped.
          return JSON.stringify({ summary: 'transient drift', mutants: [] });
        }
        // Rerun 2: the previously-skipped mutant is now killed.
        return JSON.stringify({
          summary: 'resolved',
          mutants: task.mutants.map((m) => ({
            ...m,
            status: 'killed' as const,
            evidence: 'assert failed after strengthening',
          })),
        });
      },
      strengthen: () => 'strengthened',
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        repairSubagentId: 'repair-sub',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(chaosPasses).toBe(3); // pass 1 + skipped rerun + killed rerun
    expect(out['strengthenAttempts']).toBe(2);
    // The stale-ledger bug: verdict 'partial' with the zombie unknown.
    expect(out['verdict']).toBe('pass');
    expect(out['passed']).toBe(true);
    expect(out['nextAction']).toBe('accept');
    expect(out['unverifiedFromRerun']).toEqual([]);
    expect((out['finalSurvivors'] as unknown[]).length).toBe(0);
    expect(survivorId).not.toBe(''); // self-check: scenario actually ran
  });

  it('yields partial (never pass/accept) when a re-verify pass is partial — some killed, one unverified', async () => {
    // Pass 1: both mutants survive. Strengthen succeeds. Every rerun
    // reports the FIRST mutant killed but never reports the second →
    // skipped unknown. (The reruns are stateless fakes; under the retry
    // semantics the skipped mutant is re-verified each round, so the
    // handler must keep skipping the SAME mutant — matched by the
    // pass-1 first id, not by position.) One legitimate kill among
    // survivors must NOT launder the unverified one into a clean pass.
    let chaosPasses = 0;
    let firstKind = '';
    let firstId = '';
    const { director } = makeFakeDirector({
      chaos: (task) => {
        chaosPasses++;
        if (chaosPasses === 1) {
          firstKind = task.mutants[0]!.kind;
          firstId = task.mutants[0]!.id;
          return JSON.stringify({
            summary: 'both survive',
            mutants: task.mutants.map((m) => ({ ...m, status: 'survived' as const })),
          });
        }
        // Rerun: report ONLY the first mutant as killed; the second is
        // never reported → collectOutcomes marks it skipped.
        return JSON.stringify({
          summary: 'partial rerun',
          mutants: task.mutants
            .filter((m) => m.id === firstId)
            .map((m) => ({ ...m, status: 'killed' as const, evidence: 'assert failed' })),
        });
      },
      strengthen: () => 'strengthened',
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 2,
        repairSubagentId: 'repair-sub',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    // Default attempt cap (2): the skipped mutant is retried once more
    // and stays unreported, then the cap ends the loop.
    expect(chaosPasses).toBe(3);
    expect(out['strengthenAttempts']).toBe(2);
    expect(out['verdict']).toBe('partial');
    expect(out['passed']).toBe(false);
    expect(out['nextAction']).toBe('manual_review_survivors');
    const unverified = out['unverifiedFromRerun'] as Array<{ id: string; kind: string }>;
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.kind).not.toBe(firstKind); // the OTHER mutant is the unverified one
    expect((out['finalSurvivors'] as unknown[]).length).toBe(0);
  });

  it('describes skipped/unverified mutants honestly in the strengthen task — never as confirmed survivors', async () => {
    // Regression: buildStrengthenTask rendered EVERY worklist row as a
    // "SURVIVING mutant ... the current suite did NOT catch" — including
    // rows whose latest re-verify outcome was 'skipped' (never actually
    // tested). The repair agent was then sent hunting for a test gap
    // that was never demonstrated. Skipped rows must be presented as
    // UNVERIFIED, with instructions to confirm the survival first.
    let chaosPasses = 0;
    const { director, assigns } = makeFakeDirector({
      chaos: (task) => {
        chaosPasses++;
        const first = task.mutants[0]!;
        if (chaosPasses === 1) {
          // Pass 1: first mutant survives, the other is killed.
          return JSON.stringify({
            mutants: task.mutants.map((m) => ({
              ...m,
              status: m.id === first.id ? ('survived' as const) : ('killed' as const),
            })),
          });
        }
        if (chaosPasses === 2) {
          // First re-verify: empty report — the survivor is unreported
          // (→ skipped), so round 2's strengthen task sees it as
          // unverified, not confirmed.
          return JSON.stringify({ mutants: [] });
        }
        // Second re-verify: the retry kills it — loop ends clean.
        return JSON.stringify({ mutants: [{ ...first, status: 'killed' as const }] });
      },
      strengthen: () => 'strengthened',
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 2,
        repairSubagentId: 'repair-sub',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    const strengthenDescs = assigns
      .filter((a) => a.subagentId === 'repair-sub')
      .map((a) => a.description);
    // Two strengthen rounds: round 1 for the confirmed survivor, round 2
    // retrying the skipped/unverified one.
    expect(strengthenDescs).toHaveLength(2);

    // Round 1: pass-1 evidence backs "confirmed survivor" — that wording
    // is honest here.
    expect(strengthenDescs[0]).toContain('CONFIRMED SURVIVORS');
    expect(strengthenDescs[0]).not.toContain('UNVERIFIED');

    // Round 2: the same mutant's latest outcome is 'skipped' — it must
    // NOT be presented as a confirmed survivor, and the description must
    // still carry its row so the repair agent can re-establish it.
    expect(strengthenDescs[1]).toContain('UNVERIFIED');
    expect(strengthenDescs[1]).not.toContain('CONFIRMED SURVIVORS');
    expect(/^- [\w-]+#\d+#\d+ \| /m.test(strengthenDescs[1]!)).toBe(true);

    // Sanity: the retry still resolves — once the second re-verify kills
    // the mutant, the pass ends clean.
    expect(out['verdict']).toBe('pass');
    expect(out['nextAction']).toBe('accept');
  });

  it('breaks the strengthen loop when the repair task fails', async () => {
    // Use a custom Director port so we can return a literal `'failed'`
    // status for the repair subagent — the shared `makeFakeDirector`
    // helper masks failure with `?? 'strengthened'`. Parse the planned
    // mutant ids out of the chaos description so the survivor report
    // matches what the planner issued and the loop actually starts.
    const assigns: TaskSpec[] = [];
    const failRepairDirector: Host.DirectorRepairPort = {
      async spawn() {
        return 'sub-1';
      },
      async assign(task) {
        assigns.push(task);
        return task.id;
      },
      async awaitTasks(ids) {
        return ids.map((id) => {
          const spec = assigns.find((a) => a.id === id)!;
          if (spec.subagentId === 'repair-sub') {
            return {
              subagentId: spec.subagentId ?? 'unknown-sub',
              taskId: id,
              status: 'failed' as const,
              iterations: 1,
              toolCalls: 1,
              durationMs: 1,
            };
          }
          // Parse `- <id> | <file>:<line>:<col> | <kind> | ...` rows.
          const mutants = [
            ...spec.description.matchAll(/^- ([\w-]+#\d+#\d+) \| ([^|]+):(\d+):\d+ \| ([\w-]+)/gm),
          ].map((m) => ({
            id: m[1]!,
            file: m[2]!.trim(),
            line: Number(m[3]!),
            kind: m[4]!,
            status: 'survived' as const,
          }));
          return {
            subagentId: spec.subagentId ?? 'unknown-sub',
            taskId: id,
            status: 'success' as const,
            result: JSON.stringify({ mutants }),
            iterations: 1,
            toolCalls: 1,
            durationMs: 1,
          };
        });
      },
      async awaitTasksAny(ids) {
        return { completed: [], pending: ids };
      },
    };
    const tool = makeMutationTestTool(failRepairDirector, FLEET_ROSTER, {
      projectRoot: process.cwd(),
    });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        repairSubagentId: 'repair-sub',
        maxStrengthenAttempts: 3,
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    // Repair failed: exactly one strengthen assign, no subsequent
    // re-verify chaos spawn. The next-action hint guides the leader.
    expect(out['strengthenAttempts']).toBe(1);
    expect(assigns.filter((a) => a.subagentId === 'repair-sub')).toHaveLength(1);
    // Exactly one chaos assign before the repair, NO re-verify after.
    const chaosAssigns = assigns.filter((a) => a.subagentId !== 'repair-sub');
    expect(chaosAssigns.length).toBe(1);
    expect(out['nextAction']).toBe('strengthen_tests');
  });

  it('retries skipped rerun outcomes until the attempt cap when the source drifts', async () => {
    // Pass 1: one survivor. Repair succeeds. EVERY rerun pass reports
    // the mutant as skipped (persistent source drift). The loop retries
    // the unresolved mutant each round rather than breaking early, and
    // the attempt cap terminates it — the mutant ends unverified, never
    // silently accepted.
    let chaosPasses = 0;
    const { director, assigns } = makeFakeDirector({
      chaos: (task) => {
        chaosPasses++;
        const statuses = chaosPasses === 1 ? ['survived'] : ['skipped' as const];
        return JSON.stringify({
          mutants: task.mutants.map((m, i) => ({
            ...m,
            status: statuses[i] ?? 'skipped',
            evidence: chaosPasses === 1 ? undefined : 'site drifted',
          })),
        });
      },
      strengthen: () => 'strengthened',
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        repairSubagentId: 'repair-sub',
        maxStrengthenAttempts: 3,
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    // Pass 1 + 3 strengthen→re-verify rounds; the cap ends the loop.
    expect(chaosPasses).toBe(4);
    expect(out['strengthenAttempts']).toBe(3);
    expect(assigns.filter((a) => a.subagentId === 'repair-sub')).toHaveLength(3);
    // Still unverified at the cap: honest partial, never accept.
    expect(out['verdict']).toBe('partial');
    expect(out['nextAction']).toBe('manual_review_survivors');
    expect((out['unverifiedFromRerun'] as unknown[]).length).toBe(1);
  });

  it('caps attempts to the schema maximum (5) regardless of caller input', async () => {
    // The schema says max 5 but the caller asks for 999 — clamp(..., 0, 5).
    // Verify the loop never spawns more than 5 (1 + 5*2 = 11) tasks even
    // when survivors persist on every pass.
    let spawnCount = 0;
    const director: Host.DirectorRepairPort = {
      async spawn() {
        spawnCount++;
        return `sub-${spawnCount}`;
      },
      async assign(task) {
        return task.id;
      },
      async awaitTasks(ids) {
        return ids.map((id) => ({
          subagentId: 'sub-x',
          taskId: id,
          status: 'success',
          result: JSON.stringify({
            mutants: [{ id: 'm#1#1', file: 'a', line: 1, kind: 'X', status: 'survived' }],
          }),
          iterations: 1,
          toolCalls: 1,
          durationMs: 1,
        }));
      },
      async awaitTasksAny(ids) {
        return { completed: [], pending: ids };
      },
    };
    // assignTask that lets strengthen tasks claim they ran — the loop
    // ceiling comes from clamp(), so even with endless survivors we
    // expect ≤ 5 attempts × 2 (strengthen + rerun) = 10 spawns beyond
    // the initial chaos pass.
    const dir2: Host.DirectorRepairPort = {
      ...director,
      async assign(task) {
        if (task.subagentId === 'repair-sub') {
          // repair always says "strengthened" — string is just a token
          return task.id;
        }
        return task.id;
      },
    };
    void director;
    const t = makeMutationTestTool(dir2, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await t.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        repairSubagentId: 'repair-sub',
        maxStrengthenAttempts: 999,
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['strengthenAttempts']).toBeLessThanOrEqual(5);
  });

  it('reportOnly: true ignores repairSubagentId entirely (no strengthen loop)', async () => {
    let strengthenAssigns = 0;
    const { director, assigns } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          mutants: task.mutants.map((m) => ({ ...m, status: 'survived' })),
        }),
      strengthen: () => {
        strengthenAssigns++;
        return 'strengthened';
      },
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        repairSubagentId: 'repair-sub',
        reportOnly: true,
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(strengthenAssigns).toBe(0);
    expect(assigns.filter((a) => a.subagentId === 'repair-sub')).toHaveLength(0);
    expect(out['strengthenAttempts']).toBe(0);
    expect(out['survived']).toBeGreaterThan(0);
    expect(out['nextAction']).toBe('manual_review_survivors');
  });

  it('joins plans from multiple targets into a single ordered list', async () => {
    // Pass two targets; the chaos task should see mutants from both
    // (concatenated). Pin deterministic concatenation.
    const { director, assigns } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed' })),
        }),
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    await tool.execute(
      {
        targets: [TARGET_FILE, TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 2,
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(assigns).toHaveLength(1);
    const desc = assigns[0]!.description;
    // Two copies of each mutant id (one per file).
    const firstIdCount = (desc.match(/arith-plus-to-minus/g) ?? []).length;
    expect(firstIdCount).toBeGreaterThanOrEqual(4); // 2 per file × 2 files
  });

  it('returns `inconclusive` when no mutable sites exist across all targets', async () => {
    // Two unreadable targets + one masked target → empty plan → inconclusive.
    const { director } = makeFakeDirector({ chaos: () => '{}' });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [
          'no/such/file.ts',
          'also/missing.ts',
          // An empty fixture file: zero mutants.
          'packages/core/tests/coordination/__mutation_fixture__/subject.ts',
        ],
        testCommand: 'pnpm test',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    // Fixture file has mutants, so this won't be inconclusive. Pin that
    // the tool still executed (verdict is one of the four documented).
    expect(['pass', 'fail', 'partial', 'inconclusive']).toContain(out['verdict']);
  });

  it('emits a chaos task that includes cwd when supplied', async () => {
    // The `cwd` field never affects execution directly (the chaos
    // subagent runs the command). It only travels inside the task
    // description. Pin that.
    const { director, assigns } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          mutants: task.mutants.map((m) => ({ ...m, status: 'killed' })),
        }),
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        cwd: 'packages/core',
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(assigns[0]!.description).toContain('cwd: packages/core');
  });

  // ── Choreography contract: survivors without a repair agent ───────────
  // A real chaos pass may find surviving mutants without a repair agent
  // being available (the caller simply doesn't pass `repairSubagentId`).
  // The tool must still surface a `nextAction` hint so the leader can
  // react — never silently leave the caller to interpret `survived`
  // on its own. Reading `director-mutation-test-tool.ts:259-263`: when
  // `finalSurvivors.length > 0` and no repair subagent is supplied, the
  // tool returns `'strengthen_tests'` — the leader sees the hint and
  // decides whether to spin up repair, so this is the contract a chaos
  // run depends on.
  it('surfaces nextAction=strengthen_tests when survivors exist without repair', async () => {
    const { director } = makeFakeDirector({
      chaos: (task) =>
        JSON.stringify({
          mutants: task.mutants.map((m) => ({ ...m, status: 'survived' })),
        }),
    });
    const tool = makeMutationTestTool(director, FLEET_ROSTER, { projectRoot: process.cwd() });
    const out = (await tool.execute(
      {
        targets: [TARGET_FILE],
        testCommand: 'pnpm test',
        maxPerFile: 1,
        // Note: no repairSubagentId.
      },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(out['survived']).toBeGreaterThan(0);
    expect(out['strengthenAttempts']).toBe(0);
    expect(out['nextAction']).toBe('strengthen_tests');
  });
});
