/**
 * Shared implementation for the focused evidence analyzers.
 *
 * These plugins intentionally analyse an explicit file or pasted command/CI
 * output. They never execute a project command, mutate a file, or quietly
 * claim that a broad check passed without the caller supplying evidence.
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
}

interface EvidenceAnalyzerConfig {
  enabled: boolean;
  maxFindings: number;
}

interface EvidenceAnalyzerState {
  analyses: number;
  readErrors: number;
  findings: number;
}

function readConfig(raw: unknown): EvidenceAnalyzerConfig {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const max = record['maxFindings'] ?? record['max_findings'];
  return {
    enabled: record['enabled'] !== false,
    maxFindings:
      typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= 200 ? max : 40,
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
 * 2026-09-26). No rule can span a newline (none uses the `s` flag, and `.`
 * stops at `\n`), so matching line by line loses nothing; a longer line is cut
 * into windows so a single call is bounded by the window, not the input.
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

interface EvidenceFinding {
  rule: string;
  severity: EvidenceRule['severity'];
  line: number;
  excerpt: string;
  advice: string;
}

export function analyzeEvidence(
  content: string,
  profile: EvidenceAnalyzerProfile,
  maxFindings: number,
  now: () => number = Date.now,
): { findings: EvidenceFinding[]; partial: boolean } {
  const starts = [0];
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  const findings: EvidenceFinding[] = [];
  const deadline = now() + EVIDENCE_ANALYZE_BUDGET_MS;
  for (const rule of profile.rules) {
    const matcher = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '') + 'g');
    for (let lineIndex = 0; lineIndex < starts.length; lineIndex++) {
      const next = starts[lineIndex + 1];
      const line = content.slice(starts[lineIndex], next === undefined ? content.length : next - 1);
      // End offset (exclusive) of the last reported match on this line. A single
      // global matchAll never begins a match before the previous one ended, so
      // tracking this end reproduces single-pass semantics across overlapping
      // windows: it collapses a match re-found in the next window AND a
      // straddling match whose two alternation branches — one matched from each
      // window — would otherwise each be reported for one logical finding.
      let reportedEnd = 0;
      for (let offset = 0; offset === 0 || offset < line.length; offset += EVIDENCE_MATCH_WINDOW) {
        if (now() > deadline) return { findings, partial: true };
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
          findings.push({
            rule: rule.label,
            severity: rule.severity,
            line: lineIndex + 1,
            excerpt: redactExcerpt(line.trim()).slice(0, 240),
            advice: rule.advice,
          });
          if (findings.length >= maxFindings) return { findings, partial: false };
        }
      }
    }
  }
  return { findings, partial: false };
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

/** Build a deterministic, evidence-first diagnostic plugin. */
export function createEvidenceAnalyzerPlugin(profile: EvidenceAnalyzerProfile): Plugin {
  const hosts = new Map<object, { state: EvidenceAnalyzerState; abort: AbortController }>();
  const defaults: EvidenceAnalyzerConfig = { enabled: true, maxFindings: 40 };
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
      },
    },
    setup(api) {
      hosts.get(api)?.abort.abort();
      const state: EvidenceAnalyzerState = { analyses: 0, readErrors: 0, findings: 0 };
      const abort = new AbortController();
      hosts.set(api, { state, abort });
      api.tools.register({
        name: profile.toolName,
        description: `${profile.evidenceHint} Returns only evidence found in the supplied file or pasted content; it does not run commands.`,
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Project-relative file containing evidence to inspect.',
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
            const evidence = await sourceFromInput(
              input ?? {},
              resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd()),
              signal,
            );
            signal.throwIfAborted();
            const { findings, partial } = analyzeEvidence(
              evidence.content,
              profile,
              config.maxFindings,
            );
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
              source: evidence.source,
              evidenceChars: evidence.content.length,
              findings,
              ...(reviewRequested ? { review } : {}),
              summary: {
                errors: findings.filter((finding) => finding.severity === 'error').length,
                warnings: findings.filter((finding) => finding.severity === 'warning').length,
                info: findings.filter((finding) => finding.severity === 'info').length,
              },
              ...(partial ? { partial: true } : {}),
              limitation: partial
                ? `Only part of the supplied evidence was inspected (analysis stopped after ${EVIDENCE_ANALYZE_BUDGET_MS} ms); no project command was executed.`
                : 'Only the supplied evidence was inspected; no project command was executed.',
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
