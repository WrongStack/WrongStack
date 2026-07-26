import { randomUUID } from 'node:crypto';
import { ToolCapabilities } from '../security/capabilities.js';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { getAgentDefinition } from './agents/index.js';
import type * as Host from './director-host-contracts.js';
import {
  instantiateRosterConfig,
  normalizeWorktreeOverride,
  stringArray,
} from './director-input-helpers.js';

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
