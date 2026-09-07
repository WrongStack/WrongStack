/**
 * Host-side implementation of the codebase index's {@link SummarizerPort}.
 *
 * `packages/tools` defines what a summariser must answer; producing that answer
 * needs a configured provider and the model-tier policy, both of which live
 * here. The port is therefore injected rather than imported, the same way SAGE
 * takes `getLlmCall` — a host that supplies nothing simply gets no concept
 * layer, and the index carries on working without one.
 *
 * ## Cost shape
 *
 * One call per file, and only for files whose bytes changed since the last
 * pass. Enrichment is the one part of the index that spends money, so the model
 * is resolved through the tier layer at its cheapest configured level unless
 * the caller pins one, and both the token ceiling and the timeout are small.
 */

import { OneShotOrchestrator } from '@wrongstack/core/execution';
import type { Config } from '@wrongstack/core/types';
import type {
  SummarizeFileInput,
  SummarizeFileResult,
  SummarizerPort,
  SummarizeSubsystemInput,
  SummarizeSubsystemResult,
} from '@wrongstack/tools';
import { CONCEPT_RELATIONS, MAX_CRUX_LINES } from '@wrongstack/tools';

/** Output ceiling. A file summary that needs more than this is not a summary. */
const FILE_MAX_TOKENS = 400;
const SUBSYSTEM_MAX_TOKENS = 500;

/** Per-call timeout. A slow file is skipped, not waited on. */
const CALL_TIMEOUT_MS = 45_000;

const FILE_SYSTEM_PROMPT = [
  'You describe one source file for a code search index.',
  '',
  'Answer with JSON only: {"summary": string, "cruxStart": number, "cruxEnd": number}.',
  '',
  '- `summary`: one or two sentences on what this file is FOR — the job it does in the',
  '  system, in plain English. Do not list its exports; the index already has those.',
  '  Prefer the domain vocabulary the code itself uses. Never speculate about code you',
  '  were not shown.',
  `- \`cruxStart\`/\`cruxEnd\`: the 1-based, inclusive line span of the few lines that`,
  `  actually carry the file's meaning — the core decision, the central type, the loop`,
  `  everything else serves. At most ${MAX_CRUX_LINES} lines. Omit both if nothing stands out.`,
].join('\n');

const SUBSYSTEM_SYSTEM_PROMPT = [
  'You describe one subsystem of a codebase, given summaries of its most central files.',
  '',
  'Answer with JSON only:',
  '{"summary": string, "relations": [{"to": string, "relation": string}]}',
  '',
  '- `summary`: two or three sentences on what this subsystem is responsible for.',
  `- \`relations\`: how it relates to OTHER named subsystems, using only these verbs:`,
  `  ${CONCEPT_RELATIONS.join(', ')}. Omit the field entirely if you are not confident.`,
  '  Never invent a subsystem name that was not given to you.',
].join('\n');

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose and fences often enough that requiring a clean
 * response would throw away usable answers. A response that yields nothing
 * parseable returns null and the file is simply left unsummarised.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Number the source so the model can point at a line span it can actually see. */
function numberLines(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${index + 1}\t${line}`)
    .join('\n');
}

type OrchestratorOptions = ConstructorParameters<typeof OneShotOrchestrator>[0];

export interface ConceptSummarizerDeps {
  buildProvider: OrchestratorOptions['buildProvider'];
  getConfig: () => Config;
  fallbackProfileManager: OrchestratorOptions['fallbackProfileManager'];
  statusTracker?: OrchestratorOptions['statusTracker'];
  wrapProviderCall?: OrchestratorOptions['wrapProviderCall'];
  /** Explicit model override; otherwise the configured budget tier decides. */
  model?: string | undefined;
}

export function createConceptSummarizer(deps: ConceptSummarizerDeps): SummarizerPort {
  const orchestrator = new OneShotOrchestrator({
    buildProvider: deps.buildProvider,
    getConfig: deps.getConfig,
    fallbackProfileManager: deps.fallbackProfileManager,
    ...(deps.statusTracker ? { statusTracker: deps.statusTracker } : {}),
    ...(deps.wrapProviderCall ? { wrapProviderCall: deps.wrapProviderCall } : {}),
  });

  const model = deps.model ?? deps.getConfig().indexing?.concepts?.model;

  return {
    async describeFile(input: SummarizeFileInput): Promise<SummarizeFileResult | null> {
      const userPrompt = [
        `File: ${input.file}`,
        input.declarations.length > 0
          ? `Indexed declarations: ${input.declarations
              .map((d) => `${d.name} (${d.kind}, L${d.line})`)
              .join(', ')}`
          : '',
        input.staleSummary !== undefined
          ? `A previous description of an older version of this file — verify it against the source rather than trusting it: ${input.staleSummary}`
          : '',
        input.truncated ? '(source truncated)' : '',
        '',
        numberLines(input.source),
      ]
        .filter(Boolean)
        .join('\n');

      const result = await orchestrator.call({
        system: FILE_SYSTEM_PROMPT,
        userPrompt,
        responseFormat: { type: 'json_object' },
        maxTokens: FILE_MAX_TOKENS,
        timeoutMs: CALL_TIMEOUT_MS,
        ...(model ? { model } : { role: 'summarizer' }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      // OneShotOrchestrator never throws; a failure arrives as `error`.
      if (result.error || !result.text) return null;

      const parsed = parseJsonObject(result.text);
      if (parsed === null) return null;
      const summary = asString(parsed['summary']);
      if (summary === '') return null;

      return {
        summary,
        cruxStart: asLine(parsed['cruxStart']),
        cruxEnd: asLine(parsed['cruxEnd']),
        model: result.model,
      };
    },

    async describeSubsystem(
      input: SummarizeSubsystemInput,
    ): Promise<SummarizeSubsystemResult | null> {
      if (input.files.length === 0) return null;
      const userPrompt = [
        `Subsystem: ${input.name}`,
        '',
        'Its most central files, with what each is for:',
        ...input.files.map((f) => `- ${f.file}: ${f.summary}`),
      ].join('\n');

      const result = await orchestrator.call({
        system: SUBSYSTEM_SYSTEM_PROMPT,
        userPrompt,
        responseFormat: { type: 'json_object' },
        maxTokens: SUBSYSTEM_MAX_TOKENS,
        timeoutMs: CALL_TIMEOUT_MS,
        ...(model ? { model } : { role: 'summarizer' }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.error || !result.text) return null;

      const parsed = parseJsonObject(result.text);
      if (parsed === null) return null;
      const summary = asString(parsed['summary']);
      if (summary === '') return null;

      const rawRelations = parsed['relations'];
      const relations = Array.isArray(rawRelations)
        ? rawRelations.flatMap((entry) => {
            if (entry === null || typeof entry !== 'object') return [];
            const record = entry as Record<string, unknown>;
            const to = asString(record['to']);
            const relation = asString(record['relation']);
            return to !== '' && relation !== '' ? [{ to, relation }] : [];
          })
        : [];

      return { summary, relations, model: result.model };
    },
  };
}
