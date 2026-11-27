/**
 * Shared implementation for the focused evidence analyzers.
 *
 * Given `path` or `content`, an analyzer inspects only that evidence (a file
 * or pasted command/CI output). Given neither, an analyzer that declares a
 * `project` collector inspects the calling project itself (`./project.ts`):
 * manifests, lockfile names and sources inside the project root, plus
 * read-only `git diff`/`status`/`ls-files` under the repository isolation env
 * (the same read-only git diff-summary runs automatically). No analyzer runs
 * a project script, installs anything, writes a file, or claims a broad check
 * passed; a collector that cannot read its evidence throws.
 */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Plugin, type PluginAPI, ToolValidationError } from '@wrongstack/contracts/types';
import {
  parseLlmJsonObject,
  runOptionalPluginCouncil,
  runOptionalPluginLlm,
} from '../runtime/llm.js';
import { safePath } from '../runtime/sandbox.js';
import { nonnegativeFiniteLimit, safePrefix } from '../runtime/string-boundaries.js';
import { capPerRule, type EvidenceFinding, type ProjectCollector } from './project.js';

export type { EvidenceFinding, ProjectCollection, ProjectCollector } from './project.js';

const MAX_INPUT_CHARS = 1_000_000;

export interface EvidenceRule {
  label: string;
  severity: 'info' | 'warning' | 'error';
  pattern: RegExp;
  advice: string;
}

export interface EvidenceAnalyzerProfile {
  name: string;
  toolName: string;
  description: string;
  evidenceHint: string;
  rules: readonly EvidenceRule[];
  /**
   * Rewrites pasted evidence before the rules run, keeping its line count so
   * reported line numbers stay true (e.g. blank a diff's context lines).
   */
  preprocess?: (content: string) => string;
  /** Structural checks a line regex cannot express; merged before rule findings. */
  inspect?: (content: string) => EvidenceFinding[];
  /** Inspect the project itself when the caller supplies neither path nor content. */
  project?: ProjectCollector;
  /** Extra configSchema properties read by the project collector (`context.options`). */
  options?: Record<string, Record<string, unknown>>;
}

interface EvidenceAnalyzerConfig {
  enabled: boolean;
  maxFindings: number;
  maxPerRule: number;
}

interface EvidenceAnalyzerState {
  analyses: number;
  readErrors: number;
  findings: number;
}

function readConfig(raw: unknown): EvidenceAnalyzerConfig {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const max = record['maxFindings'] ?? record['max_findings'];
  const perRule = record['maxPerRule'] ?? record['max_per_rule'];
  const bounded = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 200
      ? value
      : fallback;
  return {
    enabled: record['enabled'] !== false,
    maxFindings: bounded(max, 40),
    maxPerRule: bounded(perRule, 5),
  };
}

/** Never echo a credential-like value back in a diagnostic excerpt. */
function redactExcerpt(line: string): string {
  return (
    line
      // The prefix is optional: bare `SECRET=` / `TOKEN=` / `PASSWORD=` are the
      // exact lines env-contract-guard reports as exposed, and a mandatory
      // leading character echoed their values verbatim.
      .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s#]+)/gi, '$1=[REDACTED]')
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, '$1 [REDACTED]')
  );
}

/**
 * Longest stretch of evidence one regex call sees.
 *
 * The rules are written for readability, not linear time: two `.*` in a row
 * (`bundle.*budget.*exceeded`) backtrack O(n^3) on a line full of the first
 * two words and missing the third. Run over the whole 1 MB input, one crafted
 * line froze the host's event loop indefinitely — these tools are `auto`, and
 * the evidence can be a log file a repository ships (NV-2, security-check
 * 2026-09-26). Rules are matched line by line (`.` stops at `\n`); a longer
 * line is cut into windows so a single call is bounded by the window, not the
 * input. A rule written to span lines (`[\s\S]` or the `s` flag) is matched
 * over the whole input with the same windows — line by line it could never
 * fire on a pretty-printed manifest or a multi-line file list (F1115).
 */
export const EVIDENCE_MATCH_WINDOW = 1024;
/** How far a later window reaches back so a boundary-straddling match is seen whole. */
export const EVIDENCE_MATCH_OVERLAP = EVIDENCE_MATCH_WINDOW / 4;
/**
 * Wall-clock budget for one analysis, checked between regex calls. A single
 * call cannot be interrupted, but it is bounded by the window above, so the
 * whole analysis ends within the budget plus one window.
 */
export const EVIDENCE_ANALYZE_BUDGET_MS = 2000;

export function analyzeEvidence(
  content: string,
  profile: EvidenceAnalyzerProfile,
  maxFindings: number,
  now: () => number = Date.now,
  perRuleLimit = Number.POSITIVE_INFINITY,
): { findings: EvidenceFinding[]; partial: boolean; ruleCounts: Record<string, number> } {
  const findingLimit = nonnegativeFiniteLimit(maxFindings);
  const ruleCounts: Record<string, number> = {};
  if (findingLimit === 0) return { findings: [], partial: false, ruleCounts };
  const starts = [0];
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  const findings: EvidenceFinding[] = [];
  const deadline = now() + EVIDENCE_ANALYZE_BUDGET_MS;
  const lineAt = (index: number) => {
    const next = starts[index + 1];
    return content.slice(starts[index], next === undefined ? content.length : next - 1);
  };
  for (const rule of profile.rules) {
    // One chatty rule must not spend the whole finding budget before the
    // others run: past `perRuleLimit` its matches are only counted.
    let kept = 0;
    const matcher = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g');
    const spansLines =
      rule.pattern.flags.includes('s') || /\[\\s\\S\]|\[\\S\\s\]/.test(rule.pattern.source);
    for (let segment = 0; segment < (spansLines ? 1 : starts.length); segment++) {
      const line = spansLines ? content : lineAt(segment);
      // End offset (exclusive) of the last reported match on this line. A single
      // global matchAll never begins a match before the previous one ended, so
      // tracking this end reproduces single-pass semantics across overlapping
      // windows: it collapses a match re-found in the next window AND a
      // straddling match whose two alternation branches — one matched from each
      // window — would otherwise each be reported for one logical finding.
      let reportedEnd = 0;
      for (let offset = 0; offset === 0 || offset < line.length; offset += EVIDENCE_MATCH_WINDOW) {
        if (now() > deadline) return { findings, partial: true, ruleCounts };
        // The window reaches BACK by EVIDENCE_MATCH_OVERLAP (so a match that
        // starts in the previous window's tail is still seen whole — a one-char
        // overlap missed `ECONNRESET` split across offset 1024) and FORWARD by
        // the same overlap (so a match that starts inside this window and runs
        // past its right edge is contained here). With only the backward reach,
        // a match that began more than the overlap before a boundary AND ended
        // past it fit in no window at all and was silently dropped. Matching at
        // slice index 0 is dropped for later windows, where `^` (with the `m`
        // flag some rules use) would read a boundary as a line start.
        const from = offset === 0 ? 0 : Math.max(0, offset - EVIDENCE_MATCH_OVERLAP - 1);
        const window = line.slice(from, offset + EVIDENCE_MATCH_WINDOW + EVIDENCE_MATCH_OVERLAP);
        for (const match of window.matchAll(matcher)) {
          if (offset > 0 && match.index === 0) continue;
          const absStart = from + match.index;
          // Skip a match that begins inside an already-reported span: a single
          // global matchAll would never start there, so reporting it would
          // double-count one logical finding.
          if (absStart < reportedEnd) continue;
          reportedEnd = absStart + match[0].length;
          ruleCounts[rule.label] = (ruleCounts[rule.label] ?? 0) + 1;
          if (kept >= perRuleLimit) continue;
          kept += 1;
          const lineIndex = spansLines ? lineIndexOf(starts, absStart) : segment;
          findings.push({
            rule: rule.label,
            severity: rule.severity,
            line: lineIndex + 1,
            excerpt: safePrefix(redactExcerpt(lineAt(lineIndex).trim()), 240),
            advice: rule.advice,
          });
          if (findings.length >= findingLimit) return { findings, partial: false, ruleCounts };
        }
      }
    }
  }
  return { findings, partial: false, ruleCounts };
}

/** Index of the line containing `offset`, by binary search over line starts. */
function lineIndexOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

async function jevReview(
  api: PluginAPI,
  profile: EvidenceAnalyzerProfile,
  findings: EvidenceFinding[],
  signal: AbortSignal,
) {
  if (!api.jev) return { used: false, value: null, fallbackReason: 'unavailable' };
  const candidates = findings.slice(0, 3);
  const criteria: Record<string, string> = Object.fromEntries(
    candidates.map((finding, index) => [
      `finding_${index + 1}`,
      `Investigate ${finding.rule} at line ${finding.line}: ${finding.advice}`,
    ]),
  );
  criteria.defer = 'The supplied finding metadata is insufficient to prioritize a next check.';
  try {
    const result = await api.jev.judge(
      {
        state: {
          analyzer: profile.name,
          findings: candidates.map(({ rule, severity, line, advice }) => ({
            rule,
            severity,
            line,
            advice,
          })),
          limitation: 'Only supplied evidence was inspected. No project command was executed.',
        },
        questions: {
          priority: {
            type: 'choice',
            instructions:
              'Choose the next targeted check with the strongest justification from the supplied findings. Do not infer unseen evidence or change measured status.',
            criteria,
          },
        },
      },
      { signal, timeoutMs: 5000 },
    );
    signal.throwIfAborted();
    const answer = result.answers.priority;
    if (answer?.type !== 'choice' || !Object.hasOwn(criteria, answer.choice)) {
      return { used: false, value: null, fallbackReason: 'invalid-response' };
    }
    return {
      used: true,
      value: {
        choice: answer.choice,
        finding:
          answer.choice === 'defer'
            ? null
            : (candidates[Number(answer.choice.slice(8)) - 1] ?? null),
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        model: result.model ?? null,
      },
      fallbackReason: null,
    };
  } catch (error) {
    const unavailable =
      error instanceof Error && 'code' in error && error.code === 'JEV_UNAVAILABLE';
    return {
      used: false,
      value: null,
      fallbackReason: signal.aborted ? 'cancelled' : unavailable ? 'unavailable' : 'provider-error',
    };
  }
}

async function sourceFromInput(
  input: { path?: string; content?: string },
  root: string,
  signal: AbortSignal,
) {
  if (typeof input.content === 'string') {
    if (input.content.length > MAX_INPUT_CHARS) {
      throw new ToolValidationError({
        message: `content exceeds the ${MAX_INPUT_CHARS}-character evidence limit`,
        field: 'content',
      });
    }
    return { content: input.content, source: 'inline evidence' };
  }
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path) {
    throw new ToolValidationError({ message: 'path or content is required', field: 'path' });
  }
  const canonical = safePath(path, { projectRoot: root });
  if (!canonical) {
    throw new ToolValidationError({ message: 'path must be inside the project', field: 'path' });
  }
  const file = await open(canonical, 'r');
  let content: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_INPUT_CHARS * 4) {
      throw new ToolValidationError({
        message: 'Expected a regular evidence file within the size limit',
        field: 'path',
      });
    }
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > info.size)
      throw new Error('Evidence file grew during read; retry with stable inputs');
    content = buffer.subarray(0, total).toString('utf8');
  } finally {
    await file.close();
  }
  if (content.length > MAX_INPUT_CHARS) {
    throw new ToolValidationError({
      message: `file exceeds the ${MAX_INPUT_CHARS}-character evidence limit`,
      field: 'path',
    });
  }
  return { content, source: path };
}

interface GatheredFindings {
  findings: EvidenceFinding[];
  partial: boolean;
  ruleCounts: Record<string, number>;
  suppressed: number;
  source: string;
  evidenceChars?: number;
  inspected?: string[];
  facts?: Record<string, unknown>;
  limitation: string;
}

/** Findings from supplied evidence, or from the project when none is supplied. */
async function gatherFindings(
  profile: EvidenceAnalyzerProfile,
  input: { path?: string; content?: string },
  root: string,
  config: EvidenceAnalyzerConfig,
  signal: AbortSignal,
  options: Record<string, unknown>,
): Promise<GatheredFindings> {
  const noPath = typeof input.path !== 'string' || input.path.trim() === '';
  if (profile.project && noPath && typeof input.content !== 'string') {
    const collected = await profile.project.collect({ root, signal, options });
    signal.throwIfAborted();
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ordered = [...collected.findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
    const capped = capPerRule(ordered, config.maxPerRule);
    const kept = capped.findings.slice(0, config.maxFindings);
    return {
      findings: kept,
      partial: false,
      ruleCounts: capped.ruleCounts,
      suppressed: collected.findings.length - kept.length,
      source: 'project',
      inspected:
        collected.inspected.length > 12
          ? [...collected.inspected.slice(0, 10), `… and ${collected.inspected.length - 10} more`]
          : collected.inspected,
      ...(collected.facts ? { facts: collected.facts } : {}),
      limitation: collected.limitation,
    };
  }
  const evidence = await sourceFromInput(input, root, signal);
  signal.throwIfAborted();
  const content = profile.preprocess ? profile.preprocess(evidence.content) : evidence.content;
  const structural = profile.inspect ? profile.inspect(content) : [];
  const analysed = analyzeEvidence(
    content,
    profile,
    config.maxFindings,
    Date.now,
    config.maxPerRule,
  );
  const structuralCapped = capPerRule(structural, config.maxPerRule);
  const ruleCounts = { ...structuralCapped.ruleCounts, ...analysed.ruleCounts };
  const kept = [...structuralCapped.findings, ...analysed.findings].slice(0, config.maxFindings);
  const total = Object.values(ruleCounts).reduce((sum, count) => sum + count, 0);
  return {
    findings: kept,
    partial: analysed.partial,
    ruleCounts,
    suppressed: Math.max(0, total - kept.length),
    source: evidence.source,
    evidenceChars: evidence.content.length,
    limitation: analysed.partial
      ? `Only part of the supplied evidence was inspected (analysis stopped after ${EVIDENCE_ANALYZE_BUDGET_MS} ms); no project command was executed.`
      : 'Only the supplied evidence was inspected; no project command was executed.',
  };
}

/** Build a deterministic, evidence-first diagnostic plugin. */
export function createEvidenceAnalyzerPlugin(profile: EvidenceAnalyzerProfile): Plugin {
  const hosts = new Map<object, { state: EvidenceAnalyzerState; abort: AbortController }>();
  const defaults: EvidenceAnalyzerConfig = { enabled: true, maxFindings: 40, maxPerRule: 5 };
  return {
    name: profile.name,
    version: '0.1.0',
    description: profile.description,
    apiVersion: '^0.1.10',
    capabilities: { tools: true },
    defaultConfig: { ...defaults },
    configSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: true, description: 'Master switch.' },
        maxFindings: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          default: 40,
          description: 'Maximum reported findings per analysis.',
        },
        maxPerRule: {
          type: 'number',
          minimum: 1,
          maximum: 200,
          default: 5,
          description:
            'Maximum findings kept per rule; further matches are only counted in ruleCounts.',
        },
        ...profile.options,
      },
    },
    setup(api) {
      hosts.get(api)?.abort.abort();
      const state: EvidenceAnalyzerState = { analyses: 0, readErrors: 0, findings: 0 };
      const abort = new AbortController();
      hosts.set(api, { state, abort });
      api.tools.register({
        name: profile.toolName,
        description: profile.project
          ? `${profile.evidenceHint} With path or content, inspects only that evidence. With neither, inspects the project itself: ${profile.project.description} Never runs project scripts or writes files.`
          : `${profile.evidenceHint} Returns only evidence found in the supplied file or pasted content; it does not run commands.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: profile.project
                ? 'Project-relative file containing evidence to inspect. Omit together with content to inspect the project.'
                : 'Project-relative file containing evidence to inspect.',
            },
            content: {
              type: 'string',
              description: 'Pasted evidence, such as a CI log or manifest text.',
            },
            review: {
              type: 'string',
              enum: ['none', 'one-shot', 'council', 'jev'],
              description:
                'Optional model suggestions or a Jev next-check decision from finding metadata. Default none.',
            },
          },
        },
        permission: 'auto',
        category: 'Diagnostics',
        mutating: false,
        async execute(input: { path?: string; content?: string; review?: string }, ctx, opts) {
          const signal = AbortSignal.any([abort.signal, ...(opts?.signal ? [opts.signal] : [])]);
          signal.throwIfAborted();
          const config = readConfig(api.config.extensions?.[profile.name]);
          if (!config.enabled) throw new Error(`${profile.name} is disabled`);
          try {
            const root = resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd());
            const extensions = api.config.extensions?.[profile.name];
            const gathered = await gatherFindings(profile, input ?? {}, root, config, signal, {
              ...((extensions && typeof extensions === 'object' ? extensions : {}) as Record<
                string,
                unknown
              >),
            });
            const { findings, partial } = gathered;
            if (
              input.review !== undefined &&
              !['none', 'one-shot', 'council', 'jev'].includes(input.review)
            ) {
              throw new ToolValidationError({ message: 'Unknown review mode', field: 'review' });
            }
            const reviewRequested =
              input.review === 'one-shot' || input.review === 'council' || input.review === 'jev';
            const review =
              reviewRequested && findings.length > 0
                ? input.review === 'jev'
                  ? await jevReview(api, profile, findings, signal)
                  : await (input.review === 'council'
                      ? runOptionalPluginCouncil
                      : runOptionalPluginLlm)({
                      requested: true,
                      api,
                      label: `${profile.name}-review`,
                      prompt: `Review these deterministic ${profile.name} finding labels, severities, and line numbers. Evidence excerpts and raw content are deliberately omitted. Suggest only targeted next checks. Do not change finding counts, severity, or claim any check passed. Return JSON {"suggestions":["..."]}.\n${JSON.stringify(findings.map(({ rule, severity, line, advice }) => ({ rule, severity, line, advice }))).slice(0, 8000)}`,
                      options: {
                        responseFormat: 'json',
                        timeoutMs: 30000,
                        signal,
                        role: 'reviewer',
                      },
                      parse(text: string) {
                        const parsed = parseLlmJsonObject(text);
                        if (
                          !Array.isArray(parsed?.suggestions) ||
                          parsed.suggestions.length > 8 ||
                          !parsed.suggestions.every(
                            (item) => typeof item === 'string' && item.length <= 500,
                          )
                        )
                          return null;
                        return { suggestions: parsed.suggestions as string[] };
                      },
                      ...(input.review === 'council' ? { profile: 'risk-review' } : {}),
                    })
                : {
                    used: false,
                    value: null,
                    fallbackReason: reviewRequested ? 'no-findings' : 'not-requested',
                  };
            signal.throwIfAborted();
            state.analyses += 1;
            state.findings += findings.length;
            return {
              ok: true,
              plugin: profile.name,
              source: gathered.source,
              ...(gathered.evidenceChars !== undefined
                ? { evidenceChars: gathered.evidenceChars }
                : {}),
              ...(gathered.inspected ? { inspected: gathered.inspected } : {}),
              ...(gathered.facts ? { facts: gathered.facts } : {}),
              findings,
              ...(reviewRequested ? { review } : {}),
              summary: {
                errors: findings.filter((finding) => finding.severity === 'error').length,
                warnings: findings.filter((finding) => finding.severity === 'warning').length,
                info: findings.filter((finding) => finding.severity === 'info').length,
              },
              ...(gathered.suppressed > 0
                ? { ruleCounts: gathered.ruleCounts, suppressed: gathered.suppressed }
                : {}),
              ...(partial ? { partial: true } : {}),
              limitation: gathered.limitation,
            };
          } catch (error) {
            if (!signal.aborted) state.readErrors += 1;
            throw error;
          }
        },
      });
      api.log.info(`${profile.name} plugin loaded`, {
        enabled: readConfig(api.config.extensions?.[profile.name]).enabled,
      });
    },
    teardown(api) {
      const host = hosts.get(api);
      host?.abort.abort();
      const final = { ...host?.state };
      hosts.delete(api);
      api.log.info(`${profile.name}: teardown complete`, { final });
    },
    async health() {
      const state: EvidenceAnalyzerState = { analyses: 0, readErrors: 0, findings: 0 };
      for (const host of hosts.values()) {
        state.analyses += host.state.analyses;
        state.readErrors += host.state.readErrors;
        state.findings += host.state.findings;
      }
      return {
        ok: state.readErrors === 0,
        message: `${profile.name}: ${state.analyses} evidence input(s), ${state.findings} finding(s), ${state.readErrors} read error(s)`,
        counters: { ...state },
      };
    },
  };
}
