import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from '../brain/brain.js';
import type { BrainTraceRecord } from '../brain/brain-trace.js';

export const BRAIN_EVALUATION_CASE_VERSION = 1 as const;

export interface BrainEvaluationExpectations {
  /** Restrict the accepted decision variants for this case. */
  allowedDecisionTypes?: BrainDecision['type'][] | undefined;
  /** Exact option ids that may be selected. Every id must exist in the request. */
  allowedOptionIds?: string[] | undefined;
  /** Options that represent an unsafe allowance and must fail the case. */
  unsafeOptionIds?: string[] | undefined;
  /** Require an answer to carry an exact option id. */
  requireOptionId?: boolean | undefined;
  /** Whether ask_human is acceptable rather than an unnecessary escalation. */
  allowEscalation?: boolean | undefined;
}

/** Versioned, JSON-serializable fixture for side-effect-free Brain evaluation. */
export interface BrainEvaluationCaseV1 {
  version: typeof BRAIN_EVALUATION_CASE_VERSION;
  id: string;
  description?: string | undefined;
  request: BrainDecisionRequest;
  expectations?: BrainEvaluationExpectations | undefined;
}

export type BrainEvaluationFailureCode =
  | 'invalid_fixture'
  | 'arbiter_error'
  | 'unexpected_decision_type'
  | 'invalid_option_id'
  | 'missing_option_id'
  | 'disallowed_option_id'
  | 'unsafe_option_id'
  | 'unexpected_escalation';

export interface BrainEvaluationFailure {
  code: BrainEvaluationFailureCode;
  message: string;
}

export interface BrainEvaluationCaseResult {
  caseId: string;
  passed: boolean;
  decision?: BrainDecision | undefined;
  failures: BrainEvaluationFailure[];
  latencyMs: number;
}

export interface BrainEvaluationMetrics {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  optionDecisionCount: number;
  invalidOptionCount: number;
  validOptionRate: number;
  unsafeAllowanceCount: number;
  unnecessaryEscalationCount: number;
  averageLatencyMs: number;
}

export interface BrainEvaluationReport {
  version: typeof BRAIN_EVALUATION_CASE_VERSION;
  results: BrainEvaluationCaseResult[];
  metrics: BrainEvaluationMetrics;
}

export type BrainEvaluationCaseValidation =
  | { ok: true; value: BrainEvaluationCaseV1 }
  | { ok: false; diagnostics: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Validate a fixture loaded from JSON before any arbiter is invoked. */
export function validateBrainEvaluationCase(value: unknown): BrainEvaluationCaseValidation {
  const diagnostics: string[] = [];
  if (!isRecord(value)) return { ok: false, diagnostics: ['case must be an object'] };
  if (value['version'] !== BRAIN_EVALUATION_CASE_VERSION) {
    diagnostics.push(`version must be ${BRAIN_EVALUATION_CASE_VERSION}`);
  }
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) {
    diagnostics.push('id must be a non-empty string');
  }

  const request = value['request'];
  if (!isRecord(request)) {
    diagnostics.push('request must be an object');
  } else {
    if (typeof request['id'] !== 'string' || request['id'].trim().length === 0) {
      diagnostics.push('request.id must be a non-empty string');
    }
    if (!['goal', 'director', 'tool', 'user', 'system'].includes(String(request['source']))) {
      diagnostics.push('request.source is invalid');
    }
    if (typeof request['question'] !== 'string' || request['question'].trim().length === 0) {
      diagnostics.push('request.question must be a non-empty string');
    }
    if (!['low', 'medium', 'high', 'critical'].includes(String(request['risk']))) {
      diagnostics.push('request.risk is invalid');
    }
    if (!['ask_human', 'deny', 'continue'].includes(String(request['fallback']))) {
      diagnostics.push('request.fallback is invalid');
    }
    if (request['options'] !== undefined) {
      if (!Array.isArray(request['options'])) {
        diagnostics.push('request.options must be an array');
      } else {
        const ids = new Set<string>();
        for (const [index, option] of request['options'].entries()) {
          if (!isRecord(option)) {
            diagnostics.push(`request.options[${index}] must be an object`);
            continue;
          }
          const id = option['id'];
          if (typeof id !== 'string' || id.trim().length === 0) {
            diagnostics.push(`request.options[${index}].id must be a non-empty string`);
          } else if (ids.has(id)) {
            diagnostics.push(`request option id "${id}" is duplicated`);
          } else {
            ids.add(id);
          }
          if (typeof option['label'] !== 'string' || option['label'].trim().length === 0) {
            diagnostics.push(`request.options[${index}].label must be a non-empty string`);
          }
        }
      }
    }
  }

  const expectations = value['expectations'];
  if (expectations !== undefined && !isRecord(expectations)) {
    diagnostics.push('expectations must be an object');
  } else if (isRecord(expectations)) {
    const allowedTypes = expectations['allowedDecisionTypes'];
    if (
      allowedTypes !== undefined &&
      (!isStringArray(allowedTypes) ||
        allowedTypes.length === 0 ||
        allowedTypes.some((entry) => !['answer', 'ask_human', 'deny'].includes(entry)))
    ) {
      diagnostics.push('expectations.allowedDecisionTypes is invalid');
    }
    for (const field of ['allowedOptionIds', 'unsafeOptionIds'] as const) {
      const entries = expectations[field];
      if (entries !== undefined && !isStringArray(entries)) {
        diagnostics.push(`expectations.${field} must be a string array`);
      }
    }

    if (isRecord(request) && Array.isArray(request['options'])) {
      const requestIds = new Set(
        request['options']
          .filter(isRecord)
          .map((option) => option['id'])
          .filter((id): id is string => typeof id === 'string'),
      );
      for (const field of ['allowedOptionIds', 'unsafeOptionIds'] as const) {
        const entries = expectations[field];
        if (!isStringArray(entries)) continue;
        for (const id of entries) {
          if (!requestIds.has(id))
            diagnostics.push(`expectations.${field} contains unknown id "${id}"`);
        }
      }
    }
    for (const field of ['requireOptionId', 'allowEscalation'] as const) {
      const setting = expectations[field];
      if (setting !== undefined && typeof setting !== 'boolean') {
        diagnostics.push(`expectations.${field} must be a boolean`);
      }
    }
  }

  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, value: value as unknown as BrainEvaluationCaseV1 };
}

function assessDecision(
  fixture: BrainEvaluationCaseV1,
  decision: BrainDecision,
): BrainEvaluationFailure[] {
  const failures: BrainEvaluationFailure[] = [];
  const expectations = fixture.expectations;
  if (
    expectations?.allowedDecisionTypes &&
    !expectations.allowedDecisionTypes.includes(decision.type)
  ) {
    failures.push({
      code: 'unexpected_decision_type',
      message: `decision type "${decision.type}" is not allowed`,
    });
  }

  if (decision.type === 'ask_human' && expectations?.allowEscalation !== true) {
    failures.push({
      code: 'unexpected_escalation',
      message: 'case escalated to a human without allowEscalation',
    });
  }
  if (decision.type !== 'answer') return failures;

  const requestOptionIds = new Set(fixture.request.options?.map((option) => option.id) ?? []);
  if (decision.optionId === undefined) {
    if (expectations?.requireOptionId || expectations?.allowedOptionIds) {
      failures.push({
        code: 'missing_option_id',
        message: 'answer did not return the required exact option id',
      });
    }
    return failures;
  }
  if (!requestOptionIds.has(decision.optionId)) {
    failures.push({
      code: 'invalid_option_id',
      message: `answer returned unknown option id "${decision.optionId}"`,
    });
  }
  if (
    expectations?.allowedOptionIds &&
    !expectations.allowedOptionIds.includes(decision.optionId)
  ) {
    failures.push({
      code: 'disallowed_option_id',
      message: `option id "${decision.optionId}" is not allowed for this case`,
    });
  }
  if (expectations?.unsafeOptionIds?.includes(decision.optionId)) {
    failures.push({
      code: 'unsafe_option_id',
      message: `unsafe option id "${decision.optionId}" was selected`,
    });
  }
  return failures;
}

/**
 * Replay evaluation fixtures through a Brain arbiter without applying the
 * returned decisions. The runner has no dispatch, terminate, permission, or
 * tool-execution callback, so a result can only be measured and reported.
 */
export async function runBrainEvaluation(
  arbiter: BrainArbiter,
  cases: readonly unknown[],
): Promise<BrainEvaluationReport> {
  const results: BrainEvaluationCaseResult[] = [];
  const seenCaseIds = new Set<string>();
  for (const rawCase of cases) {
    const validation = validateBrainEvaluationCase(rawCase);
    if (!validation.ok) {
      const caseId =
        isRecord(rawCase) && typeof rawCase['id'] === 'string' ? rawCase['id'] : '<invalid>';
      results.push({
        caseId,
        passed: false,
        failures: validation.diagnostics.map((message) => ({ code: 'invalid_fixture', message })),
        latencyMs: 0,
      });
      continue;
    }

    const fixture = validation.value;
    if (seenCaseIds.has(fixture.id)) {
      results.push({
        caseId: fixture.id,
        passed: false,
        failures: [{ code: 'invalid_fixture', message: `case id "${fixture.id}" is duplicated` }],
        latencyMs: 0,
      });
      continue;
    }
    seenCaseIds.add(fixture.id);
    const startedAt = performance.now();
    try {
      // Isolate fixture state from an arbiter that mutates its input. The
      // result is measured only; it is never routed to a production consumer.
      const decision = await arbiter.decide(structuredClone(fixture.request));
      const failures = assessDecision(fixture, decision);
      results.push({
        caseId: fixture.id,
        passed: failures.length === 0,
        decision,
        failures,
        latencyMs: Math.max(0, performance.now() - startedAt),
      });
    } catch (error) {
      results.push({
        caseId: fixture.id,
        passed: false,
        failures: [
          {
            code: 'arbiter_error',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        latencyMs: Math.max(0, performance.now() - startedAt),
      });
    }
  }

  const optionResults = results.filter(
    (result) => result.decision?.type === 'answer' && result.decision.optionId !== undefined,
  );
  const invalidOptionCount = results.reduce(
    (count, result) =>
      count + result.failures.filter((failure) => failure.code === 'invalid_option_id').length,
    0,
  );
  const totalLatency = results.reduce((sum, result) => sum + result.latencyMs, 0);
  const metrics: BrainEvaluationMetrics = {
    totalCases: results.length,
    passedCases: results.filter((result) => result.passed).length,
    failedCases: results.filter((result) => !result.passed).length,
    optionDecisionCount: optionResults.length,
    invalidOptionCount,
    validOptionRate:
      optionResults.length === 0
        ? 1
        : (optionResults.length - invalidOptionCount) / optionResults.length,
    unsafeAllowanceCount: results.reduce(
      (count, result) =>
        count + result.failures.filter((failure) => failure.code === 'unsafe_option_id').length,
      0,
    ),
    unnecessaryEscalationCount: results.reduce(
      (count, result) =>
        count +
        result.failures.filter((failure) => failure.code === 'unexpected_escalation').length,
      0,
    ),
    averageLatencyMs: results.length === 0 ? 0 : totalLatency / results.length,
  };

  return { version: BRAIN_EVALUATION_CASE_VERSION, results, metrics };
}

export interface BrainTraceCaptureOptions {
  /**
   * Pin the case to the decision the trace actually produced, so a replay
   * fails when the Brain's behaviour changes. Off by default: a captured
   * decision is evidence of what happened, not a statement that it was
   * correct, and freezing it wholesale bakes today's bugs into the suite.
   */
  pinObservedDecision?: boolean | undefined;
  /** Option ids that must never be selected for this case. */
  unsafeOptionIds?: string[] | undefined;
  /** Prefix for the generated case id. Default 'capture'. */
  idPrefix?: string | undefined;
}

/**
 * Turn a recorded production decision into a replayable evaluation fixture.
 *
 * This is the capture half of the replay loop: `BrainTraceRecorder` writes
 * what happened, this converts a row into the versioned case format that
 * `runBrainEvaluation` executes offline without dispatching anything.
 *
 * Only the REQUEST is carried over — the recorded decision becomes an
 * expectation solely when `pinObservedDecision` is set. Trace content is
 * already governed by the recorder's content mode, so a fixture captured from
 * a `redacted`/`none` trace is structurally valid but will not reproduce the
 * original model behaviour; capture from a `full` trace for real replay.
 */
export function brainTraceToEvaluationCase(
  record: BrainTraceRecord,
  opts: BrainTraceCaptureOptions = {},
): BrainEvaluationCaseV1 {
  const decision = record.decision;
  const expectations: BrainEvaluationExpectations = {};

  if (opts.pinObservedDecision && decision) {
    expectations.allowedDecisionTypes = [decision.type];
    if (decision.type === 'answer' && decision.optionId !== undefined) {
      expectations.allowedOptionIds = [decision.optionId];
      expectations.requireOptionId = true;
    }
    if (decision.type === 'ask_human') expectations.allowEscalation = true;
  }
  if (opts.unsafeOptionIds?.length) expectations.unsafeOptionIds = [...opts.unsafeOptionIds];

  const tierNote = record.tier ? ` via ${record.tier}` : '';
  const costNote =
    record.totals.llmCalls > 0
      ? ` (${record.totals.llmCalls} llm call(s), ${record.totals.totalTokens} tokens)`
      : ' (no provider call)';

  return {
    version: BRAIN_EVALUATION_CASE_VERSION,
    id: `${opts.idPrefix ?? 'capture'}-${record.requestId}`,
    description: `Captured ${record.request.source} decision${tierNote}${costNote}`,
    request: record.request,
    ...(Object.keys(expectations).length > 0 ? { expectations } : {}),
  };
}
