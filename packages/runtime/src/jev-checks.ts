/**
 * `wstack typesafe check-judgments` — each judgment against the live model.
 *
 * `wstack typesafe test` proves the account answers one question. It says
 * nothing about whether the QUESTIONS the judgment features ask still get the
 * answers their thresholds were written for — and `jev-latest` is an alias
 * whose version moves under us. This runs every feature's real question
 * builder on a few cases whose right answer is not in doubt, through the same
 * code path the feature uses, and reports expected vs. actual.
 *
 * The cases are deliberately easy. A failure here means a threshold, a
 * question or the model moved — not that a hard case was hard. Calibration on
 * real traffic is a separate job; this is the smoke test for it.
 *
 * Uses the rest gate like the features do NOT: every call goes to the host,
 * because the point is to ask it now.
 */

import type { Config, Message, SkillLoader } from '@wrongstack/contracts/types';
import type { BrainDecisionRequest } from '@wrongstack/core/coordination';
import {
  createSystemOneTierSuggester,
  makeTypeSafeDispatchClassifier,
} from '@wrongstack/core/coordination';
import {
  probeSystemOneBrain,
  systemOneBrainSettles,
  TopicShiftAdvisor,
} from '@wrongstack/core/execution';
import { SystemOneSelector } from '@wrongstack/core/models';
import { createSkillSuggester } from '@wrongstack/core/skills';
import { evaluateJevQuestions } from '@wrongstack/tools/management';
import {
  BUILT_IN_SEMANTIC_LINT_RULES,
  createTypeSafeCriterionJudge,
  findSemanticLintCandidates,
  judgeSemanticLintCandidates,
  resolveTypeSafeAccount,
  type TypeSafeJudge,
} from '@wrongstack/core/typesafe';
import {
  computeValueScore,
  createSystemOneRecallFilter,
  createSystemOneTriage,
  type Sage,
} from '@wrongstack/sage';

export interface JevCheckCase {
  feature: string;
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
  ms: number;
  /** Raw judgment values, shown on every line so drift near a threshold is visible. */
  note?: string | undefined;
}

const memory = (id: string, text: string, kind = 'fact'): Sage =>
  ({
    id,
    revision: 1,
    scope: 'project',
    kind,
    status: 'active',
    persistence: 'long_lived',
    text,
    importance: 0.6,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [{ type: 'user' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }) as unknown as Sage;

function authHistory(): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < 9; i++) {
    messages.push({
      role: 'user',
      content: `Continue the authentication session middleware token validation work, step ${i}.`,
    });
    messages.push({
      role: 'assistant',
      content: `Updated the session token validation in auth middleware (step ${i}).`,
    });
  }
  return messages;
}

const DIFF_JSON_FLAG = [
  'diff --git a/src/status.ts b/src/status.ts',
  '--- a/src/status.ts',
  '+++ b/src/status.ts',
  '@@ -10,6 +10,10 @@ export function statusCommand(program) {',
  "   program.command('status')",
  "+    .option('--json', 'print the status as JSON')",
  '     .action(async (opts) => {',
  '       const status = await readStatus();',
  '+      if (opts.json) {',
  '+        console.log(JSON.stringify(status));',
  '+        return;',
  '+      }',
  '       printHuman(status);',
].join('\n');

const LINT_DIFF = [
  'diff --git a/src/tools/read.ts b/src/tools/read.ts',
  '--- a/src/tools/read.ts',
  '+++ b/src/tools/read.ts',
  '@@ -1,3 +1,12 @@',
  ' export const readTool = {',
  "   name: 'read',",
  '   async execute(input) {',
  '+    if (!input.path) {',
  "+      return { status: 'error', message: 'path is required' };",
  '+    }',
  "+    const child = spawn('cat', [input.path], { stdio: 'pipe' });",
  '+    return collect(child);',
  '   },',
  ' };',
  'diff --git a/src/parse.ts b/src/parse.ts',
  '--- a/src/parse.ts',
  '+++ b/src/parse.ts',
  '@@ -1,2 +1,6 @@',
  ' // Parses a JSON-RPC response envelope from the server.',
  ' export function parseEnvelope(raw) {',
  "+  if (raw.status === 'error') throw new EnvelopeError(raw.message);",
  "+  const expected = { status: 'error', code: 400 }; // documented example shape",
  "+  const child = spawn('git', ['status'], { cwd, windowsHide: true, stdio: 'pipe' });",
  '   return raw.result;',
  ' }',
].join('\n');

export interface JevCheckReport {
  at: number;
  route: string;
  model: string;
  cases: JevCheckCase[];
  passed: number;
  total: number;
}

/** Explicit, billed capability check. Synthetic fixtures only; never reads project content. */
export async function checkJevJudgments(
  config: Readonly<Config>,
  signal = AbortSignal.timeout(60_000),
): Promise<JevCheckReport> {
  const account = resolveTypeSafeAccount({ config, restGate: null });
  if (account.status !== 'ready') throw new Error('Jev account unavailable');
  let observation = { requested: 0, failed: false };
  const client = {
    async systemOne(
      req: Parameters<typeof account.client.systemOne>[0],
      requestSignal?: AbortSignal,
    ) {
      const current = observation;
      current.requested++;
      try {
        signal.throwIfAborted();
        const result = await account.client.systemOne(
          { ...req, activityPurpose: 'self-test' },
          requestSignal ? AbortSignal.any([signal, requestSignal]) : signal,
        );
        reportedModel ??= result.model;
        if (Object.keys(req.questions).some((id) => !result.answers[id])) current.failed = true;
        return result;
      } catch (error) {
        current.failed = true;
        throw error;
      }
    },
  };
  const judge = (feature: TypeSafeJudge['feature']): TypeSafeJudge => ({
    client,
    model: account.model,
    feature,
  });
  const results: JevCheckCase[] = [];
  let reportedModel: string | undefined;

  const run = async (
    feature: string,
    name: string,
    expected: string,
    fn: () => Promise<string | [string, string]>,
  ): Promise<void> => {
    const started = Date.now();
    observation = { requested: 0, failed: false };
    let actual: string;
    let note: string | undefined;
    try {
      signal.throwIfAborted();
      const out = await fn();
      [actual, note] = Array.isArray(out) ? out : [out, undefined];
      if (observation.failed) actual = 'request_failed_or_incomplete';
      else if (!observation.requested) actual = 'not_exercised';
    } catch {
      actual = signal.aborted ? 'cancelled_or_timed_out' : 'request_failed';
    }
    results.push({
      feature,
      name,
      expected,
      actual,
      ok: actual === expected,
      ms: Date.now() - started,
      note,
    });
  };

  for (const passed of [true, false]) {
    await run('tool', passed ? 'passing tests' : 'failing tests', String(passed), async () => {
      const result = await evaluateJevQuestions(
        {
          state: { testsPassed: passed, failingTests: passed ? 0 : 3 },
          questions: {
            ready: { type: 'noul', instructions: 'Does the evidence show all tests passed?' },
          },
        },
        judge('tool'),
        signal,
      );
      const answer = result.answers.ready;
      return answer?.type === 'noul' ? String(answer.noul >= 0.5) : 'malformed';
    });
  }

  // Brain (probe + the tier's own thresholds, so values are visible) -------
  const brain = {
    decide: async (request: BrainDecisionRequest): Promise<[string, string]> => {
      const probe = await probeSystemOneBrain(judge('brain'), request);
      if (!probe) return ['malformed', ''];
      const note = `${probe.optionId} p=${probe.probability.toFixed(2)} decidable=${probe.decidable.toFixed(2)}`;
      return [systemOneBrainSettles(probe) ? probe.optionId : 'deferred', note];
    },
  };
  const brainRequest = (question: string, context: string): BrainDecisionRequest =>
    ({
      id: `check-${question.length}`,
      source: 'check',
      question,
      context,
      risk: 'low',
      fallback: 'deny',
      options: [
        { id: 'retry', label: 'Retry the command once' },
        { id: 'abort', label: 'Stop and report the failure' },
      ],
    }) as unknown as BrainDecisionRequest;
  await run('brain', 'transient network error → retry', 'retry', async () => {
    const d = await brain.decide(
      brainRequest(
        'npm install failed. Retry or stop?',
        'The command failed with "ECONNRESET: socket hang up" while downloading one package. ' +
          'The previous 40 installs in this session succeeded. Nothing else changed.',
      ),
    );
    return d;
  });
  await run('brain', 'taste question → defers to the LLM/human', 'deferred', async () => {
    const d = await brain.decide({
      ...brainRequest('Which color should the new primary button use?', 'No design brief exists.'),
      options: [
        { id: 'blue', label: 'Blue' },
        { id: 'green', label: 'Green' },
      ],
    } as unknown as BrainDecisionRequest);
    return d;
  });

  // Replaying this project's ledger showed the council split ~65/35 on exactly
  // this evidence while Jev said "steer" every time; a signal with no
  // concrete evidence must go to the council/LLM, not be settled here.
  await run('brain', 'signal-only monitor question → defers', 'deferred', async () => {
    const d = await brain.decide({
      ...brainRequest(
        'The file "src/auth/session.ts" has been edited 5 times within 10 minutes — the agent ' +
          'may be oscillating (edit/revert loop) instead of converging. Should it be steered?',
        'File: src/auth/session.ts\nEdits in window: 5\nWindow: 600s',
      ),
      options: [
        { id: 'steer', label: 'Steer the agent with corrective guidance' },
        { id: 'continue', label: 'Let the agent continue unaided' },
      ],
    } as unknown as BrainDecisionRequest);
    return d;
  });

  // Memory triage ---------------------------------------------------------
  const triage = createSystemOneTriage({ judge: judge('memoryTriage') });
  const rate = async (m: Sage): Promise<string> => {
    const r = await triage.rateMemory(m, computeValueScore(m));
    if (!r) return 'undecided';
    return r.score >= 4 ? 'keep (4-5)' : r.score <= 2 ? 'drop (1-2)' : 'niche (3)';
  };
  await run('memoryTriage', 'hard-won invariant', 'keep (4-5)', () =>
    rate(
      memory(
        'm1',
        'DIRECTIVE: the live Config object is frozen at boot. Assigning to it in place throws ' +
          'at runtime; always go through patchConfig() + setConfig(). This broke three releases.',
        'decision',
      ),
    ),
  );
  await run('memoryTriage', 'transient status note', 'drop (1-2)', () =>
    rate(memory('m2', 'Currently running the test suite, will check back in a few minutes.')),
  );
  await run('memoryTriage', 'duplicate pair → merge', 'YES', async () =>
    String(
      (await triage.judgeMerge(
        memory('a', 'The live Config object is frozen; mutate it only via patchConfig().'),
        memory('b', 'Never assign to the live Config in place — call patchConfig() instead.'),
      )) ?? 'undecided',
    ),
  );
  await run('memoryTriage', 'unrelated pair → keep both', 'NO', async () =>
    String(
      (await triage.judgeMerge(
        memory('a', 'The live Config object is frozen; mutate it only via patchConfig().'),
        memory('b', 'CI runs on pnpm 10 with Node 22 on ubuntu-latest and windows-latest.'),
      )) ?? 'undecided',
    ),
  );

  // Topic shift -----------------------------------------------------------
  const topic = (prompt: string) =>
    new TopicShiftAdvisor({ getJudge: () => judge('topicShift') }).advise({
      prompt,
      messages: authHistory(),
      contextTokens: 60_000,
      maxContext: 200_000,
    });
  await run('topicShift', 'unrelated holiday plan', 'new (system-one)', async () => {
    const a = await topic('Plan a two-week summer holiday in Portugal and estimate the budget.');
    return `${a.suggestNewContext ? 'new' : 'same'} (${a.source})`;
  });
  await run('topicShift', 'Turkish unrelated prompt', 'new (system-one)', async () => {
    const a = await topic('Portekiz için iki haftalık bir yaz tatili planla ve bütçeyi hesapla.');
    return `${a.suggestNewContext ? 'new' : 'same'} (${a.source})`;
  });

  // Memory recall ---------------------------------------------------------
  const recall = createSystemOneRecallFilter({
    getJudge: () => judge('memoryRecall'),
  });
  await run('memoryRecall', 'drops the off-topic memory only', 'drop b', async () => {
    const dropped = await recall('Why does setting config.model at runtime throw an error?', [
      memory('a', 'The live Config object is frozen; assigning to it throws. Use patchConfig().'),
      memory('b', 'The marketing site is deployed to Vercel from the website/ folder.'),
    ]);
    return dropped.size === 0 ? 'drop nothing' : `drop ${[...dropped].sort().join(',')}`;
  });

  // Compaction ------------------------------------------------------------
  await run('compaction', 'collapses the finished side quest', 'collapsed 1', async () => {
    const turns: Array<[string, string]> = [
      ['Add a --json flag to `wstack status`; keep the human output unchanged.', 'Plan noted.'],
      ['What is the capital of Australia?', 'Canberra.'],
      [
        'The --json output must include the session id and the model; that is a hard requirement.',
        'Understood: sessionId and model are required fields.',
      ],
      ['Now write the --json implementation.', 'Implemented; printing JSON with sessionId+model.'],
      ['Add a test for the --json output.', 'Added status-json.test.ts.'],
    ];
    const messages: Message[] = turns.flatMap(([u, a]) => [
      { role: 'user', content: u },
      { role: 'assistant', content: a },
    ]);
    const fallback = { select: async () => ({ kept: [], collapsed: [], reasoning: 'fallback' }) };
    const selector = new SystemOneSelector({ getJudge: () => judge('compaction'), fallback });
    const r = await selector.select(messages, 100_000);
    if (r.reasoning === 'fallback') return 'fallback';
    return `collapsed ${r.collapsed.map((c) => `${c.from / 2}`).join(',')}`;
  });

  // Kanban verify ---------------------------------------------------------
  const criterion = createTypeSafeCriterionJudge(judge('kanbanVerify'));
  const verdict = async (text: string): Promise<string> => {
    const r = await criterion({
      criterion: text,
      diff: DIFF_JSON_FLAG,
      changedFiles: ['src/status.ts'],
    });
    if (!r) return 'undecided';
    reportedModel ??= r.model;
    return r.probability >= 0.92 ? 'passed' : r.probability <= 0.08 ? 'failed' : 'open';
  };
  await run('kanbanVerify', 'met criterion', 'passed', () =>
    verdict('`wstack status` accepts a --json flag that prints the status as JSON.'),
  );
  await run('kanbanVerify', 'unmet criterion', 'failed', () =>
    verdict('The settings page supports a dark mode toggle.'),
  );

  // Model tier ------------------------------------------------------------
  const tierConfig = {
    ...config,
    modelTiers: {
      enabled: true,
      default: 'standard',
      levels: { budget: {}, standard: {}, premium: {} },
    },
  } as unknown as Config;
  const tier = createSystemOneTierSuggester({
    getConfig: () => tierConfig,
    getJudge: () => judge('modelTier'),
  });
  await run('modelTier', 'mechanical rename', 'budget', async () =>
    String(
      (await tier({ task: 'Rename the local variable `tmp` to `buffer` in src/util/read.ts.' })) ??
        'standard (default)',
    ),
  );
  await run('modelTier', 'cross-cutting security redesign', 'premium', async () =>
    String(
      (await tier({
        task:
          'Redesign credential storage across the CLI, daemon and WebUI so secrets never touch ' +
          'disk unencrypted, migrate existing users without data loss, and keep all three in sync.',
      })) ?? 'standard (default)',
    ),
  );

  // Semantic lint ---------------------------------------------------------
  await run('semanticLint', 'violations vs. look-alikes', 'read.ts:5,read.ts:7', async () => {
    const candidates = findSemanticLintCandidates(LINT_DIFF, BUILT_IN_SEMANTIC_LINT_RULES);
    const r = await judgeSemanticLintCandidates(
      judge('semanticLint'),
      BUILT_IN_SEMANTIC_LINT_RULES,
      candidates,
    );
    return r.findings.map((f) => `${f.file.split('/').pop()}:${f.line}`).join(',') || 'none';
  });

  const roster = [
    {
      name: 'git-flow',
      description: 'Create release branches and tags using a release checklist.',
      body: 'Follow release preparation: create the release branch, check tests, update the version and create the release tag.',
    },
    {
      name: 'design-critique',
      description: 'Review an existing interface for visual hierarchy and usability.',
      body: 'Inspect screenshots and review usability of the existing interface.',
    },
    {
      name: 'database-migration',
      description: 'Plan and validate database schema migrations.',
      body: 'Check schema compatibility, rollback and data integrity.',
    },
  ].map((skill) => ({ ...skill, path: `/${skill.name}/SKILL.md`, source: 'bundled' as const }));
  const loader: SkillLoader = {
    list: async () => roster,
    listEntries: async () =>
      roster.map((skill) => ({ ...skill, trigger: skill.description, scope: [] })),
    find: async (name) => roster.find((skill) => skill.name === name),
    manifestText: async () => '',
    readBody: async (name) => roster.find((skill) => skill.name === name)?.body ?? '',
    readSaveBody: async () => '',
    invalidateCache: () => {},
  };
  const suggester = createSkillSuggester({ client, loader });
  await run(
    'skillSuggestion',
    'release workflow',
    'git-flow',
    async () =>
      (
        await suggester.suggest(
          'Create the release branch and tag for version 2.0 following our release workflow.',
          AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
        )
      )?.name ?? 'none',
  );
  await run(
    'skillSuggestion',
    'plain question needs no skill',
    'none',
    async () =>
      (
        await suggester.suggest(
          'What is the capital of Australia?',
          AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
        )
      )?.name ?? 'none',
  );
  const classify = makeTypeSafeDispatchClassifier({ client });
  const candidates = [
    {
      role: 'security-auditor',
      name: 'Security Auditor',
      summary: 'Find vulnerabilities in existing code',
      differentiatesFrom: 'Audits existing code rather than designing new security controls',
    },
    {
      role: 'security-architect',
      name: 'Security Architect',
      summary: 'Design new security architecture and controls',
    },
  ];
  await run(
    'fleetDispatch',
    'audit existing code',
    'security-auditor',
    async () =>
      (
        await classify(
          'Audit the existing authentication middleware for authorization bypass vulnerabilities.',
          candidates,
        )
      )?.role ?? 'none',
  );
  await run(
    'fleetDispatch',
    'unrelated task declines',
    'none',
    async () =>
      (await classify('Translate this sentence from English to French: Good morning.', candidates))
        ?.role ?? 'none',
  );
  return {
    at: Date.now(),
    route: account.route,
    model: reportedModel ?? account.model,
    cases: results,
    passed: results.filter((result) => result.ok).length,
    total: results.length,
  };
}
