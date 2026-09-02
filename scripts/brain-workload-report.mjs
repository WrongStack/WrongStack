#!/usr/bin/env node
/**
 * Brain workload report — which real decisions actually cost a model call?
 *
 * The determinism work added rules, heuristics and a cache, but whether any
 * of it changes production behaviour depends entirely on the shape of the
 * requests the codebase actually issues. This replays a catalogue of the REAL
 * call sites (harvested from the sources listed against each entry, not
 * invented) through a genuine tier chain whose model is unreachable, and
 * reports which tier claimed each one.
 *
 * The metric is the number of PROVIDER CALLS ATTEMPTED, not the tier that
 * ultimately produced the decision. Those are different things and only the
 * first one costs money: when the model is unreachable the ladder falls
 * through and re-attributes the decision to `policy`, so reading the final
 * tier alone reports "0 model calls" for a workload that in production calls
 * a model every single time.
 *
 * Run:  pnpm brain:workload
 *       pnpm brain:workload --rules   (with the candidate built-in rule pack)
 *
 * Requires a built core (`pnpm --filter @wrongstack/core build`).
 *
 * ## DRIFT HAZARD
 * Nothing in CI checks this catalogue against the call sites it claims to
 * mirror, and it HAS silently drifted: a risk re-map (budget extension
 * high→medium, conflict resolution high→critical) and the removal of the
 * monitor's `recommended` option left the report measuring a workload that no
 * longer existed. Re-verify the `risk`, `fallback` and option shape of an
 * entry against its cited source whenever that source changes — the `risk` in
 * particular decides both whether the council convenes and whether the request
 * clears the autonomy ceiling, so a stale value silently invalidates both
 * columns.
 */

import {
  createAutonomyBrain,
  createTieredBrainArbiter,
  createRuleBrainArbiter,
  compileBrainRules,
  DefaultBrainArbiter,
  readDecisionTier,
} from '../packages/core/dist/index.js';

/** Counts every attempt so we measure spend, not just the final attribution. */
let providerCalls = 0;
const unreachableProvider = {
  id: 'unreachable',
  capabilities: {},
  stream: () => {
    throw new Error('unreachable');
  },
  complete: async () => {
    providerCalls += 1;
    throw new Error('no provider is reachable in the workload report');
  },
};

/**
 * Real request shapes. Each entry cites the source it was taken from so the
 * catalogue can be re-verified when a call site changes.
 */
const WORKLOAD = [
  {
    site: 'coordination/director.ts — subagent budget extension',
    request: {
      id: 'director-budget-sub7-cost',
      source: 'director',
      question: 'Should the director extend the cost budget for subagent sub7?',
      context: 'Task id: t-12\nUsed: 4200\nLimit: 5000\nPrior extensions for this kind: 1',
      // 'medium' since the risk re-map: a cost extension is bounded by hard
      // ceilings and reversible, and it is the most frequent Brain call in a
      // fleet run — it no longer clears the council floor.
      risk: 'medium',
      fallback: 'continue',
      options: [
        { id: 'extend', label: 'Grant the extension', risk: 'medium', recommended: true },
        { id: 'stop', label: 'Stop the subagent', risk: 'low' },
      ],
    },
  },
  {
    site: 'execution/eternal-autonomy.ts — goal completion verdict',
    request: {
      id: 'goal-done-14',
      source: 'system',
      question: 'Brainstorm returned DONE 3x. Is the goal truly complete?',
      context: 'Goal: ship the exporter\nIterations: 14\nProgress: 80%\n2 of 5 deliverables open',
      risk: 'high',
      fallback: 'continue',
      options: [
        { id: 'goal_complete', label: 'The goal is complete', risk: 'high' },
        { id: 'keep_working', label: 'Keep working', risk: 'low' },
      ],
    },
  },
  {
    site: 'goal/phase-orchestrator.ts — merge conflict resolution',
    request: {
      id: 'goal-conflict-p3',
      source: 'goal',
      question: 'Should Goal try to resolve merge conflicts for phase "api" automatically?',
      context: 'Phase id: p3\nConflicted files: src/a.ts, src/b.ts\nBase working tree: /repo',
      // 'critical': choosing `resolve` lets an agent edit files in the BASE
      // working tree — the one irreversible decision in the catalogue.
      risk: 'critical',
      fallback: 'ask_human',
      options: [
        { id: 'resolve', label: 'Try the configured conflict resolver', risk: 'critical' },
        {
          id: 'review',
          label: 'Keep the worktree for human review',
          risk: 'low',
          recommended: true,
        },
      ],
    },
  },
  {
    site: 'storage/goal-coordination.ts — deliverables reached',
    request: {
      id: 'goal-reached-9',
      source: 'system',
      question: 'Have all goal deliverables been reached and verified?',
      context:
        'Goal: ship the exporter\nProgress: 100%\nCompleted deliverables:\n1. schema\n2. writer',
      risk: 'high',
      fallback: 'continue',
      options: [
        { id: 'goal_reached', label: 'Goal reached' },
        { id: 'keep_working', label: 'Keep working' },
      ],
    },
  },
  ...['tool_failure_streak', 'error_storm', 'agent_stall', 'file_churn'].map((kind) => ({
    site: `coordination/brain-monitor.ts — ${kind}`,
    request: {
      id: `brainmon-${kind}`,
      source: 'system',
      question:
        kind === 'tool_failure_streak'
          ? 'The tool "edit" has failed 3 times in a row. Should the agent be steered to a different approach?'
          : kind === 'error_storm'
            ? '4 errors occurred within 60s (phase: tool). Should the agent be steered before more work is wasted?'
            : kind === 'agent_stall'
              ? 'An active run has made no observable progress for 5 minute(s). Should the agent be steered before more time is wasted?'
              : 'The file "src/a.ts" has been edited 5 times within 10 minutes — the agent may be oscillating. Should it be steered?',
      context: 'Tool: edit\nConsecutive failures: 3',
      risk: 'medium',
      fallback: 'ask_human',
      // NO recommended option: "should I interrupt the working agent?" has no
      // caller-known safe default, and marking one made the headless terminal
      // policy auto-steer whenever the pool was unreachable.
      options: [
        { id: 'steer', label: 'Steer the agent with corrective guidance', risk: 'low' },
        { id: 'continue', label: 'Let the agent continue unaided', risk: 'low' },
      ],
    },
  })),
  // Stylized: the real supervisor offers signal-specific option ids
  // (rebalance/wait, spawn/wait, steer/observe/terminate). The RISK per signal
  // is real, and it is what decides whether the council convenes.
  ...[
    ['starvation', 'low'],
    ['overload', 'medium'],
    ['stuck', 'medium'],
    ['failure_streak', 'high'],
  ].map(([kind, risk]) => ({
    site: `coordination/fleet-supervisor.ts — ${kind}`,
    request: {
      id: `fleet-${kind}`,
      source: 'system',
      question: `Fleet signal ${kind} detected. Should the supervisor intervene?`,
      context: 'Pending: 4\nLive workers: 2',
      risk,
      fallback: 'ask_human',
      options: [
        { id: 'act', label: 'Apply the proposed intervention', risk: 'medium', recommended: true },
        { id: 'wait', label: 'Leave the fleet as is', risk: 'low' },
      ],
    },
  })),
];

/** Request-risk ordering, mirroring core's BRAIN_RISK_LEVELS. */
const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
/** Default council floor (`brain.council.minRisk`). */
const COUNCIL_FLOOR = 'high';

/**
 * Candidate built-in rule pack. NOT shipped by default — the point of this
 * report is to show what it would and would not buy before deciding.
 */
const CANDIDATE_RULES = [
  {
    id: 'monitor-steer-on-signal',
    description: 'BrainMonitor signals: take the recommended steer without asking a model.',
    when: { source: 'system', offersOption: 'steer', maxRisk: 'medium' },
    then: { action: 'answer', optionId: 'steer' },
  },
  {
    id: 'fleet-defer-to-recommended',
    description: 'Fleet supervisor signals: accept the rule-proposed intervention.',
    when: { source: 'system', offersOption: 'act', maxRisk: 'medium' },
    then: { action: 'answer', optionId: 'act' },
  },
];

function buildChain(rules, ceiling) {
  const tiered = createTieredBrainArbiter({
    policy: new DefaultBrainArbiter(),
    autonomous: createAutonomyBrain({
      provider: unreachableProvider,
      model: 'unreachable',
      // Inner tier stays permissive; the tiered ceiling does the gating, so
      // `ceiling` alone decides what reaches a model.
      maxAutoRisk: 'all',
    }),
    getMaxAutoRisk: () => ceiling,
  });
  if (!rules?.length) return tiered;
  const { rules: compiled, errors } = compileBrainRules(rules);
  if (errors.length) throw new Error(`rule pack failed to compile: ${errors.join('; ')}`);
  return createRuleBrainArbiter({ inner: tiered, getRules: () => compiled });
}

async function measure(rules, ceiling = 'all') {
  const chain = buildChain(rules, ceiling);
  const rows = [];
  for (const { site, request } of WORKLOAD) {
    const req = structuredClone(request);
    const before = providerCalls;
    await chain.decide(req);
    rows.push({
      site,
      risk: request.risk,
      // Whether a wired council would claim this request instead of the
      // single-LLM tier. Derived, not simulated: the council tier is only
      // consulted at or above `brain.council.minRisk`.
      council: RISK_ORDER[request.risk] >= RISK_ORDER[COUNCIL_FLOOR],
      tier: readDecisionTier(req) ?? 'unattributed',
      calls: providerCalls - before,
    });
  }
  return rows;
}

function render(title, rows, { councilAvailable = true } = {}) {
  const paid = rows.filter((r) => r.calls > 0).length;
  const free = rows.length - paid;
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const width = Math.max(...rows.map((r) => r.site.length));

  console.log(`
${title}`);
  console.log('='.repeat(title.length));
  console.log(
    `  ${'call site'.padEnd(width)}  ${'risk'.padEnd(8)} ${'council'.padEnd(8)} ${'decided by'.padEnd(11)} provider calls`,
  );
  for (const r of rows) {
    const mark = r.calls > 0 ? `${r.calls}  <-- COSTS TOKENS` : '0  free';
    const council = councilAvailable && r.council ? 'PANEL' : '-';
    console.log(
      `  ${r.site.padEnd(width)}  ${r.risk.padEnd(8)} ${council.padEnd(8)} ${r.tier.padEnd(11)} ${mark}`,
    );
  }
  const pct = rows.length ? Math.round((free / rows.length) * 100) : 0;
  const panel = councilAvailable ? rows.filter((r) => r.council).length : 0;
  console.log(`  ${'-'.repeat(width + 50)}`);
  console.log(
    `  ${rows.length} decisions: ${free} free (${pct}%), ${paid} reached a model ` +
      `(${totalCalls} provider call${totalCalls === 1 ? '' : 's'} attempted)`,
  );
  console.log(
    councilAvailable
      ? `  ${panel} of ${rows.length} are at/above the council floor ('${COUNCIL_FLOOR}') — ` +
          'those go to the multi-LLM panel instead of the single-LLM tier.'
      : '  No council in this configuration: every request that clears the ceiling ' +
          'goes to the single-LLM tier.',
  );
  // NOTE the `decided by` column reads `policy` for the model-backed rows:
  // the provider is unreachable here so the ladder falls back. In production
  // those rows are decided by `llm`/`council`. The attempt count is the
  // number that carries over, not the attribution.
  return { free, paid, total: rows.length, totalCalls };
}

const withRules = process.argv.includes('--rules');
const base = render("Council-capable install (autonomy ceiling 'all')", await measure(null, 'all'));

// A single-model install resolves the ceiling to 'high', so `critical`
// requests never reach an unchecked model at all: the ladder returns the
// policy decision and the headless terminal policy refuses a recommended
// option at critical risk. This pass shows that the safety property holds
// without a council rather than asserting it in prose.
render("Single-model install (autonomy ceiling 'high', no council)", await measure(null, 'high'), {
  councilAvailable: false,
});

if (withRules) {
  const ruled = render('With the candidate built-in rule pack', await measure(CANDIDATE_RULES));
  const saved = base.totalCalls - ruled.totalCalls;
  const pct = base.totalCalls ? Math.round((saved / base.totalCalls) * 100) : 0;
  console.log(`
  Rule pack avoids ${saved} of ${base.totalCalls} provider calls (${pct}%).`);
}
