import { randomUUID } from 'node:crypto';
import {
  claimReadyTask,
  describeKanbanBoundary,
  finalizeTaskCompletion,
  getBoard,
  heartbeatTaskAssignment,
  type KanbanBoard,
  type KanbanTask,
  listReadyTasks,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { ToolCapabilities } from '../security/capabilities.js';
import type { SubagentConfig, TaskResult, TaskSpec } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { toErrorMessage } from '../utils/error.js';
import { type AgentDefinition, getAgentDefinition } from './agents/index.js';
import type { CollabSessionOptions } from './collab-debug.js';
import {
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from './director/director-errors.js';
import type * as Host from './director-host-contracts.js';
import { dispatchAgent } from './dispatcher.js';
import { validateFleetEventEmission } from './fleet-event-validation.js';

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Director-facing tool factories.
//
// Each tool's input schema is intentionally minimal — the director model
// reads the descriptions and gets clean structured shapes. We avoid deep
// nested schemas because they confuse smaller models.

export function makeSpawnTool(
  director: Host.DirectorAdmissionPort,
  roster?: Record<string, SubagentConfig>,
): Tool {
  const dispatchCatalog = (): Record<string, AgentDefinition> | undefined => {
    if (!roster) return undefined;
    return Object.fromEntries(
      Object.entries(roster).map(([role, config]) => {
        const builtIn = getAgentDefinition(role);
        if (builtIn) return [role, builtIn];
        return [
          role,
          {
            config,
            budget: {
              timeoutMs: config.timeoutMs,
              maxIterations: config.maxIterations,
              maxToolCalls: config.maxToolCalls,
              maxTokens: config.maxTokens,
              maxCostUsd: config.maxCostUsd,
            },
            capability: {
              phase: 'meta',
              summary: config.dispatch?.summary ?? config.prompt ?? config.name,
              keywords: config.dispatch?.keywords ?? [],
            },
          } satisfies AgentDefinition,
        ];
      }),
    );
  };
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description:
          'Roster role id. When set, the spawn uses the matching config from the roster and ignores other fields.',
      },
      description: {
        type: 'string',
        description:
          "Free-form task description. When `role` is not set, the director uses the smart dispatcher to route this to the best-matching catalog agent. Use this when you don't know the exact role name.",
      },
      name: {
        type: 'string',
        description:
          'Display name for the subagent. Used as a fallback when description-based dispatch does not resolve a role.',
      },
      provider: {
        type: 'string',
        description:
          'Provider id (e.g. "anthropic", "openai"). Defaults to the leader provider when omitted.',
      },
      model: {
        type: 'string',
        description: 'Model id within the provider. Defaults to the leader model when omitted.',
      },
      systemPromptOverride: {
        type: 'string',
        description: 'Extra prompt text appended after the role-base prompt.',
      },
      maxIterations: { type: 'number', minimum: 1 },
      maxToolCalls: { type: 'number', minimum: 1 },
      maxCostUsd: { type: 'number', minimum: 0 },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Hard wall-clock cap in milliseconds. Defaults to none (idle timeout is the default reaper).',
      },
      idleTimeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Idle timeout in ms: reap the subagent after this long with no activity. Resets on every iteration/tool call. Default is role/coordinator-specific.',
      },
      maxTokens: {
        type: 'number',
        minimum: 1,
        description: 'Maximum total tokens (input + output) the subagent may use.',
      },
      worktree: {
        anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
        description:
          'Git-worktree isolation override. true/"required" requires an isolated worktree; false/"off" disables it; "auto" follows fleet policy.',
      },
    },
    required: [],
  };
  return {
    name: 'spawn_subagent',
    description:
      'Create a new subagent under this director (own LLM context, own budget). NON-BLOCKING: returns a `subagentId` immediately without triggering any model call. Pair with `assign_task` to send work and `await_tasks` to retrieve the result later — this is the async-delegation pattern that lets the leader keep working while the subagent runs in its own context.',
    usageHint:
      'Pass `role` (matches the roster), `description` (smart dispatch to best agent), or `name` + `provider`/`model`. Returns `{ subagentId }`. Use this instead of `delegate` when you want to fan out to multiple subagents or keep the leader unblocked while work runs in parallel.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema,
    async execute(input: unknown) {
      const i = (input ?? {}) as Record<string, unknown>;
      const role = typeof i.role === 'string' ? i.role : undefined;
      const description = typeof i.description === 'string' ? i.description : undefined;

      // Resolve base config from roster, explicit role, or dispatch-by-description
      let cfg: SubagentConfig | undefined;

      if (role && roster) {
        const base = roster[role];
        if (!base)
          return { error: `unknown role "${role}". roster has: ${Object.keys(roster).join(', ')}` };
        cfg = instantiateRosterConfig(role, base);
      } else if (description && !role) {
        // Smart dispatch: route description to best catalog agent using dispatcher
        const dispatchResult = await dispatchAgent(description, {
          classifier: director.dispatchClassifier,
          catalog: dispatchCatalog(),
        });
        const dispatchRole = dispatchResult.role;
        // If we have a matching roster entry for the dispatched role, use it
        if (roster?.[dispatchRole]) {
          cfg = instantiateRosterConfig(dispatchRole, roster[dispatchRole] ?? {});
        } else {
          // Dispatch found a catalog agent but there's no roster entry — use the
          // catalog definition's config as a base template (role name + defaults).
          // We must not mutate the original definition, so spread it.
          const def = dispatchResult.definition;
          cfg = {
            name: def.config.name ?? dispatchRole,
            role: dispatchRole,
            provider: def.config.provider,
            model: def.config.model,
          };
        }
      }

      // Fall back to name-only config when neither role nor description dispatch resolved
      cfg ??= { name: (i.name as string) ?? 'subagent' };

      if (typeof i.name === 'string') cfg.name = i.name;
      if (typeof i.provider === 'string') cfg.provider = i.provider;
      if (typeof i.model === 'string') cfg.model = i.model;
      if (typeof i.systemPromptOverride === 'string')
        cfg.systemPromptOverride = i.systemPromptOverride;
      if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
      if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
      if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;
      if (typeof i.timeoutMs === 'number') cfg.timeoutMs = i.timeoutMs;
      if (typeof i.idleTimeoutMs === 'number') cfg.idleTimeoutMs = i.idleTimeoutMs;
      if (typeof i.maxTokens === 'number') cfg.maxTokens = i.maxTokens;
      if (
        typeof i.worktree === 'boolean' ||
        i.worktree === 'auto' ||
        i.worktree === 'required' ||
        i.worktree === 'off'
      ) {
        cfg.worktree = i.worktree;
      }
      try {
        const subagentId = await director.spawn(cfg);
        return {
          subagentId,
          provider: cfg.provider,
          model: cfg.model,
          name: cfg.name,
          role: cfg.role,
        };
      } catch (err) {
        if (err instanceof FleetSpawnBudgetError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        if (err instanceof FleetCostCapError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        if (err instanceof FleetTokenCapError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        return { error: toErrorMessage(err) };
      }
    },
  };
}

function instantiateRosterConfig(role: string, base: SubagentConfig): SubagentConfig {
  return {
    ...base,
    // Roster entries are templates. A director may spawn several
    // workers with the same role, so never reuse the template id.
    id: `${role}-${randomUUID().slice(0, 8)}`,
  };
}

type QualityGateVerdict = 'pass' | 'fail' | 'inconclusive';

interface QualityGateInput {
  task?: string | undefined;
  implementerTaskIds?: string[] | undefined;
  repairSubagentId?: string | undefined;
  maxRepairAttempts?: number | undefined;
  targets?: string[] | undefined;
  commands?: string[] | undefined;
  expected?: string | undefined;
  evidence?: string | undefined;
  reviewer?: boolean | undefined;
  verifier?: boolean | undefined;
  timeoutMs?: number | undefined;
  reviewerWorktree?: SubagentConfig['worktree'] | undefined;
  verifierWorktree?: SubagentConfig['worktree'] | undefined;
}

interface QualityRoleReport {
  role: 'reviewer' | 'verifier';
  subagentId: string;
  taskId: string;
  status: TaskResult['status'];
  verdict: QualityGateVerdict;
  summary: string;
  uncertaintyFlags?: string | undefined;
  error?: string | undefined;
}

interface QualityGateAssessment {
  verdict: QualityGateVerdict;
  passed: boolean;
  mustFix: string[];
  uncertaintyFlags: string[];
}

export function makeQualityGateTool(
  director: Host.DirectorRepairPort,
  roster?: Record<string, SubagentConfig>,
): Tool {
  return {
    name: 'quality_gate',
    description:
      'Run a first-class implementation quality gate. It can await implementer task ids, spawn independent verifier/reviewer agents, summarize their verdicts, and optionally send must-fix feedback back to an implementer until the gate passes or the repair-attempt limit is reached.',
    usageHint:
      'Use after code-changing work. Provide implementerTaskIds when available. Add repairSubagentId to iterate fixes automatically. Verdict only passes when every enabled reviewer/verifier explicitly passes.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Original implementation task or acceptance goal being gated.',
        },
        implementerTaskIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional completed or in-flight implementer task ids to await and include as implementation evidence.',
        },
        repairSubagentId: {
          type: 'string',
          description:
            'Optional implementer subagent id. When set and the gate fails, quality_gate assigns a repair task with reviewer/verifier feedback and reruns the gate.',
        },
        maxRepairAttempts: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description:
            'Maximum automatic repair iterations. Default: 2 when repairSubagentId is set, otherwise 0.',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files, packages, or paths that reviewer/verifier should focus on.',
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Verification commands that should pass, e.g. ["pnpm --filter @wrongstack/core typecheck"].',
        },
        expected: {
          type: 'string',
          description: 'Expected behavior or acceptance criteria.',
        },
        evidence: {
          type: 'string',
          description: 'Known implementation notes, diff summary, or commands already run.',
        },
        reviewer: {
          type: 'boolean',
          description: 'Whether to run the reviewer lane. Default true.',
        },
        verifier: {
          type: 'boolean',
          description: 'Whether to run the verifier lane. Default true.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Optional per reviewer/verifier/repair task timeout.',
        },
        reviewerWorktree: {
          anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
          description: 'Reviewer worktree override. Default off because reviewer is read-only.',
        },
        verifierWorktree: {
          anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
          description:
            'Verifier worktree override. Default auto so test artifacts stay isolated when fleet policy wants it.',
        },
      },
    } satisfies JSONSchema,
    async execute(input: unknown) {
      const i = normalizeQualityGateInput(input);
      const runReviewer = i.reviewer !== false;
      const runVerifier = i.verifier !== false;
      if (!runReviewer && !runVerifier) {
        return {
          verdict: 'inconclusive',
          passed: false,
          error: 'quality_gate requires reviewer, verifier, or both.',
        };
      }

      const implementerResults =
        i.implementerTaskIds && i.implementerTaskIds.length > 0
          ? await director.awaitTasks(i.implementerTaskIds)
          : [];
      const maxRepairAttempts = clampRepairAttempts(
        i.maxRepairAttempts ?? (i.repairSubagentId ? 2 : 0),
      );
      const repairResults: TaskResult[] = [];
      const attempts: Array<{
        attempt: number;
        verdict: QualityGateVerdict;
        passed: boolean;
        reports: QualityRoleReport[];
        mustFix: string[];
        uncertaintyFlags: string[];
      }> = [];

      for (let attempt = 1; ; attempt++) {
        const gateTaskIds: string[] = [];
        const taskRoleById = new Map<string, 'reviewer' | 'verifier'>();

        if (runVerifier) {
          const subagentId = await director.spawn(
            makeQualityGateSubagentConfig('verifier', roster, i.verifierWorktree ?? 'auto'),
          );
          const taskId = await director.assign({
            id: randomUUID(),
            subagentId,
            description: buildVerifierTask(i, {
              attempt,
              implementerResults,
              repairResults,
              priorAttempts: attempts,
            }),
            timeoutMs: i.timeoutMs,
          });
          gateTaskIds.push(taskId);
          taskRoleById.set(taskId, 'verifier');
        }

        if (runReviewer) {
          const subagentId = await director.spawn(
            makeQualityGateSubagentConfig('reviewer', roster, i.reviewerWorktree ?? 'off'),
          );
          const taskId = await director.assign({
            id: randomUUID(),
            subagentId,
            description: buildReviewerTask(i, {
              attempt,
              implementerResults,
              repairResults,
              priorAttempts: attempts,
            }),
            timeoutMs: i.timeoutMs,
          });
          gateTaskIds.push(taskId);
          taskRoleById.set(taskId, 'reviewer');
        }

        const gateResults = await director.awaitTasks(gateTaskIds);
        const reports = gateResults.map((r) => assessRoleResult(taskRoleById.get(r.taskId), r));
        const assessment = assessQualityGate(reports);
        attempts.push({ attempt, reports, ...assessment });

        if (assessment.passed || !i.repairSubagentId || attempt > maxRepairAttempts) {
          return {
            verdict: assessment.verdict,
            passed: assessment.passed,
            attempts,
            repairAttemptsUsed: repairResults.length,
            implementerResults: implementerResults.map(summarizeTaskResult),
            nextAction: assessment.passed
              ? 'accept'
              : i.repairSubagentId && attempt > maxRepairAttempts
                ? 'manual_intervention_or_raise_repair_limit'
                : 'inspect_failures',
          };
        }

        const repairTaskId = await director.assign({
          id: randomUUID(),
          subagentId: i.repairSubagentId,
          description: buildRepairTask(i, attempts[attempts.length - 1]!, attempt),
          timeoutMs: i.timeoutMs,
        });
        const [repairResult] = await director.awaitTasks([repairTaskId]);
        if (repairResult) repairResults.push(repairResult);
        if (repairResult?.status !== 'success') {
          return {
            verdict: 'fail',
            passed: false,
            attempts,
            repairAttemptsUsed: repairResults.length,
            repairResult: repairResult ? summarizeTaskResult(repairResult) : undefined,
            implementerResults: implementerResults.map(summarizeTaskResult),
            nextAction: 'repair_failed',
          };
        }
      }
    },
  };
}

function normalizeQualityGateInput(input: unknown): QualityGateInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    task: typeof raw.task === 'string' ? raw.task : undefined,
    implementerTaskIds: stringArray(raw.implementerTaskIds),
    repairSubagentId:
      typeof raw.repairSubagentId === 'string' && raw.repairSubagentId.trim()
        ? raw.repairSubagentId.trim()
        : undefined,
    maxRepairAttempts:
      typeof raw.maxRepairAttempts === 'number' ? raw.maxRepairAttempts : undefined,
    targets: stringArray(raw.targets),
    commands: stringArray(raw.commands),
    expected: typeof raw.expected === 'string' ? raw.expected : undefined,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : undefined,
    reviewer: typeof raw.reviewer === 'boolean' ? raw.reviewer : undefined,
    verifier: typeof raw.verifier === 'boolean' ? raw.verifier : undefined,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    reviewerWorktree: normalizeWorktreeOverride(raw.reviewerWorktree),
    verifierWorktree: normalizeWorktreeOverride(raw.verifierWorktree),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function normalizeWorktreeOverride(value: unknown): SubagentConfig['worktree'] | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'auto' || value === 'required' || value === 'off') return value;
  return undefined;
}

function clampRepairAttempts(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function makeQualityGateSubagentConfig(
  role: 'reviewer' | 'verifier',
  roster: Record<string, SubagentConfig> | undefined,
  worktree: SubagentConfig['worktree'],
): SubagentConfig {
  const base = roster?.[role] ?? getAgentDefinition(role)?.config ?? { name: role, role };
  return {
    ...instantiateRosterConfig(role, base),
    worktree,
  };
}

function buildVerifierTask(
  input: QualityGateInput,
  state: {
    attempt: number;
    implementerResults: TaskResult[];
    repairResults: TaskResult[];
    priorAttempts: Array<{ attempt: number; reports: QualityRoleReport[] }>;
  },
): string {
  return [
    'Run the independent verification gate for this implementation.',
    'Return Markdown with `## Verdict` and make the first verdict word exactly `pass`, `fail`, or `blocked`.',
    'Do not edit code. Run the smallest meaningful command set and include exact failures.',
    '',
    `Gate attempt: ${state.attempt}`,
    input.task ? `Original task:\n${input.task}` : undefined,
    input.targets?.length
      ? `Targets:\n${input.targets.map((t) => `- ${t}`).join('\n')}`
      : undefined,
    input.commands?.length
      ? `Required or suggested commands:\n${input.commands.map((c) => `- ${c}`).join('\n')}`
      : undefined,
    input.expected ? `Expected behavior:\n${input.expected}` : undefined,
    input.evidence ? `Known evidence:\n${input.evidence}` : undefined,
    taskResultsBlock('Implementer results', state.implementerResults),
    taskResultsBlock('Repair results so far', state.repairResults),
    priorAttemptsBlock(state.priorAttempts),
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');
}

function buildReviewerTask(
  input: QualityGateInput,
  state: {
    attempt: number;
    implementerResults: TaskResult[];
    repairResults: TaskResult[];
    priorAttempts: Array<{ attempt: number; reports: QualityRoleReport[] }>;
  },
): string {
  return [
    'Run independent code review for this implementation.',
    'Return Markdown with `## Verdict` and make the first verdict phrase exactly `approve`, `request changes`, or `needs verification`.',
    'Do not edit code. Treat missing proof, vague tests, and uncertainty as blocking until verifier evidence exists.',
    '',
    `Gate attempt: ${state.attempt}`,
    input.task ? `Original task:\n${input.task}` : undefined,
    input.targets?.length
      ? `Targets:\n${input.targets.map((t) => `- ${t}`).join('\n')}`
      : undefined,
    input.expected ? `Expected behavior:\n${input.expected}` : undefined,
    input.evidence ? `Known evidence:\n${input.evidence}` : undefined,
    taskResultsBlock('Implementer results', state.implementerResults),
    taskResultsBlock('Repair results so far', state.repairResults),
    priorAttemptsBlock(state.priorAttempts),
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');
}

function buildRepairTask(
  input: QualityGateInput,
  attempt: {
    attempt: number;
    reports: QualityRoleReport[];
    mustFix: string[];
    uncertaintyFlags: string[];
  },
  attemptNumber: number,
): string {
  return [
    `Repair the implementation after quality gate attempt ${attemptNumber} failed.`,
    'Address every must-fix item. Run relevant checks before returning.',
    'Do not claim done unless verifier/reviewer feedback is resolved.',
    '',
    input.task ? `Original task:\n${input.task}` : undefined,
    input.targets?.length
      ? `Targets:\n${input.targets.map((t) => `- ${t}`).join('\n')}`
      : undefined,
    input.commands?.length
      ? `Commands expected to pass:\n${input.commands.map((c) => `- ${c}`).join('\n')}`
      : undefined,
    input.expected ? `Expected behavior:\n${input.expected}` : undefined,
    attempt.mustFix.length
      ? `Must fix:\n${attempt.mustFix.map((f) => `- ${f}`).join('\n')}`
      : undefined,
    attempt.uncertaintyFlags.length
      ? `Uncertainty flags to resolve:\n${attempt.uncertaintyFlags.map((f) => `- ${f}`).join('\n')}`
      : undefined,
    `Reviewer/verifier reports:\n${attempt.reports
      .map((r) => `### ${r.role} (${r.verdict})\n${r.summary}`)
      .join('\n\n')}`,
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');
}

function taskResultsBlock(title: string, results: TaskResult[]): string | undefined {
  if (results.length === 0) return undefined;
  return `${title}:\n${results.map((r) => `### ${r.subagentId}/${r.taskId}\n${summarizeTaskResult(r).summary}`).join('\n\n')}`;
}

function priorAttemptsBlock(
  attempts: Array<{ attempt: number; reports: QualityRoleReport[] }>,
): string | undefined {
  if (attempts.length === 0) return undefined;
  return `Prior quality gate attempts:\n${attempts
    .map(
      (a) =>
        `### Attempt ${a.attempt}\n${a.reports
          .map((r) => `- ${r.role}: ${r.verdict}${r.error ? ` (${r.error})` : ''}`)
          .join('\n')}`,
    )
    .join('\n\n')}`;
}

function summarizeTaskResult(result: TaskResult): {
  taskId: string;
  subagentId: string;
  status: TaskResult['status'];
  summary: string;
  error?: string | undefined;
} {
  const text =
    typeof result.result === 'string'
      ? result.result
      : result.result !== undefined
        ? JSON.stringify(result.result, null, 2)
        : '';
  const error = result.error ? `${result.error.kind}: ${result.error.message}` : undefined;
  return {
    taskId: result.taskId,
    subagentId: result.subagentId,
    status: result.status,
    summary: excerpt(text || error || '(no output)', 4000),
    error,
  };
}

function assessRoleResult(
  role: 'reviewer' | 'verifier' | undefined,
  result: TaskResult,
): QualityRoleReport {
  const resolvedRole = role ?? (result.subagentId.includes('review') ? 'reviewer' : 'verifier');
  const summary = summarizeTaskResult(result);
  const text = summary.summary;
  const uncertaintyFlags = extractSection(text, 'Uncertainty Flags');
  if (result.status !== 'success') {
    return {
      role: resolvedRole,
      subagentId: result.subagentId,
      taskId: result.taskId,
      status: result.status,
      verdict: 'fail',
      summary: text,
      uncertaintyFlags,
      error: summary.error ?? result.status,
    };
  }
  return {
    role: resolvedRole,
    subagentId: result.subagentId,
    taskId: result.taskId,
    status: result.status,
    verdict: parseQualityVerdict(resolvedRole, text),
    summary: text,
    uncertaintyFlags,
  };
}

function assessQualityGate(reports: QualityRoleReport[]): QualityGateAssessment {
  const mustFix: string[] = [];
  const uncertaintyFlags: string[] = [];
  let hasFail = false;
  let hasInconclusive = false;

  for (const report of reports) {
    if (report.verdict === 'fail') hasFail = true;
    if (report.verdict === 'inconclusive') hasInconclusive = true;
    const blocking =
      extractSection(report.summary, 'Must Fix') ||
      extractSection(report.summary, 'Failures') ||
      extractSection(report.summary, 'Verification Gaps');
    if (blocking) mustFix.push(`${report.role}: ${excerpt(blocking, 1000)}`);
    if (report.uncertaintyFlags) {
      uncertaintyFlags.push(`${report.role}: ${excerpt(report.uncertaintyFlags, 1000)}`);
    }
    if (report.error) mustFix.push(`${report.role}: ${report.error}`);
  }

  if (hasFail) return { verdict: 'fail', passed: false, mustFix, uncertaintyFlags };
  if (hasInconclusive || reports.length === 0) {
    return { verdict: 'inconclusive', passed: false, mustFix, uncertaintyFlags };
  }
  return { verdict: 'pass', passed: true, mustFix, uncertaintyFlags };
}

function parseQualityVerdict(role: 'reviewer' | 'verifier', text: string): QualityGateVerdict {
  const normalized = text.toLowerCase();
  const verdictBlock =
    normalized.match(/(?:^|\n)\s*(?:#+\s*)?verdict\b[^\n]*(?:\n|:|-)?([\s\S]{0,500})/)?.[0] ??
    normalized.slice(0, 1000);
  if (role === 'reviewer') {
    if (
      /\b(request\s+changes|needs\s+verification|reject|rejected|fail|failed|blocked)\b/.test(
        verdictBlock,
      )
    ) {
      return 'fail';
    }
    if (/\b(approve|approved|pass|passed)\b/.test(verdictBlock)) return 'pass';
    if (
      sectionHasBlockingContent(text, 'Must Fix') ||
      sectionHasBlockingContent(text, 'Verification Gaps')
    ) {
      return 'fail';
    }
    return 'inconclusive';
  }
  if (/\b(fail|failed|blocked|red)\b/.test(verdictBlock)) return 'fail';
  if (/\b(pass|passed|green|approve|approved)\b/.test(verdictBlock)) return 'pass';
  if (sectionHasBlockingContent(text, 'Failures')) return 'fail';
  return 'inconclusive';
}

function sectionHasBlockingContent(text: string, heading: string): boolean {
  const section = extractSection(text, heading);
  if (!section) return false;
  return !/^\s*(none|n\/a|no\b|no issues|empty|\(none\))\s*\.?\s*$/i.test(section.trim());
}

function extractSection(text: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\n)\\s*#{1,6}\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=\\n\\s*#{1,6}\\s+|$)`,
    'i',
  );
  const match = text.match(pattern);
  const body = match?.[1]?.trim();
  return body ? body : undefined;
}

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20).trimEnd()}\n...(truncated)`;
}

export function makeAssignTool(director: Pick<Host.DirectorAssignmentPort, 'assign'>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      subagentId: { type: 'string', minLength: 1, description: 'Target subagent id. Required.' },
      description: {
        type: 'string',
        minLength: 1,
        description: 'The task in natural language — what you want this subagent to do.',
      },
      maxToolCalls: {
        type: 'number',
        minimum: 1,
        description: 'Optional per-task tool-call budget override.',
      },
      timeoutMs: { type: 'number', minimum: 1, description: 'Optional per-task timeout in ms.' },
    },
    required: ['subagentId', 'description'],
  };
  return {
    name: 'assign_task',
    description:
      'Queue a task on a previously spawned subagent. NON-BLOCKING: returns a `taskId` IMMEDIATELY — the subagent processes the task on its next iteration with its own LLM budget. The `taskId` is the durable handle for retrieving the result later via `await_tasks`, `roll_up`, or `ask_result`. Many `assign_task` calls can be in flight in parallel against the same or different subagents. This is the primary tool for fan-out work; do NOT use `delegate` to spawn multiple investigations sequentially.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema,
    async execute(input: unknown) {
      const i = input as {
        subagentId: string;
        description: string;
        maxToolCalls?: number | undefined;
        timeoutMs?: number | undefined;
      };
      const task: TaskSpec = {
        id: randomUUID(),
        description: i.description,
        subagentId: i.subagentId,
        maxToolCalls: i.maxToolCalls,
        timeoutMs: i.timeoutMs,
      };
      const taskId = await director.assign(task);
      return { taskId, subagentId: i.subagentId };
    },
  };
}

interface KanbanQueueInput {
  action?: 'dispatch_ready' | undefined;
  boardId?: string | undefined;
  taskId?: string | undefined;
  query?: string | undefined;
  maxTasks?: number | undefined;
  awaitCompletion?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxToolCalls?: number | undefined;
  agentId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
  worktree?: SubagentConfig['worktree'] | undefined;
  heartbeatIntervalMs?: number | undefined;
  leaseTtlMs?: number | undefined;
}

export function makeKanbanQueueTool(
  director: Host.DirectorLeaseRecoveryPort,
  roster?: Record<string, SubagentConfig>,
): Tool {
  return {
    name: 'kanban_queue',
    description:
      'Claim dependency-ready Kanban tasks and dispatch them into the Director fleet. Preserves per-task provider/model/role/tool routing metadata, seeds lease metadata (claimedAt, leaseExpiresAt, heartbeatAt), assigns each claimed task to a spawned subagent, instructs workers to call kanban heartbeat_assignment periodically, and can await results while writing completion back to Kanban.',
    usageHint:
      'Use action:"dispatch_ready" with optional boardId/taskId/maxTasks. Set heartbeatIntervalMs (default 60s) and leaseTtlMs (default 5m) to size stale-recovery windows. Set awaitCompletion:true when you want this call to update Kanban to completed/failed before returning; otherwise use await_tasks and kanban mark_assignment later.',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN, ToolCapabilities.FS_WRITE],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dispatch_ready'] },
        boardId: { type: 'string', description: 'Optional board id/prefix to claim from.' },
        taskId: { type: 'string', description: 'Optional exact task id/prefix to claim.' },
        query: { type: 'string', description: 'Optional natural-language filter for ready tasks.' },
        maxTasks: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of ready tasks to claim and dispatch. Default 1.',
        },
        awaitCompletion: {
          type: 'boolean',
          description:
            'When true, waits for assigned fleet task results and writes completed/failed back to Kanban.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Optional per-assigned-task timeout in ms.',
        },
        maxToolCalls: {
          type: 'number',
          minimum: 1,
          description: 'Optional per-assigned-task tool-call cap.',
        },
        heartbeatIntervalMs: {
          type: 'number',
          minimum: 1000,
          description:
            'Suggested heartbeat interval for the worker. Default 60000 (60s). Workers are instructed to call kanban heartbeat_assignment at this cadence.',
        },
        leaseTtlMs: {
          type: 'number',
          minimum: 1000,
          description:
            'Lease time-to-live seeded on dispatch. Default 300000 (5m). Workers should refresh via heartbeat_assignment before expiry.',
        },
        agentId: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        fallbackModels: { type: 'array', items: { type: 'string' } },
        tools: { type: 'array', items: { type: 'string' } },
        allowedCapabilities: { type: 'array', items: { type: 'string' } },
        worktree: {
          anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
        },
      },
    } satisfies JSONSchema,
    async execute(input: unknown, ctx) {
      const i = normalizeKanbanQueueInput(input);
      const rawAction = (input as { action?: unknown } | null | undefined)?.action;
      if (rawAction !== undefined && rawAction !== 'dispatch_ready') {
        return { error: `Unknown kanban_queue action: ${String(rawAction)}` };
      }
      const projectRoot = ctx.projectRoot;
      if (!projectRoot) return { error: 'kanban_queue requires ctx.projectRoot.' };
      const maxTasks = Math.max(1, Math.min(20, Math.floor(i.maxTasks ?? 1)));
      const baseLeaseTtlMs = Math.max(1000, Math.floor(i.leaseTtlMs ?? 5 * 60 * 1000));
      // When awaitCompletion is true, the lease must survive until the task timeout
      // (plus a 1-minute buffer) so the supervisor never reclaims a task whose
      // worker is still running and being awaited.
      const leaseTtlMs =
        i.awaitCompletion === true && i.timeoutMs !== undefined
          ? Math.max(baseLeaseTtlMs, i.timeoutMs + 60_000)
          : baseLeaseTtlMs;
      // Heartbeat at half the lease TTL so renewal always lands before expiry.
      // The 5s minimum heartbeat interval can exceed the schema-supported lease
      // TTL range (1000–4999 ms), which would let such a lease expire before
      // its first renewal. effectiveLeaseTtlMs raises the actual lease window
      // to at least 2x the heartbeat interval so the first heartbeat is always
      // in-flight before expiry. This single effective TTL governs the initial
      // lease seeding, the dispatch-time stamp, and every heartbeat refresh so
      // all three agree.
      // Use the caller's explicit heartbeat interval when provided, otherwise
      // derive a safe interval from the lease TTL (at most half so the first
      // renewal always lands before expiry). Clamp to at least 5 seconds to
      // avoid busy-looping the heartbeat timer.
      const heartbeatIntervalMs = Math.max(
        5_000,
        i.heartbeatIntervalMs ?? Math.floor(leaseTtlMs / 2),
      );
      const effectiveLeaseTtlMs = Math.max(leaseTtlMs, heartbeatIntervalMs * 2);
      const claimedAt = nowIso();
      const leaseSeeding: {
        leaseId: string;
        claimedAt: string;
        heartbeatAt: string;
        leaseExpiresAt: string;
      } = {
        leaseId: randomUUID(),
        claimedAt,
        heartbeatAt: claimedAt,
        leaseExpiresAt: new Date(Date.now() + effectiveLeaseTtlMs).toISOString(),
      };
      const candidateTaskIds =
        i.taskId !== undefined
          ? [i.taskId]
          : i.query
            ? (
                await listReadyTasks(projectRoot, {
                  ...(i.boardId !== undefined ? { boardId: i.boardId } : {}),
                })
              )
                .filter((candidate) => matchesKanbanQueueQuery(candidate.task, i.query ?? ''))
                .slice(0, maxTasks)
                .map((candidate) => candidate.task.id)
            : undefined;
      const dispatches: Array<{
        boardId: string;
        taskId: string;
        title: string;
        subagentId: string;
        runTaskId: string;
        provider?: string | undefined;
        model?: string | undefined;
      }> = [];
      const errors: Array<{ taskId?: string | undefined; error: string }> = [];
      const resultFailures: Array<{
        taskId: string;
        runTaskId: string;
        status: TaskResult['status'];
        error: string;
      }> = [];
      // Budget-rejected task IDs for this dispatch pass. When the cost gate
      // releases an unaffordable task back to pending, the exclusion set
      // prevents re-claiming the same task on every iteration and starving
      // affordable ready work. Cleared when this dispatch_ready call returns.
      const budgetRejectedTaskIds = new Set<string>();

      for (let index = 0; index < maxTasks; index++) {
        const candidateTaskId = candidateTaskIds?.[index];
        if (candidateTaskIds && !candidateTaskId) break;
        // Skip tasks that were budget-rejected earlier in this dispatch pass
        // so they cannot starve affordable ready work in the same pass.
        if (candidateTaskId && budgetRejectedTaskIds.has(candidateTaskId)) continue;
        const claim = await claimReadyTask(projectRoot, {
          ...(i.boardId !== undefined ? { boardId: i.boardId } : {}),
          ...(candidateTaskId !== undefined ? { taskId: candidateTaskId } : {}),
          ...(i.agentId !== undefined ? { agentId: i.agentId } : {}),
          ...(i.name !== undefined ? { name: i.name } : {}),
          ...(i.role !== undefined ? { role: i.role } : {}),
          ...(i.provider !== undefined ? { provider: i.provider } : {}),
          ...(i.model !== undefined ? { model: i.model } : {}),
          ...(i.fallbackModels !== undefined ? { fallbackModels: i.fallbackModels } : {}),
          ...(i.tools !== undefined ? { tools: i.tools } : {}),
          ...(i.allowedCapabilities !== undefined
            ? { allowedCapabilities: i.allowedCapabilities }
            : {}),
          ...(leaseSeeding !== undefined ? leaseSeeding : {}),
          status: 'queued',
        });
        if (!claim) {
          if (candidateTaskIds) continue;
          break;
        }
        let subagentId: string | undefined;
        let runTaskId: string | undefined;

        // Sprint 3: cost-ceiling budget check before spawning. A rejected
        // dispatch is a terminal assignment failure for this queue attempt;
        // preserve the assignment and its diagnostic so callers can inspect
        // why no worker was started.
        const costCeiling = claim.task.assignment?.costCeilingUsd;
        if (costCeiling !== undefined) {
          const remaining = director.getRemainingBudgetUsd();
          if (remaining !== undefined && remaining < costCeiling) {
            budgetRejectedTaskIds.add(claim.task.id);
            const budgetError = `Cost ceiling ${costCeiling} exceeds remaining budget ${remaining.toFixed(4)}`;
            await updateTaskAssignment(
              projectRoot,
              claim.board.id,
              claim.task.id,
              {
                ...(claim.task.assignment ?? {}),
                status: 'failed',
                error: budgetError,
              },
              { expectedLeaseId: leaseSeeding.leaseId },
            );
            errors.push({
              taskId: claim.task.id,
              error: budgetError,
            });
            continue;
          }
        }

        try {
          const config = buildKanbanSubagentConfig(claim.task, i, roster);
          subagentId = await director.spawn(config);
          const dispatchTaskId = randomUUID();
          const taskSpec = {
            id: dispatchTaskId,
            subagentId,
            description: buildKanbanFleetTaskPrompt(claim.board, claim.task, {
              // The worker must heartbeat against the lease it actually holds.
              // effectiveLeaseTtlMs is the real lease window (raised from the
              // requested TTL when needed so the first heartbeat always lands
              // before expiry), and the computed heartbeatIntervalMs is always
              // strictly shorter than that window. Passing the raw requested
              // values here would give the worker a 60s cadence against a
              // 10s lease, letting the lease expire before its first renewal.
              heartbeatIntervalMs,
              leaseTtlMs: effectiveLeaseTtlMs,
              leaseId: leaseSeeding.leaseId,
              leaseExpiresAt: leaseSeeding.leaseExpiresAt,
            }),
            ...(i.maxToolCalls !== undefined ? { maxToolCalls: i.maxToolCalls } : {}),
            ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
            context: {
              ...(claim.task.type !== undefined ? { taskType: claim.task.type } : {}),
              kanban: {
                boardId: claim.board.id,
                taskId: claim.task.id,
                origin: claim.task.origin,
                projectRoot,
                leaseId: leaseSeeding.leaseId,
              },
            },
          };
          // Fence the running-state write BEFORE handing the task to
          // Director.assign(). The coordinator starts dispatch synchronously
          // from assign(), so fencing afterwards leaves a window in which a
          // reassigned task can already begin executing. Pre-generating the run
          // id lets the board record the exact id without opening that window.
          // updateTaskAssignment checks expectedLeaseId inside the mutateBoard
          // lock (assignment.ts) and returns null on mismatch.
          const dispatched = await updateTaskAssignment(
            projectRoot,
            claim.board.id,
            claim.task.id,
            {
              ...(claim.task.assignment ?? {}),
              status: 'running',
              subagentId,
              runTaskId: dispatchTaskId,
              // Renew the lease from the actual dispatch moment, not from claim
              // time. The claim-time lease starts before spawn + queueing, so
              // `timeoutMs + 60_000` can expire while the worker is still
              // queued or running, letting recover_stale reclaim and duplicate
              // the assignment (see auto-extend.ts: timeout extensions can push
              // execution well past the original timeoutMs). Both heartbeatAt
              // and leaseExpiresAt are stamped from now so the worker has a
              // full lease window from the moment it was actually dispatched.
              heartbeatAt: new Date().toISOString(),
              leaseExpiresAt: new Date(Date.now() + effectiveLeaseTtlMs).toISOString(),
            },
            { expectedLeaseId: leaseSeeding.leaseId },
          );
          if (dispatched === null) {
            // Ownership was lost before dispatch: recover_stale already
            // reclaimed and reassigned the task. Because assign() has not been
            // called yet, terminating the idle spawned agent guarantees this
            // orphan never begins executing the reassigned task.
            try {
              await director.terminate(subagentId);
            } catch (cleanupErr) {
              // Best-effort: the successor owns the assignment now; a failure
              // to terminate our orphan is surfaced but must not block.
              errors.push({
                taskId: claim.task.id,
                error: `Lease lost during dispatch; orphan subagent ${subagentId} termination failed: ${toErrorMessage(cleanupErr)}`,
              });
              continue;
            }
            errors.push({
              taskId: claim.task.id,
              error: `Lease lost during dispatch (reassigned by recovery); subagent ${subagentId} terminated.`,
            });
            continue;
          }
          await director.assign(taskSpec);
          runTaskId = dispatchTaskId;
          dispatches.push({
            boardId: claim.board.id,
            taskId: claim.task.id,
            title: claim.task.title,
            subagentId,
            runTaskId,
            ...(config.provider !== undefined ? { provider: config.provider } : {}),
            ...(config.model !== undefined ? { model: config.model } : {}),
          });
        } catch (err) {
          let message = toErrorMessage(err);
          if (subagentId && !runTaskId) {
            try {
              await director.terminate(subagentId);
            } catch (cleanupErr) {
              message = `${message}; cleanup failed for spawned subagent ${subagentId}: ${toErrorMessage(cleanupErr)}`;
            }
          }
          // Fence the failure write too: if the claim lease expired during
          // spawn/assign and recover_stale reassigned the task, a stale
          // failure write here must not overwrite the successor's assignment.
          // When ownership was lost the write is a no-op (returns null); we
          // still surface the dispatch error to the caller below.
          await updateTaskAssignment(
            projectRoot,
            claim.board.id,
            claim.task.id,
            {
              ...(claim.task.assignment ?? {}),
              status: 'failed',
              ...(subagentId !== undefined ? { subagentId } : {}),
              ...(runTaskId !== undefined ? { runTaskId } : {}),
              error: message,
            },
            { expectedLeaseId: leaseSeeding.leaseId },
          );
          errors.push({ taskId: claim.task.id, error: message });
        }
      }

      // Extension-driven lease renewal for fire-and-forget dispatches.
      // The awaitCompletion branch below renews leases while awaiting
      // results, but a non-awaited dispatch returns immediately — nothing
      // would renew the lease when the coordinator's auto-extend policy
      // (auto-extend.ts) grants timeout extensions past the dispatch-time
      // lease window, letting recover_stale reclaim a live task. This
      // detached supervisor renews each dispatched lease (fenced with
      // expectedLeaseId, so a reassigned task is never touched) until the
      // worker reaches a terminal fleet event (subagent.completed /
      // subagent.stopped), with a hard ceiling matching the 24h auto-extend
      // timeout cap so a missed terminal event cannot leak the timer forever.
      if (
        !i.awaitCompletion &&
        dispatches.length > 0 &&
        typeof director.fleet?.subscribe === 'function'
      ) {
        const ourLeaseId = leaseSeeding.leaseId;
        const disposers = new Map<string, () => void>();
        const renewalStartedAt = Date.now();
        const maxRenewalWindowMs = 24 * 60 * 60_000;
        const stopAll = (): void => {
          clearInterval(renewalTimer);
          for (const dispose of disposers.values()) dispose();
          disposers.clear();
        };
        const renewalTimer = setInterval(() => {
          if (disposers.size === 0 || Date.now() - renewalStartedAt > maxRenewalWindowMs) {
            stopAll();
            return;
          }
          const refreshedExpiry = new Date(Date.now() + effectiveLeaseTtlMs).toISOString();
          for (const dispatch of dispatches) {
            if (!disposers.has(dispatch.runTaskId)) continue;
            // Fire-and-forget renewal: the expectedLeaseId fence inside
            // heartbeatTaskAssignment's mutateBoard lock makes a stale
            // renewal a no-op; transient write errors simply retry next tick.
            void renewAndRevokeLease({
              projectRoot,
              boardId: dispatch.boardId,
              taskId: dispatch.taskId,
              subagentId: dispatch.subagentId,
              runTaskId: dispatch.runTaskId,
              ourLeaseId,
              refreshedExpiry,
              director,
              disposers,
            });
          }
        }, heartbeatIntervalMs);
        renewalTimer.unref?.();
        for (const dispatch of dispatches) {
          const dispose = director.fleet.subscribe(dispatch.subagentId, (event) => {
            if (event.type !== 'subagent.completed' && event.type !== 'subagent.stopped') return;
            if (event.type === 'subagent.completed' && event.taskId !== dispatch.runTaskId) return;
            disposers.get(dispatch.runTaskId)?.();
            disposers.delete(dispatch.runTaskId);
            if (disposers.size === 0) clearInterval(renewalTimer);
          });
          disposers.set(dispatch.runTaskId, dispose);
        }
      }

      let results: TaskResult[] | undefined;
      if (i.awaitCompletion && dispatches.length > 0) {
        // The dispatch-time lease covers the original timeoutMs, but the
        // coordinator's auto-extend policy (auto-extend.ts) can grant timeout
        // extensions while the worker makes progress — up to a 24h ceiling.
        // Without supervisor-side renewal, the lease can expire while the
        // awaited worker is still legitimately running, letting recover_stale
        // reclaim and duplicate the assignment. heartbeatIntervalMs and
        // effectiveLeaseTtlMs were computed above (before lease seeding) so
        // the initial lease, dispatch stamp, and every refresh agree.
        const ourLeaseId = leaseSeeding.leaseId;
        const runTaskIds = new Set(dispatches.map((dispatch) => dispatch.runTaskId));
        let heartbeatRunning = false;
        let heartbeatInFlight: Promise<void> = Promise.resolve();
        const runHeartbeat = async (): Promise<void> => {
          const refreshedExpiry = new Date(Date.now() + effectiveLeaseTtlMs).toISOString();
          for (const dispatch of dispatches) {
            // Only heartbeat tasks still in flight; resolved ones are
            // finalized below after awaitTasks settles.
            if (!runTaskIds.has(dispatch.runTaskId)) continue;
            // Atomic lease revocation check before heartbeating. If the
            // supervisor reclaimed and reassigned this task (changing its
            // leaseId), terminate the stale subagent immediately so it stops
            // writing files. The awaitTasks below will pick up the stopped
            // result and write it back (fenced, so a no-op vs the successor).
            try {
              const board = await getBoard(projectRoot, dispatch.boardId);
              const liveTask = board?.tasks.find((t) => t.id === dispatch.taskId);
              // Defensive guard: no assignment means the task was
              // released or recovered (e.g. mode='release') — the
              // subagent no longer owns it. Terminate immediately.
              // Capture the lease id explicitly so we don't mis-fire
              // when the task exists but has no assignment yet
              // (transient race during assignment removal): a literal
              // `undefined !== ourLeaseId` would terminate a legitimate
              // worker because undefined is not equal to any UUID.
              const liveLeaseId = liveTask?.assignment?.leaseId;
              if (liveLeaseId !== undefined && liveLeaseId !== ourLeaseId) {
                await director.terminate(dispatch.subagentId).catch(() => {});
                runTaskIds.delete(dispatch.runTaskId);
                continue;
              }
            } catch {
              // Board read is best-effort; on transient error the next
              // heartbeat interval tick retries. The heartbeat below is
              // fenced with expectedLeaseId so it's safe even without
              // the revocation check passing this cycle.
            }
            try {
              // Atomic ownership fence: expectedLeaseId is checked inside
              // heartbeatTaskAssignment's mutateBoard lock, so if the
              // supervisor recovered and reassigned the task (changing its
              // leaseId), the heartbeat is a no-op rather than a TOCTOU gap
              // that could renew the successor's lease.
              await heartbeatTaskAssignment(projectRoot, dispatch.boardId, dispatch.taskId, {
                leaseExpiresAt: refreshedExpiry,
                expectedLeaseId: ourLeaseId,
              });
            } catch {
              // Heartbeat failure is non-fatal: the next tick retries, and
              // the final status write is the source of truth. We must not
              // tear down the awaited dispatch over a transient write error.
            }
          }
        };
        const heartbeatTimer = setInterval(() => {
          // setInterval does not await async callbacks. Without this guard a
          // slow board store can accumulate overlapping heartbeat batches.
          if (heartbeatRunning) return;
          heartbeatRunning = true;
          heartbeatInFlight = runHeartbeat().finally(() => {
            heartbeatRunning = false;
          });
        }, heartbeatIntervalMs);

        try {
          results = await director.awaitTasks(dispatches.map((dispatch) => dispatch.runTaskId));
        } finally {
          clearInterval(heartbeatTimer);
          await heartbeatInFlight.catch(() => undefined);
        }
        for (const result of results) {
          const dispatch = dispatches.find((candidate) => candidate.runTaskId === result.taskId);
          if (!dispatch) continue;
          runTaskIds.delete(dispatch.runTaskId);
          // Atomic ownership fence: expectedLeaseId is checked inside
          // updateTaskAssignment's mutateBoard lock, so if the supervisor
          // recovered and reassigned the task while we were awaiting results,
          // the terminal write is a no-op rather than a TOCTOU gap that could
          // overwrite the successor's state with stale data.
          const terminalWrite = await updateTaskAssignment(
            projectRoot,
            dispatch.boardId,
            dispatch.taskId,
            {
              status: result.status === 'success' ? 'completed' : 'failed',
              subagentId: result.subagentId,
              runTaskId: result.taskId,
              ...(result.status === 'success'
                ? { lastResult: resultToText(result) }
                : { error: resultErrorText(result) }),
            },
            { expectedLeaseId: ourLeaseId },
          );
          // Universal completion gate: a completed assignment is parked in
          // review by updateTaskAssignment on gated boards; finalize runs the
          // verifier and applies the final status. Best-effort — a gate
          // failure must not turn a successful dispatch batch into an error.
          if (result.status === 'success' && terminalWrite) {
            try {
              await finalizeTaskCompletion(projectRoot, dispatch.boardId, dispatch.taskId, {
                eventContext: { actor: 'kanban-queue' },
              });
            } catch (error) {
              // Surface as a result failure so callers see the gate error
              // without failing the already-dispatched batch write.
              resultFailures.push({
                taskId: dispatch.taskId,
                runTaskId: result.taskId,
                status: 'failed',
                error: `completion gate failed: ${toErrorMessage(error)}`,
              });
            }
          }
          if (result.status !== 'success') {
            resultFailures.push({
              taskId: dispatch.taskId,
              runTaskId: result.taskId,
              status: result.status,
              error: resultErrorText(result),
            });
          }
        }
      }

      return {
        ok: errors.length === 0 && resultFailures.length === 0,
        dispatched: dispatches,
        count: dispatches.length,
        ...(results !== undefined ? { results } : {}),
        ...(errors.length > 0 ? { errors } : {}),
        ...(resultFailures.length > 0 ? { resultFailures } : {}),
        message:
          dispatches.length > 0
            ? `Dispatched ${dispatches.length} kanban task(s).`
            : 'No ready kanban task matched.',
      };
    },
  };
}

/**
 * Renew a kanban lease OR revoke it if the task was reassigned.
 *
 * Reads the live board to compare the task's current leaseId against the
 * frozen leaseId this supervisor was seeded with. When they differ, the
 * supervisor (or recover_stale) reclaimed and reassigned the task — this
 * subagent is stale and must be terminated to stop it from writing files.
 *
 * Fire-and-forget mode only (awaitCompletion uses its own inline check
 * inside `runHeartbeat`).
 */
async function renewAndRevokeLease(opts: {
  projectRoot: string;
  boardId: string;
  taskId: string;
  subagentId: string;
  runTaskId: string;
  ourLeaseId: string;
  refreshedExpiry: string;
  director: Host.DirectorLeaseRecoveryPort;
  disposers: Map<string, () => void>;
}): Promise<void> {
  const {
    projectRoot,
    boardId,
    taskId,
    subagentId,
    runTaskId,
    ourLeaseId,
    refreshedExpiry,
    director,
    disposers,
  } = opts;

  // Lease revocation check: read the live board and verify our leaseId
  // still matches. If recover_stale reclaimed the task, terminate the
  // stale subagent immediately to stop it from doing more work.
  let revoked = false;
  try {
    const board = await getBoard(projectRoot, boardId);
    const liveTask = board?.tasks.find((t) => t.id === taskId);
    // Defensive guard: no assignment means the task was
    // released or recovered (e.g. mode='release') — the
    // subagent no longer owns it. Terminate immediately.
    // Capture the lease id explicitly so we don't mis-fire
    // when the task exists but has no assignment yet
    // (transient race during assignment removal): a literal
    // `undefined !== ourLeaseId` would terminate a legitimate
    // worker because undefined is not equal to any UUID.
    const liveLeaseId = liveTask?.assignment?.leaseId;
    if (liveLeaseId !== undefined && liveLeaseId !== ourLeaseId) {
      await director.terminate(subagentId).catch(() => {});
      disposers.get(runTaskId)?.();
      disposers.delete(runTaskId);
      revoked = true;
    }
  } catch {
    // Board read is best-effort; on transient error the next interval tick
    // retries. The heartbeat below is fenced with expectedLeaseId so it's
    // safe even without the revocation check passing.
  }
  if (!revoked) {
    await heartbeatTaskAssignment(projectRoot, boardId, taskId, {
      leaseExpiresAt: refreshedExpiry,
      expectedLeaseId: ourLeaseId,
    }).catch(() => {});
  }
}

function normalizeKanbanQueueInput(input: unknown): KanbanQueueInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    action: raw.action === 'dispatch_ready' ? 'dispatch_ready' : undefined,
    boardId: typeof raw.boardId === 'string' ? raw.boardId : undefined,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
    query: typeof raw.query === 'string' ? raw.query : undefined,
    maxTasks: typeof raw.maxTasks === 'number' ? raw.maxTasks : undefined,
    awaitCompletion: typeof raw.awaitCompletion === 'boolean' ? raw.awaitCompletion : undefined,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    maxToolCalls: typeof raw.maxToolCalls === 'number' ? raw.maxToolCalls : undefined,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    fallbackModels: stringArray(raw.fallbackModels),
    tools: stringArray(raw.tools),
    allowedCapabilities: stringArray(raw.allowedCapabilities),
    worktree: normalizeWorktreeOverride(raw.worktree),
    heartbeatIntervalMs:
      typeof raw.heartbeatIntervalMs === 'number' ? raw.heartbeatIntervalMs : undefined,
    leaseTtlMs: typeof raw.leaseTtlMs === 'number' ? raw.leaseTtlMs : undefined,
  };
}

function buildKanbanSubagentConfig(
  task: KanbanTask,
  input: KanbanQueueInput,
  roster: Record<string, SubagentConfig> | undefined,
): SubagentConfig {
  const assignment = task.assignment;
  const role = input.role ?? assignment?.role;
  const base =
    role && roster?.[role] ? instantiateRosterConfig(role, roster[role] ?? {}) : undefined;
  const tools = input.tools ?? assignment?.tools ?? base?.tools;
  const name =
    input.name ??
    assignment?.name ??
    input.agentId ??
    assignment?.agentId ??
    task.assignedAgent ??
    role ??
    'kanban-agent';
  return {
    ...(base ?? { name }),
    name: base?.name ?? name,
    ...(role !== undefined ? { role } : {}),
    ...((input.provider ?? assignment?.provider)
      ? { provider: input.provider ?? assignment?.provider }
      : {}),
    ...((input.model ?? assignment?.model) ? { model: input.model ?? assignment?.model } : {}),
    ...((input.fallbackModels ?? assignment?.fallbackModels)
      ? { fallbackModels: input.fallbackModels ?? assignment?.fallbackModels }
      : {}),
    ...(tools ? { tools: ensureKanbanTool(tools) } : {}),
    ...((input.allowedCapabilities ?? assignment?.allowedCapabilities)
      ? { allowedCapabilities: input.allowedCapabilities ?? assignment?.allowedCapabilities }
      : {}),
    ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    ...(assignment?.costCeilingUsd !== undefined ? { maxCostUsd: assignment.costCeilingUsd } : {}),
  };
}

function ensureKanbanTool(tools: readonly string[]): string[] {
  return tools.includes('kanban') ? [...tools] : [...tools, 'kanban'];
}

function matchesKanbanQueueQuery(task: KanbanTask, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    task.title,
    task.description,
    task.assignedAgent,
    task.assignee,
    task.origin?.system,
    task.origin?.graphId,
    task.origin?.phaseId,
    ...(task.labels ?? []),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

function buildKanbanFleetTaskPrompt(
  board: KanbanBoard,
  task: KanbanTask,
  lease: {
    heartbeatIntervalMs: number;
    leaseTtlMs: number;
    leaseId: string;
    leaseExpiresAt: string;
  },
): string {
  const dependencyLines = (task.dependsOn ?? [])
    .map((depId) => board.tasks.find((candidate) => candidate.id === depId))
    .filter((dep): dep is KanbanTask => Boolean(dep))
    .map((dep) => `- ${dep.title} [${dep.status}] (${dep.id})`);
  const checks = task.successCriteria?.map((check) => `- ${check.description}`).join('\n');
  const metrics = task.goalMetrics
    ?.map(
      (metric) =>
        `- ${metric.name}: ${metric.current ?? 'n/a'}${metric.target !== undefined ? ` / ${metric.target}` : ''}${metric.unit ? ` ${metric.unit}` : ''} [${metric.status}]`,
    )
    .join('\n');
  const chain = task.chain
    ? [
        `chainId: ${task.chain.chainId}`,
        `order: ${task.chain.order}`,
        task.chain.previousTaskId ? `previous: ${task.chain.previousTaskId}` : '',
        task.chain.nextTaskId ? `next: ${task.chain.nextTaskId}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const routing = [
    task.assignment?.role ? `role: ${task.assignment.role}` : '',
    task.assignment?.provider ? `provider: ${task.assignment.provider}` : '',
    task.assignment?.model ? `model: ${task.assignment.model}` : '',
    task.assignment?.fallbackProfile ? `fallbackProfile: ${task.assignment.fallbackProfile}` : '',
    task.assignment?.fallbackModels?.length
      ? `fallbackModels: ${task.assignment.fallbackModels.join(', ')}`
      : '',
  ].filter(Boolean);
  const origin = task.origin
    ? [
        `system: ${task.origin.system}`,
        task.origin.graphId ? `graphId: ${task.origin.graphId}` : '',
        task.origin.phaseId ? `phaseId: ${task.origin.phaseId}` : '',
        task.origin.taskId ? `sourceTaskId: ${task.origin.taskId}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const boundaries = [
    board.boundary?.enabled ? `board: ${describeKanbanBoundary(board.boundary)}` : '',
    task.boundary?.enabled ? `task: ${describeKanbanBoundary(task.boundary)}` : '',
    ...(board.boundary?.allow ?? []).map(
      (selector) => `board allow ${selector.access} ${selector.kind}:${selector.path}`,
    ),
    ...(task.boundary?.allow ?? []).map(
      (selector) => `task allow ${selector.access} ${selector.kind}:${selector.path}`,
    ),
  ].filter(Boolean);
  return [
    'You are processing a claimed WrongStack Kanban task.',
    '',
    `Board: ${board.title} (${board.id})`,
    `Task: ${task.title} (${task.id})`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    task.description ? `Description:\n${task.description}` : '',
    origin ? `Origin:\n${origin}` : '',
    routing.length ? `Routing hints:\n${routing.join('\n')}` : '',
    chain ? `Task chain:\n${chain}` : '',
    dependencyLines.length ? `Dependencies:\n${dependencyLines.join('\n')}` : '',
    checks ? `Success criteria:\n${checks}` : '',
    metrics ? `Goal metrics:\n${metrics}` : '',
    task.labels?.length ? `Labels: ${task.labels.join(', ')}` : '',
    boundaries.length
      ? `BOUNDARY CONTRACT (enforced by the tool runtime; do not attempt to bypass):\n${boundaries.map((line) => `- ${line}`).join('\n')}`
      : '',
    'Lease contract (Sprint 1):',
    `- leaseId: ${lease.leaseId}`,
    `- claimedAt: ${task.assignment?.claimedAt ?? '<unknown>'}`,
    `- leaseExpiresAt: ${lease.leaseExpiresAt}`,
    `- expected heartbeatIntervalMs: ${lease.heartbeatIntervalMs}`,
    `- expected leaseTtlMs: ${lease.leaseTtlMs}`,
    '',
    'Retry policy:',
    `- retryPolicy: ${task.assignment?.retryPolicy ?? task.retryPolicy ?? '<unset>'}`,
    `- maxAttempts: ${task.assignment?.maxAttempts ?? '<unset>'}`,
    `- costCeilingUsd: ${task.assignment?.costCeilingUsd ?? task.costCeilingUsd ?? '<unset>'}`,
    '',
    'Work this task end-to-end. Treat the board as a live plan, not a frozen assignment snapshot.',
    `Before material work and whenever evidence changes the plan, call kanban with action "get_board" and boardId "${board.id}" to reassess current tasks, dependencies, priorities, and peer changes.`,
    'You may use kanban add_task, update_task, split_task, merge_tasks, move_task, delete_task, or dependency actions when reassessment shows the plan should change. Preserve traceability and do not keep obsolete work merely because it existed at dispatch time.',
    '',
    'FIELD MAINTENANCE — keep every task detail current:',
    '- Call "update_task" to refresh description, priority, type, labels, or estimatedHours as the work evolves.',
    '- Call "add_note" with author and content to record progress, decisions, or roadblock context.',
    '- Call "add_check" / "update_check" with description and status (pending/passed/failed) to track acceptance criteria.',
    '- Call "add_goal_metric" / "update_goal_metric" with name and current/target to report measurable progress.',
    '- Call "add_link" with url and type (issue/pr/doc/commit/design/file/url/other) to attach evidence.',
    '- Call "update_task" to set actualHours when you have a final time estimate.',
    'Do not leave stale or placeholder field values — the kanban board is the shared source of truth for every stakeholder.',
    '',
    'LEASE & LIFECYCLE:',
    'Every successful board mutation updates shared pending work and notifies the owning session. Re-read the board after mutations and adapt to changes made by other agents; never assume your initial todo list remains authoritative.',
    `When you start, call kanban with action "mark_assignment", boardId "${board.id}", taskId "${task.id}", assignmentStatus "running", and expectedLeaseId "${lease.leaseId}". Include subagentId and runTaskId when you have them. The expectedLeaseId fence makes the write a safe no-op if recover_stale already reassigned the task because your lease expired.`,
    `To stay alive in the queue, call kanban with action "heartbeat_assignment", boardId "${board.id}", taskId "${task.id}", heartbeatAt set to the current time, and expectedLeaseId "${lease.leaseId}". Cadence must be <= heartbeatIntervalMs and well before leaseExpiresAt. The expectedLeaseId fence makes the heartbeat a safe no-op if the lease was reassigned, so a stale worker cannot renew a successor's lease.`,
    `When you finish, call kanban with action "mark_assignment", boardId "${board.id}", taskId "${task.id}", assignmentStatus "completed" or "failed", and expectedLeaseId "${lease.leaseId}". Include lastResult or error. Populate every relevant detail field before the terminal mark_assignment so the card's final state is complete.`,
    `If you cannot finish in time, call kanban with action "heartbeat_assignment" to extend the lease, or with action "release_task" to release so another worker can claim. Do NOT silently abandon the assignment.`,
    'On failure the host may call kanban with action "recover_stale" (mode: retry/release/fail); respect its decisions and do not duplicate work in parallel.',
    'When finished, report what changed, what you verified, and any remaining blockers.',
  ]
    .filter(Boolean)
    .join('\n');
}

function resultToText(result: TaskResult): string {
  if (typeof result.result === 'string') return result.result;
  if (result.result === undefined) return '';
  try {
    return JSON.stringify(result.result);
  } catch {
    return String(result.result);
  }
}

function resultErrorText(result: TaskResult): string {
  return result.error ? `${result.error.kind}: ${result.error.message}` : result.status;
}

export function makeAwaitTasksTool(director: Host.DirectorAssignmentPort): Tool {
  return {
    name: 'await_tasks',
    description:
      'Block until one or more `taskId`s complete, then return their results. The subagents keep running in the background — only the leader\'s iteration pauses, which is the point: this is the correct tool to retrieve a result you started earlier with `assign_task`. mode:"all" (default) blocks until EVERY named task completes. mode:"any" returns as soon as AT LEAST ONE completes — use it for independent tasks so you can handle each finisher immediately (reassign work, spawn helpers) instead of idling on the slowest; call again with the returned `pending` ids to pick up the next finisher. The pattern "fan out via assign_task, then await_tasks({mode:\'any\'})" is the async replacement for serial `delegate` calls.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more task ids returned by `assign_task`.',
        },
        mode: {
          type: 'string',
          enum: ['all', 'any'],
          description:
            '"all" (default): block until every task completes. "any": return on the first completion with the rest listed as pending.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description:
            'mode:"any" only — return {timedOut:true, completed:[]} if nothing completes within this window instead of blocking.',
        },
      },
      required: ['taskIds'],
    },
    async execute(input: unknown) {
      const i = input as {
        taskIds: string[];
        mode?: 'all' | 'any' | undefined;
        timeoutMs?: number | undefined;
      };
      if (i.mode === 'any') {
        const r = await director.awaitTasksAny(
          i.taskIds,
          i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : undefined,
        );
        return {
          mode: 'any',
          completed: r.completed,
          pending: r.pending,
          ...(r.timedOut ? { timedOut: true } : {}),
          ...(r.pending.length > 0
            ? {
                hint: 'Handle the completed results now. Re-call await_tasks with the pending ids (mode:"any") for the next finisher — or assign new work to the now-idle subagent first.',
              }
            : {}),
        };
      }
      const results = await director.awaitTasks(i.taskIds);
      return { results };
    },
  };
}

export function makeAskTool(
  director: Host.DirectorQuestionPort & Host.DirectorAnswerStorePort,
): Tool {
  return {
    name: 'ask_subagent',
    description:
      'Synchronously ask a subagent a question. Blocks until the subagent replies via the bridge.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        subagentId: {
          type: 'string',
          minLength: 1,
          description: 'Subagent to ask. Must be a previously spawned id.',
        },
        question: { type: 'string', minLength: 1, description: 'The question or instruction.' },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Optional timeout in ms (default 30s).',
        },
      },
      required: ['subagentId', 'question'],
    },
    async execute(input: unknown) {
      const i = input as { subagentId: string; question: string; timeoutMs?: number | undefined };
      try {
        const answer = await director.ask(i.subagentId, { question: i.question }, i.timeoutMs);
        // Store large answers out-of-band; return only a summary string in ctx.
        const stored = director.largeAnswerStore.storeAnswer(answer);
        if (stored.inline) {
          return { ok: true, answer: stored.summary };
        }
        return {
          ok: true,
          answer: stored.summary,
          _answerKey: stored.key,
          _hint: 'Response was large and stored. Use ask_result with the key to retrieve it.',
        };
      } catch (err) {
        return { ok: false, error: toErrorMessage(err) };
      }
    },
  };
}

/**
 * Retrieve a previously stored `ask_subagent` answer by its store key.
 * The key was returned as `_answerKey` in the ask_subagent response.
 * Use this only for large responses that were stored out-of-context.
 */
export function makeAskResultTool(director: Host.DirectorAnswerStorePort): Tool {
  return {
    name: 'ask_result',
    description:
      'Retrieve a large `ask_subagent` response that was stored out-of-context (>2K chars). Returns the full stored value.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          minLength: 1,
          description: 'The `_answerKey` returned by `ask_subagent` for a large response.',
        },
      },
      required: ['key'],
    },
    async execute(input: unknown) {
      const i = input as { key: string };
      const value = director.largeAnswerStore.retrieveAnswer(i.key);
      if (value === undefined) {
        return {
          ok: false,
          error: `No stored answer found for key "${i.key}" — it may have been cleared or the key is invalid.`,
        };
      }
      return { ok: true, value };
    },
  };
}

export function makeRollUpTool(director: Pick<Host.DirectorQuestionPort, 'rollUp'>): Tool {
  return {
    name: 'roll_up',
    description: 'Aggregate completed task results into a single formatted summary.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Completed task ids to aggregate.',
        },
        style: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output flavor — markdown (default) or json.',
        },
      },
      required: ['taskIds'],
    },
    async execute(input: unknown) {
      const i = input as { taskIds: string[]; style?: 'markdown' | 'json' | undefined };
      const summary = director.rollUp(i.taskIds, i.style ?? 'markdown');
      return { summary, count: i.taskIds.length };
    },
  };
}

export function makeTerminateTool(director: Pick<Host.DirectorLifecyclePort, 'terminate'>): Tool {
  return {
    name: 'terminate_subagent',
    description:
      'Forcibly abort a subagent. The subagent finishes its current iteration then exits with status "stopped".',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: {
      type: 'object',
      properties: { subagentId: { type: 'string', description: 'Subagent to abort.' } },
      required: ['subagentId'],
    },
    async execute(input: unknown) {
      const i = input as { subagentId: string };
      await director.terminate(i.subagentId);
      return { ok: true };
    },
  };
}

export function makeTerminateAllTool(
  director: Pick<Host.DirectorLifecyclePort, 'terminateAll'>,
): Tool {
  return {
    name: 'terminate_all',
    description:
      'Forcibly stop every subagent in the fleet and drain the pending task queue. ' +
      'In-flight tasks are terminated mid-execution; pending tasks receive ' +
      '"aborted_by_parent" completion immediately. ' +
      'Use this when the fleet is wedged, looping, or you need a clean slate. ' +
      'Compare: work_complete stops spawning but lets running agents finish naturally.',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      await director.terminateAll();
      return {
        ok: true,
        message: `Fleet shutdown complete — all subagents stopped, pending tasks drained.`,
      };
    },
  };
}

/**
 * Unified fleet observation tool — consolidates the former fleet_status,
 * fleet_usage, fleet_session, and fleet_health tools under a single `action`
 * parameter (status, usage, health, session).
 *
 * These four are all read-only fleet queries; merging them into one tool
 * reduces tool-schema token overhead (4 × ~150 tokens → 1 × ~250 tokens)
 * and eliminates model confusion when choosing between similar tools.
 */
export function makeFleetTool(director: Host.DirectorReadModelPort): Tool {
  return {
    name: 'fleet',
    description:
      'Fleet observation tool. Use `action` to select what you need: ' +
      '"status" — snapshot of all subagents + coordinator counts + pending tasks; ' +
      '"usage" — token + cost breakdown per subagent and totals; ' +
      '"health" — per-subagent budget pressure, last activity, and status; ' +
      '"session" — read a subagent\'s JSONL transcript (requires subagentId).',
    usageHint:
      'action: "status" (default) | "usage" | "health" | "session".\n' +
      'For "session", pass subagentId (required) and optional tail (trailing JSONL lines).',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'usage', 'health', 'session'],
          description: 'Observation to retrieve (default: status).',
        },
        subagentId: {
          type: 'string',
          description: 'Subagent id (required for action: "session").',
        },
        tail: {
          type: 'number',
          description:
            'Number of trailing JSONL lines (action: "session" only). Omit for the full transcript.',
        },
      },
    },
    async execute(input: unknown) {
      const i = (input ?? {}) as {
        action?: string | undefined;
        subagentId?: string | undefined;
        tail?: number | undefined;
      };
      const action = i.action ?? 'status';

      switch (action) {
        case 'status': {
          const base = director.status();
          const fm = director.fleetManager;
          const stats = fm?.getFleetStats();
          const fleetStatus = fm?.getFleetStatus();
          return {
            action: 'status',
            subagents: base.subagents,
            coordinatorStats: stats
              ? {
                  total: stats.total,
                  running: stats.running,
                  idle: stats.idle,
                  stopped: stats.stopped,
                }
              : undefined,
            pending: fleetStatus?.pending ?? [],
            usage: fm?.snapshot(),
          };
        }

        case 'usage': {
          return { action: 'usage', ...director.snapshot() };
        }

        case 'health': {
          const status = director.status();
          const snapshot = director.snapshot();
          const subagents = status.subagents ?? [];
          const perSubagent = snapshot.perSubagent ?? {};
          return {
            action: 'health',
            subagents: subagents.map((s) => {
              const usage = perSubagent[s.id];
              return {
                id: s.id,
                status: s.status,
                lastEventAt: usage?.lastEventAt,
                budgetPressure: {
                  iterations: usage?.iterations,
                  toolCalls: usage?.toolCalls,
                  costUsd: usage?.cost,
                },
              };
            }),
          };
        }

        case 'session': {
          const subagentId = i.subagentId;
          if (!subagentId) {
            return {
              action: 'session',
              error: 'fleet: subagentId is required for action: "session"',
            };
          }
          const result = await director.readSession(subagentId, i.tail);
          if (!result) {
            return {
              action: 'session',
              error: `fleet: transcript unavailable for "${subagentId}". Is sessionsRoot configured?`,
            };
          }
          return { action: 'session', ...result };
        }

        default:
          return {
            error: `fleet: unknown action "${action}". Valid: status, usage, health, session.`,
          };
      }
    },
  };
}

/**
 * Collaborative debugging session: BugHunter, RefactorPlanner, and Critic
 * run in parallel on the same target files, with findings flowing through
 * the FleetBus (bug.found → refactor.plan → critic.evaluation).
 *
 * Returns a structured CollabDebugReport containing all bug findings,
 * refactor plans, critic evaluations, and an overall verdict.
 */
export function makeCollabDebugTool(director: Host.DirectorCollabPort): Tool {
  return {
    name: 'collab_debug',
    description:
      'Start a collaborative debugging session: BugHunter, RefactorPlanner, and Critic ' +
      'run in parallel on the same target files. BugHunter finds bugs and emits bug.found events. ' +
      'RefactorPlanner listens for bug.found and emits refactor.plan events. ' +
      'Critic evaluates both and emits critic.evaluation events. ' +
      'Returns a structured report with overall verdict (approve / needs_revision / reject).',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: {
      type: 'object',
      properties: {
        targetPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths / glob patterns to scan for bugs.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Timeout in ms. Default: 600000 (10 minutes).',
        },
        maxTargetFiles: {
          type: 'number',
          minimum: 1,
          description:
            'Maximum number of files to include in the snapshot. ' +
            'If not set, the limit is computed dynamically from contextWindow ' +
            'or falls back to the default (30).',
        },
        contextWindow: {
          type: 'number',
          minimum: 1,
          description:
            'Context window size (tokens) of the model. When provided and ' +
            'maxTargetFiles is not set, the file limit is computed dynamically ' +
            'as floor((contextWindow * 0.4) / 2000).',
        },
      },
      required: ['targetPaths'],
    },
    async execute(input: unknown) {
      const i = input as {
        targetPaths?: string[] | undefined;
        timeoutMs?: number | undefined;
        maxTargetFiles?: number | undefined;
        contextWindow?: number | undefined;
      };
      if (!i.targetPaths?.length) {
        return { error: 'collab_debug: targetPaths is required and must be non-empty.' };
      }
      const options: CollabSessionOptions = {
        targetPaths: i.targetPaths,
        timeoutMs: i.timeoutMs,
        maxTargetFiles: i.maxTargetFiles,
        contextWindow: i.contextWindow,
      };
      try {
        const report = await director.spawnCollab(options);
        return {
          sessionId: report.sessionId,
          overallVerdict: report.overallVerdict,
          bugCount: report.bugs.length,
          planCount: report.refactorPlans.length,
          evaluationCount: report.evaluations.length,
          summary: report.summary,
          bugs: report.bugs,
          refactorPlans: report.refactorPlans,
          evaluations: report.evaluations,
        };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { error: 'collab_debug failed: ' + msg };
      }
    },
  };
}

/**
 * Tool for subagents to emit structured events on the FleetBus.
 * Custom event types are extensible; known collab events are schema-validated
 * and restricted to their owning role before the Director routes them.
 * Common event types in collaborative sessions:
 *   bug.found        — BugHunter emits per-finding
 *   refactor.plan    — RefactorPlanner emits per-plan
 *   critic.evaluation — Critic emits per-evaluation
 *
 * The payload structure is event-type-specific. Use null for empty payloads.
 */
export function makeFleetEmitTool(director: Host.DirectorPublishingPort): Tool {
  return {
    name: 'fleet_emit',
    description:
      'Emit a structured event on the FleetBus. Known collaboration events are schema-validated and role-bound; custom event types remain extensible. Use it to stream findings, progress updates, or final results to other agents in real time.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_EMIT],
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Event type string (e.g. bug.found, refactor.plan, critic.evaluation, progress, result).',
        },
        payload: {
          type: 'object',
          description: 'Event payload. Structure depends on event type. Use null if no payload.',
        },
      },
      required: ['type'],
    },
    async execute(input: unknown, ctx) {
      const i = input as { type: string; payload?: Record<string, unknown> | null };
      const role = ctx.meta['agentRole'] as string | undefined;
      const validationError = validateFleetEventEmission(i.type, i.payload ?? {}, role);
      if (validationError) return { ok: false, error: validationError };
      const callerId = ctx.agentId && ctx.agentId !== 'unknown' ? ctx.agentId : director.id;
      const taskId = ctx.meta['subagentTaskId'] as string | undefined;
      director.fleet.emit({
        subagentId: callerId,
        taskId,
        ts: Date.now(),
        type: i.type,
        payload: i.payload ?? {},
      });
      return { ok: true, event: i.type };
    },
  };
}

/**
 * Signal that the director's work is satisfied and the fleet should wind down.
 *
 * Once called:
 * - `spawn_subagent` throws — no new subagents can be created
 * - `assign_task` synthesizes an immediate `aborted_by_parent` completion
 *   for any queued task (callers awaiting those tasks unblock immediately)
 * - Running subagents are NOT killed — they finish naturally; no new
 *   tasks are dispatched to them
 *
 * Use this when you are satisfied with the results and want the fleet to
 * stop spawning without forcibly stopping in-flight work. Call
 * `terminate_subagent` separately for any subagent you need to stop immediately.
 */
export function makeWorkCompleteTool(
  director: Pick<Host.DirectorLifecyclePort, 'workComplete'>,
): Tool {
  return {
    name: 'work_complete',
    description:
      'Signal that the director is satisfied with the results and the fleet should wind down. ' +
      'After calling this, spawn_subagent will refuse with a budget error and assign_task ' +
      'will instantly complete any queued tasks as aborted. Running subagents finish naturally. ' +
      'Call terminate_subagent separately to stop specific subagents immediately.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      director.workComplete();
      return { ok: true, message: 'Fleet wind-down signaled. No new spawns or task dispatches.' };
    },
  };
}
