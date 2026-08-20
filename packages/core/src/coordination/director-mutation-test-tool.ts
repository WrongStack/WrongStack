/**
 * `mutation_test` — director-facing tool behind the Chaos Monkey
 * ("Kaos Maymunu") mutation-testing flow.
 *
 * Green tests prove nothing if they cannot detect sabotage. This tool:
 *   1. Reads each target file in-process and computes a DETERMINISTIC
 *      mutation plan (`mutation-engine.ts`) — boundary relax/tighten,
 *      `+`↔`-`, boolean flips, `return null`.
 *   2. Spawns ONE chaos-monkey subagent with the exact plan. The subagent
 *      applies each mutant one at a time in its checkout, runs the test
 *      command, records killed/survived, and restores byte-for-byte.
 *   3. Parses the structured report and, when survivors exist and a
 *      `repairSubagentId` was supplied, loops: strengthen-tests task →
 *      re-run the surviving mutants only. A mutant that survives twice
 *      is reported as `suspected-equivalent` — a code smell, not a test
 *      bug — so the loop always terminates without ping-ponging.
 *
 * The LLM never invents mutants: the plan is mechanical, so two runs over
 * the same source produce the same ids and the comparison is honest.
 *
 * @module coordination/director-mutation-test-tool
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { ToolCapabilities } from '../security/capabilities.js';
import type * as Host from './director-host-contracts.js';
import { instantiateRosterConfig, normalizeWorktreeOverride, stringArray } from './director-input-helpers.js';
import { type MutationPlanItem, parseMutationReport, planMutations } from './mutation-engine.js';

/** Mutants per file kept per pass — keeps one spawn bounded. */
const DEFAULT_MAX_PER_FILE = 10;
/** Default strengthen→re-verify attempts before survivors are declared equivalent. */
const DEFAULT_MAX_STRENGTHEN_ATTEMPTS = 2;
const CHAOS_ROLE = 'chaos-monkey';

interface MutationTestInput {
  targets: string[];
  testCommand: string;
  /** Optional cwd for the test command (defaults to project root). */
  cwd?: string | undefined;
  maxPerFile?: number | undefined;
  maxStrengthenAttempts?: number | undefined;
  repairSubagentId?: string | undefined;
  /** Worktree override for the chaos agent; falls back to the roster entry's policy, else 'off'. */
  chaosWorktree?: SubagentConfig['worktree'] | undefined;
  timeoutMs?: number | undefined;
  /** Skip the strengthen loop even when survivors exist. */
  reportOnly?: boolean | undefined;
}

interface MutantOutcome {
  id: string;
  file: string;
  line: number;
  kind: string;
  status: 'killed' | 'survived' | 'skipped';
  evidence?: string | undefined;
}

interface StrengthenAttempt {
  attempt: number;
  survivorsBefore: MutantOutcome[];
  strengthenResult?: { taskId: string; status: string } | undefined;
  rerunResult?: { taskId: string; status: string } | undefined;
  survivorsAfter: MutantOutcome[];
  /** Ids that survived both the original pass and the re-verify pass. */
  suspectedEquivalent: string[];
}

export function makeMutationTestTool(
  director: Host.DirectorRepairPort,
  roster?: Record<string, SubagentConfig>,
  opts: { projectRoot?: string | undefined } = {},
): Tool {
  return {
    name: 'mutation_test',
    description:
      'Chaos Monkey mutation testing: deterministically sabotage boundary conditions in the target code (> to >=, + to -, boolean flips, return null), re-run the tests per mutant, and report which mutants were killed. Surviving mutants mean the tests are weak — optionally loop a strengthen-tests repair until they die.',
    usageHint:
      'Use after writing new code AND its tests, before delivering. Pass targets (files) and testCommand. Provide repairSubagentId to auto-strengthen weak tests. Survivors that persist are reported as suspected-equivalent.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Project-relative (or absolute) source files to mutate. Keep to files changed by the current task.',
        },
        testCommand: {
          type: 'string',
          description:
            'Exact command that runs the relevant tests, e.g. "pnpm exec vitest run packages/core/tests/coordination/mutation-engine.test.ts".',
        },
        cwd: { type: 'string', description: 'Working directory for the test command.' },
        maxPerFile: {
          type: 'number',
          minimum: 1,
          maximum: 25,
          description: 'Mutant cap per file per pass. Default 10.',
        },
        maxStrengthenAttempts: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description: 'Strengthen→re-verify rounds. Default 2 when repairSubagentId is set, else 0.',
        },
        repairSubagentId: {
          type: 'string',
          description:
            'Subagent that owns the tests. When set and mutants survive, it receives a strengthen-tests task and the survivors are re-verified.',
        },
        chaosWorktree: {
          anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
          description:
            "Worktree override for the chaos agent. Defaults to the roster policy for chaos-monkey ('off'), because mutation targets are usually freshly written and uncommitted — a worktree from HEAD would not contain them and every mutant would drift to skipped. Only pass 'auto' or 'required' when the targets are committed.",
        },
        timeoutMs: { type: 'number', minimum: 1, description: 'Per-task timeout for chaos/strengthen/rerun tasks.' },
        reportOnly: {
          type: 'boolean',
          description: 'Skip the strengthen loop even when survivors exist. Default false.',
        },
      },
      required: ['targets', 'testCommand'],
      additionalProperties: false,
    } satisfies JSONSchema,
    async execute(input, ctx) {
      const i = normalizeMutationTestInput(input);
      const root = opts.projectRoot ?? ctx.projectRoot;
      const plan = buildPlan(i, root);
      if (plan.length === 0) {
        return {
          verdict: 'inconclusive',
          passed: false,
          error: 'No mutable sites found in the given targets (after comment/string filtering).',
        };
      }

      // ── Pass 1: chaos agent executes the deterministic plan ──────────
      // Loud preflight: without the roster entry the spawn would carry no
      // prompt, tools, or skills — a silent contract strip. The catalog
      // cannot rescue it (`chaos-monkey` is deliberately outside
      // ALL_AGENT_DEFINITIONS), so a missing entry is a hard stop.
      const chaosBase = roster?.[CHAOS_ROLE];
      if (!chaosBase) {
        return {
          verdict: 'inconclusive',
          passed: false,
          error:
            "chaos-monkey role missing from the roster — refusing to spawn a saboteur without its prompt/tools contract. Build the toolset with a roster that includes 'chaos-monkey' (FLEET_ROSTER does).",
        };
      }
      const chaosSubagentId = await director.spawn(
        makeChaosConfig(chaosBase, i.chaosWorktree ?? chaosBase.worktree ?? 'off'),
      );
      const chaosTaskId = await director.assign({
        id: randomUUID(),
        subagentId: chaosSubagentId,
        description: buildChaosTask(plan, i, 1, []),
        timeoutMs: i.timeoutMs,
      });
      const [chaosResult] = await director.awaitTasks([chaosTaskId]);
      const pass1 = collectOutcomes(chaosResult, plan);
      const survivors = pass1.filter((m) => m.status === 'survived');

      const maxAttempts = clamp(
        i.maxStrengthenAttempts ?? (i.repairSubagentId && !i.reportOnly ? DEFAULT_MAX_STRENGTHEN_ATTEMPTS : 0),
        0,
        5,
      );
      const attempts: StrengthenAttempt[] = [];
      let current = survivors;
      // Outcomes still lacking a verdict from the LAST completed
      // re-verify round — recomputed each round from that round's
      // skipped rows. Unresolved occurrences never leave the worklist,
      // so the latest round's skips are exactly the unverified set.
      let rerunUnknowns: MutantOutcome[] = [];

      // ── Strengthen loop: repair → re-verify SURVIVORS ONLY ────────────
      while (current.length > 0 && attempts.length < maxAttempts && i.repairSubagentId) {
        const attemptNo = attempts.length + 1;
        const strengthenTaskId = await director.assign({
          id: randomUUID(),
          subagentId: i.repairSubagentId,
          description: buildStrengthenTask(current, i, attemptNo),
          timeoutMs: i.timeoutMs,
        });
        const [strengthenResult] = await director.awaitTasks([strengthenTaskId]);

        if (strengthenResult?.status !== 'success') {
          attempts.push({
            attempt: attemptNo,
            survivorsBefore: current,
            strengthenResult: strengthenResult
              ? { taskId: strengthenResult.taskId, status: strengthenResult.status }
              : undefined,
            survivorsAfter: current,
            suspectedEquivalent: [],
          });
          break;
        }

        // Re-verify only the surviving mutants (they still exist in the
        // target source unless the strengthen task changed the code itself).
        const survivorPlan = plan.filter((p) => current.some((s) => s.id === p.id));
        const rerunSubagentId = await director.spawn(
          makeChaosConfig(chaosBase, i.chaosWorktree ?? chaosBase.worktree ?? 'off'),
        );
        const rerunTaskId = await director.assign({
          id: randomUUID(),
          subagentId: rerunSubagentId,
          description: buildChaosTask(survivorPlan, i, attemptNo + 1, current),
          timeoutMs: i.timeoutMs,
        });
        const [rerunResult] = await director.awaitTasks([rerunTaskId]);
        const passN = collectOutcomes(rerunResult, survivorPlan);
        // Killed mutants leave the worklist; skipped/unreported ones STAY
        // in it so a later attempt can re-verify them (bounded by
        // maxAttempts) — a skip is an unknown, not a verdict.
        const stillSurviving = passN.filter((m) => m.status !== 'killed');
        // Ledger = THIS round's skipped outcomes, recomputed per round.
        // Occurrence-correct by construction: every unresolved occurrence
        // stays in the worklist and is re-presented in each later round's
        // re-verify, so a skip in an earlier round is forgiven the moment
        // a later round reports that occurrence killed — and a kill of
        // one twin occurrence never forgives the other (ids are only
        // unique per file; report rows reconcile to OCCURRENCES inside
        // collectOutcomes, and this list mirrors those rows exactly —
        // never an id-keyed findIndex/splice, which would merge twins).
        rerunUnknowns = passN.filter((m) => m.status === 'skipped');

        attempts.push({
          attempt: attemptNo,
          survivorsBefore: current,
          strengthenResult: { taskId: strengthenResult.taskId, status: strengthenResult.status },
          rerunResult: { taskId: rerunTaskId, status: rerunResult?.status ?? 'unknown' },
          survivorsAfter: stillSurviving,
          suspectedEquivalent: stillSurviving
            .filter((m) => m.status === 'survived' && current.some((c) => c.id === m.id))
            .map((m) => m.id),
        });
        current = stillSurviving;
      }

      // Skipped leftovers are unverified, not survivors — they live in
      // rerunUnknowns; only mutants still actively surviving block the
      // verdict as survivors.
      const finalSurvivors = current.filter((m) => m.status === 'survived');
      const verifiedCount = pass1.filter((m) => m.status !== 'skipped').length;
      const skippedCount = pass1.filter((m) => m.status === 'skipped').length;
      // Unknowns from re-verify passes count against a clean pass exactly
      // like first-pass skips: a mutant that was never re-tested was never
      // killed, whatever `finalSurvivors` being empty implies.
      const rerunUnknownCount = rerunUnknowns.length;
      const score =
        plan.length === 0 ? 0 : pass1.filter((m) => m.status === 'killed').length / plan.length;
      // Honest verdicts: a pass requires zero survivors AND zero unknowns
      // (first-pass skips AND re-verify skips alike). A failed/failed-to-
      // parse chaos pass is 'inconclusive' — claiming a green gate
      // without evidence is exactly the failure mode this tool exists
      // to catch.
      const verdict =
        verifiedCount === 0
          ? 'inconclusive'
          : finalSurvivors.length === 0
            ? skippedCount > 0 || rerunUnknownCount > 0
              ? 'partial'
              : 'pass'
            : score >= 0.8
              ? 'partial'
              : 'fail';

      return {
        verdict,
        passed: verdict === 'pass',
        mutationScore: Number.parseFloat(score.toFixed(3)),
        planned: plan.length,
        killed: pass1.filter((m) => m.status === 'killed').length,
        survived: pass1.filter((m) => m.status === 'survived').length,
        skipped: pass1.filter((m) => m.status === 'skipped').length,
        finalSurvivors: finalSurvivors.map((m) => ({ id: m.id, file: m.file, kind: m.kind })),
        suspectedEquivalent: attempts.flatMap((a) => a.suspectedEquivalent),
        strengthenAttempts: attempts.length,
        attempts,
        chaosTaskId,
        // Unverified leftovers from the strengthen loop: surfaced so the
        // caller can see WHICH mutants lack kill evidence, and counted by
        // the verdict gate above.
        unverifiedFromRerun: rerunUnknowns.map((m) => ({ id: m.id, file: m.file, kind: m.kind })),
        nextAction:
          finalSurvivors.length === 0 && rerunUnknownCount === 0 && skippedCount === 0
            ? 'accept'
            : attempts.length >= maxAttempts && i.repairSubagentId
              ? 'manual_review_survivors'
              : 'strengthen_tests',
      };
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function normalizeMutationTestInput(input: unknown): MutationTestInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const targets = stringArray(raw['targets']) ?? [];
  const testCommand = typeof raw['testCommand'] === 'string' ? raw['testCommand'].trim() : '';
  return {
    targets: targets.filter(Boolean),
    testCommand,
    cwd: typeof raw['cwd'] === 'string' && raw['cwd'].trim() ? raw['cwd'].trim() : undefined,
    maxPerFile: typeof raw['maxPerFile'] === 'number' ? raw['maxPerFile'] : undefined,
    maxStrengthenAttempts:
      typeof raw['maxStrengthenAttempts'] === 'number' ? raw['maxStrengthenAttempts'] : undefined,
    repairSubagentId:
      typeof raw['repairSubagentId'] === 'string' && raw['repairSubagentId'].trim()
        ? raw['repairSubagentId'].trim()
        : undefined,
    chaosWorktree: normalizeWorktreeOverride(raw['chaosWorktree']),
    timeoutMs: typeof raw['timeoutMs'] === 'number' ? raw['timeoutMs'] : undefined,
    reportOnly: raw['reportOnly'] === true,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function buildPlan(i: MutationTestInput, projectRoot: string | undefined): MutationPlanItem[] {
  const plan: MutationPlanItem[] = [];
  for (const target of i.targets) {
    const abs = isAbsolute(target) ? target : join(projectRoot ?? process.cwd(), target);
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable target — surfaced via zero-plan error when all fail
    }
    plan.push(...planMutations(target, source, { maxPerFile: i.maxPerFile ?? DEFAULT_MAX_PER_FILE }));
  }
  return plan;
}

function makeChaosConfig(base: SubagentConfig, worktree: SubagentConfig['worktree']): SubagentConfig {
  return { ...instantiateRosterConfig(CHAOS_ROLE, base), worktree };
}

function buildChaosTask(
  plan: MutationPlanItem[],
  i: MutationTestInput,
  pass: number,
  priorSurvivors: MutantOutcome[],
): string {
  const mutants = plan
    .map(
      (m) =>
        `- ${m.id} | ${m.file}:${m.line}:${m.column} | ${m.kind} | "${m.original}" -> "${m.replacement}"`,
    )
    .join('\n');
  const prior =
    priorSurvivors.length > 0
      ? `\nThese mutants survived a previous pass (pass ${pass - 1}) — re-verify them against the STRENGTHENED tests:\n${priorSurvivors
          .map((s) => `- ${s.id} (${s.kind} @ ${s.file}:${s.line})`)
          .join('\n')}`
      : '';
  return [
    'Execute this deterministic mutation plan against the current checkout.',
    '',
    'For each mutant, in order:',
    '1. Apply ONLY that mutation at its exact (file, line, column).',
    `2. Run the test command: ${i.testCommand}${i.cwd ? ` (cwd: ${i.cwd})` : ''}`,
    '3. Record killed (tests failed — quote first failing assertion) or survived (suite green).',
    '4. Restore the file byte-for-byte before the next mutant.',
    '',
    'Mutants:',
    mutants,
    prior,
    '',
    'Rules: one mutation at a time; never stack; if the anchored token no longer matches, mark skipped with the drift as evidence; do not fix or refactor anything; stay inside the plan.',
    'Finish with submit_result, then repeat the same JSON as your final text.',
  ].join('\n');
}

function buildStrengthenTask(survivors: MutantOutcome[], i: MutationTestInput, attempt: number): string {
  return [
    `Strengthen the tests so these SURVIVING mutants die (attempt ${attempt}).`,
    '',
    'Each survivor below was a deliberate sabotage of production code that the current suite did NOT catch:',
    ...survivors.map((s) => `- ${s.id} | ${s.file}:${s.line} | ${s.kind}${s.evidence ? ` | ${s.evidence}` : ''}`),
    '',
    `Test command that must fail under each mutant: ${i.testCommand}`,
    '',
    'For each survivor add or tighten exactly one assertion that pins the sabotaged boundary/behavior. Do not change production code. Do not weaken other tests. Run the suite green on clean code before finishing.',
  ].join('\n');
}

function collectOutcomes(result: TaskResult | undefined, plan: MutationPlanItem[]): MutantOutcome[] {
  const fromText = parseTextOutcomes(result);
  if (fromText.length > 0) {
    // Reconcile by OCCURRENCE, not by id set: ids are only unique per
    // file (`kind#line#col`), so a plan can legitimately carry duplicate
    // ids (the same target passed twice, or two roots projecting to the
    // same relative path). Each reported row consumes exactly one planned
    // occurrence; an agent-echoed unknown id consumes nothing and cannot
    // skew the killed/survived ratio.
    const remaining = [...plan];
    const matched: MutantOutcome[] = [];
    for (const m of fromText) {
      const idx = remaining.findIndex((p) => p.id === m.id);
      if (idx === -1) continue;
      remaining.splice(idx, 1);
      matched.push(m);
    }
    if (matched.length > 0) {
      // A valid-but-partial report must not make the unreported mutants
      // vanish: a planned occurrence with no outcome row is an unknown,
      // and the verdict gates count unknowns as skipped — never as
      // silent kills.
      const missing: MutantOutcome[] = remaining.map((p) => ({
        id: p.id,
        file: p.file,
        line: p.line,
        kind: p.kind,
        status: 'skipped',
        evidence: 'not reported by chaos task',
      }));
      return [...matched, ...missing];
    }
  }
  // Chaos task failed or produced nothing parseable: every planned mutant is
  // unknown — report as skipped with the failure as evidence rather than
  // silently claiming kills.
  return plan.map((p) => ({
    id: p.id,
    file: p.file,
    line: p.line,
    kind: p.kind,
    status: 'skipped',
    evidence: result ? `chaos task ended ${result.status}` : 'chaos task produced no result',
  }));
}

function parseTextOutcomes(result: TaskResult | undefined): MutantOutcome[] {
  const text = typeof result?.result === 'string' ? result.result : undefined;
  if (!text) return [];
  const parsed = parseMutationReport(text);
  if (!parsed) return [];
  return parsed.mutants.map((m) => ({
    id: m.id,
    file: m.file,
    line: m.line,
    kind: m.kind,
    status: m.status,
    evidence: m.evidence,
  }));
}
