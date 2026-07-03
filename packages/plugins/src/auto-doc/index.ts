/**
 * auto-doc plugin — Auto-generates JSDoc/TSDoc comments for source files.
 *
 * Tools registered:
 * - auto_doc: Generate and inject doc comments into JS/TS files.
 *   Pass `dry_run: true` to preview without writing (replaces the former
 *   `auto_doc (dry_run)` tool).
 *
 * LLM mode (opt-in): with `config.extensions['auto-doc'].useLlm = true`
 * (or per-call `use_llm: true`) and a host that wires `api.llm`, each
 * doc comment's prose is written by the LLM from the entity's signature
 * and body instead of the `TODO: describe …` placeholder. Provider/model
 * follow the plugin's `config.extensions['auto-doc'].llm` override, then
 * the session default. Best-effort: any LLM failure (or a bad response)
 * falls back to the template for that entity — a doc comment always lands.
 */
import type { Plugin, PluginAPI } from '@wrongstack/core';

const AUTO_DOC_API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern: shared between setup, teardown,
// health). auto-doc is fundamentally stateless — the actual work happens
// in `runAutoDoc` per call. We track per-session invocation counts so
// /diag plugins can report "how many docstrings this session generated".
// Setup is idempotent: re-init zeros the counter; teardown leaves the
// counter at zero.
// ---------------------------------------------------------------------------
const state = {
  invocationCount: 0,
  /** Doc comments whose prose came from the LLM this session. */
  llmDocs: 0,
  /** LLM calls that failed and fell back to the template. */
  llmFallbacks: 0,
  /** Last invocation summary — surfaced by health() for /diag plugins. */
  lastInvocation: null as null | {
    when: string;
    files: number;
    style: 'jsdoc' | 'tsdoc';
    dryRun: boolean;
  },
};

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface AutoDocInput {
  files: string[];
  style?: 'jsdoc' | 'tsdoc' | undefined;
  force?: boolean | undefined;
  dry_run?: boolean | undefined;
  /** Per-call override for the `useLlm` config flag. */
  use_llm?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Doc generation helpers
// ---------------------------------------------------------------------------

type ParsedEntity =
  | {
      kind: 'function';
      name: string;
      startLine: number;
      params: string[];
      returnType?: string | undefined;
    }
  | { kind: 'class'; name: string; startLine: number }
  | { kind: 'type'; name: string; startLine: number }
  | { kind: 'interface'; name: string; startLine: number };

function parseSource(content: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  const lines = content.split('\n');
  const reFunction =
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\((.*?)\)(?:\s*:\s*(.+?))?\s*\{/;
  const reArrowFn =
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\((.*?)\)\s*(?::\s*(.+?))?\s*=>/;
  const reClass = /^(?:export\s+)?class\s+(\w+)/;
  const reType = /^(?:export\s+)?type\s+(\w+)\s*=\s*\{/;
  const reInterface = /^(?:export\s+)?interface\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let m = line.match(reFunction);
    if (m?.[1]) {
      entities.push({
        kind: 'function',
        name: m[1],
        startLine: i + 1,
        params: m[2]
          ? m[2]
              .split(',')
              .map((p) => p.trim().split(':')[0]?.trim())
              .filter((p): p is string => Boolean(p))
          : [],
        returnType: m[3]?.trim(),
      });
      continue;
    }

    m = line.match(reArrowFn);
    if (m?.[1]) {
      entities.push({
        kind: 'function',
        name: m[1],
        startLine: i + 1,
        params: m[2]
          ? m[2]
              .split(',')
              .map((p) => p.trim().split(':')[0]?.trim())
              .filter((p): p is string => Boolean(p))
          : [],
        returnType: m[3]?.trim(),
      });
      continue;
    }

    m = line.match(reClass);
    if (m?.[1]) {
      entities.push({ kind: 'class', name: m[1], startLine: i + 1 });
      continue;
    }

    m = line.match(reType);
    if (m?.[1]) {
      entities.push({ kind: 'type', name: m[1], startLine: i + 1 });
      continue;
    }

    m = line.match(reInterface);
    if (m?.[1]) {
      entities.push({ kind: 'interface', name: m[1], startLine: i + 1 });
    }
  }

  return entities;
}

function generateDocComment(entity: ParsedEntity, includeTypes: boolean): string {
  // JSDoc and TSDoc share the same @param/@returns syntax for the entity
  // types this plugin supports (function, class, type, interface). When
  // TSDoc-specific tags (@typeParam, @remarks) are needed, extend here.
  switch (entity.kind) {
    case 'function': {
      const params = entity.params
        .map((p) => `   * @param ${p} - TODO: describe parameter`)
        .join('\n');
      const returns = entity.returnType
        ? `\n   * @returns ${includeTypes ? `{${entity.returnType}} ` : ''}TODO: describe return value`
        : '';
      return `/**\n   * TODO: One-line description of ${entity.name}\n${params}${returns}\n   */`;
    }
    case 'class':
      return `/**\n   * TODO: Describe class ${entity.name}\n   */`;
    case 'type':
      return `/**\n   * TODO: Describe type ${entity.name}\n   */`;
    case 'interface':
      return `/**\n   * TODO: Describe interface ${entity.name}\n   */`;
  }
}

/** Grab the entity's declaration plus a few body lines as LLM context. */
function entitySnippet(content: string, entity: ParsedEntity, maxLines = 25): string {
  const lines = content.split('\n');
  const start = entity.startLine - 1;
  return lines.slice(start, start + maxLines).join('\n');
}

/**
 * Build a doc comment whose prose comes from the LLM. Returns null on
 * any failure so the caller falls back to the template. The LLM is
 * asked for a small JSON object; we render the comment ourselves so the
 * @param/@returns structure stays consistent regardless of the model.
 */
async function generateDocCommentLlm(
  entity: ParsedEntity,
  snippet: string,
  includeTypes: boolean,
  api: PluginAPI,
): Promise<string | null> {
  if (!api.llm) return null;
  const paramList = entity.kind === 'function' ? entity.params : [];
  try {
    const result = await api.llm.complete(
      `Write documentation for this ${entity.kind} named "${entity.name}". ` +
        'Respond with ONLY a JSON object of the form ' +
        '{"summary": string, "params": {"<name>": string}, "returns": string}. ' +
        'summary is one concise sentence. params has one entry per parameter' +
        (paramList.length > 0 ? ` (${paramList.join(', ')})` : ' (may be empty)') +
        '. returns describes the return value (empty string if none). No prose outside the JSON.\n\n' +
        '```\n' +
        snippet +
        '\n```',
      {
        system: 'You are a precise API documentation writer. Output only JSON.',
        maxTokens: 400,
        responseFormat: 'json',
      },
    );
    const parsed = JSON.parse(extractJsonObject(result.text)) as {
      summary?: unknown;
      params?: Record<string, unknown>;
      returns?: unknown;
    };
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : `Describe ${entity.name}`;
    if (entity.kind !== 'function') {
      return `/**\n   * ${summary}\n   */`;
    }
    const paramLines = paramList.map((p) => {
      const desc =
        parsed.params && typeof parsed.params[p] === 'string' && (parsed.params[p] as string).trim()
          ? (parsed.params[p] as string).trim()
          : 'parameter';
      return `   * @param ${p} - ${desc}`;
    });
    const returnsDesc =
      typeof parsed.returns === 'string' && parsed.returns.trim() ? parsed.returns.trim() : '';
    const returnsLine =
      entity.returnType && returnsDesc
        ? `\n   * @returns ${includeTypes ? `{${entity.returnType}} ` : ''}${returnsDesc}`
        : entity.returnType
          ? `\n   * @returns ${includeTypes ? `{${entity.returnType}} ` : ''}return value`
          : '';
    const paramBlock = paramLines.length > 0 ? `\n${paramLines.join('\n')}` : '';
    return `/**\n   * ${summary}${paramBlock}${returnsLine}\n   */`;
  } catch {
    return null;
  }
}

/** Pull the first {...} JSON object out of a possibly-fenced response. */
function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

function needsDocComment(content: string, entity: ParsedEntity): boolean {
  const lines = content.split('\n');
  const lineIdx = entity.startLine - 1;
  if (lineIdx < 1) return true;
  /* v8 ignore next -- lineIdx >= 1 here, so lines[lineIdx - 1] is always defined; the ?? '' is defensive. */
  const prevLine = lines[lineIdx - 1] ?? '';
  return !/^\s*\/\*\*\s*$/.test(prevLine.trim());
}

function injectDocComment(content: string, entity: ParsedEntity, doc: string): string {
  const lines = content.split('\n');
  const idx = entity.startLine - 1;
  /* v8 ignore next -- idx is a valid line index for a parsed entity; the ?? '' fallback is defensive. */
  const codeLine = lines[idx] ?? '';
  /* v8 ignore next -- /^(\s*)/ always matches; the ?.[1] ?? '' fallback is defensive. */
  const indent = codeLine.match(/^(\s*)/)?.[1] ?? '';
  lines.splice(idx, 0, `${indent}${doc}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function runAutoDoc(input: AutoDocInput, api: Parameters<Plugin['setup']>[0]) {
  if (!input.files || typeof input.files !== 'object' || !Array.isArray(input.files)) {
    return {
      ok: false,
      error: 'input.files must be an array of file paths',
      filesProcessed: 0,
      changes: [],
    };
  }
  if (input.files.length === 0) {
    return {
      ok: false,
      error: 'input.files is empty — provide at least one file path',
      filesProcessed: 0,
      changes: [],
    };
  }
  const extConfig = (api.config.extensions?.['auto-doc'] as Record<string, unknown>) ?? {};
  const includeTypes = (extConfig['includeTypes'] as boolean) ?? false;
  // LLM prose is opt-in: per-call `use_llm` overrides the config flag.
  const useLlm =
    (input.use_llm ?? (extConfig['useLlm'] as boolean | undefined) ?? false) === true &&
    Boolean(api.llm);
  // Bound how many LLM calls one invocation makes so a huge file can't
  // trigger hundreds of completions; entities beyond the cap use the template.
  const maxLlmEntities =
    typeof extConfig['maxLlmEntities'] === 'number' && extConfig['maxLlmEntities'] >= 0
      ? (extConfig['maxLlmEntities'] as number)
      : 25;
  const results: Array<{ file: string; entity: string; source: 'llm' | 'template' }> = [];
  let llmBudget = maxLlmEntities;

  for (const file of input.files) {
    try {
      const { readFileSync, writeFileSync } = await import('node:fs');
      let content: string;
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        api.log.warn(`auto-doc: could not read file ${file}`);
        continue;
      }

      const entities = parseSource(content);
      let modified = content;

      for (const entity of entities) {
        if (!input.force && !needsDocComment(modified, entity)) continue;

        let doc: string | null = null;
        let source: 'llm' | 'template' = 'template';
        if (useLlm && llmBudget > 0) {
          llmBudget -= 1;
          doc = await generateDocCommentLlm(
            entity,
            entitySnippet(modified, entity),
            includeTypes,
            api,
          );
          if (doc) {
            source = 'llm';
            state.llmDocs += 1;
            api.metrics.counter('llm_docs');
          } else {
            state.llmFallbacks += 1;
            api.metrics.counter('llm_fallbacks');
          }
        }
        if (!doc) doc = generateDocComment(entity, includeTypes);

        modified = injectDocComment(modified, entity, doc);
        results.push({ file, entity: entity.name, source });
      }

      if (!input.dry_run && results.length > 0) {
        writeFileSync(file, modified, 'utf-8');
        api.log.info(`auto-doc: updated ${file}`);
      }
    } catch (err) {
      api.log.error(`auto-doc: error processing ${file}: ${err}`);
    }
  }

  return {
    ok: true,
    filesProcessed: input.files.length,
    changes: results,
    llm: useLlm ? { docs: state.llmDocs, fallbacks: state.llmFallbacks } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'auto-doc',
  version: '0.2.0',
  description: 'Auto-generates JSDoc/TSDoc comments for functions, classes, types, and interfaces',
  apiVersion: AUTO_DOC_API_VERSION,
  capabilities: { tools: true, pipelines: ['toolCall'] },
  defaultConfig: {
    style: 'tsdoc',
    includeTypes: false,
    dryRun: false,
    useLlm: false,
    maxLlmEntities: 25,
  },
  configSchema: {
    type: 'object',
    properties: {
      style: { type: 'string', enum: ['jsdoc', 'tsdoc'], default: 'tsdoc' },
      includeTypes: { type: 'boolean', default: false },
      dryRun: { type: 'boolean', default: false },
      useLlm: {
        type: 'boolean',
        default: false,
        description:
          'Write doc prose with the LLM (api.llm) instead of TODO placeholders. Provider/model follow extensions["auto-doc"].llm, then the session default.',
      },
      maxLlmEntities: {
        type: 'number',
        minimum: 0,
        default: 25,
        description:
          'Cap on LLM-written doc comments per invocation; entities beyond it use the template.',
      },
      llm: {
        type: 'object',
        description: 'Optional { provider, model } override for LLM doc prose.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern): zero counters on reload.
    state.invocationCount = 0;
    state.llmDocs = 0;
    state.llmFallbacks = 0;
    state.lastInvocation = null;

    api.tools.register({
      name: 'auto_doc',
      description:
        'Auto-generate JSDoc/TSDoc comments for functions, classes, types, and interfaces in source files. Set `dry_run: true` to preview without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Source files to document',
          },
          style: {
            type: 'string',
            enum: ['jsdoc', 'tsdoc'],
            default: 'tsdoc',
            description: 'Comment style',
          },
          force: { type: 'boolean', default: false, description: 'Overwrite existing docstrings' },
          dry_run: {
            type: 'boolean',
            default: false,
            description: 'Preview generated comments without writing to files',
          },
          use_llm: {
            type: 'boolean',
            description:
              'Write doc prose with the LLM (api.llm) instead of TODO placeholders. Overrides the useLlm config flag for this call.',
          },
        },
        required: ['files'],
      },
      permission: 'auto',
      mutating: true,
      category: 'Project',
      async execute(input: Record<string, unknown>) {
        // Bump the per-session counter on every invocation — before the
        // call, so failed invocations still count. The health() snapshot
        // below is updated on success so /diag can answer "what was the
        // last auto_doc call this session?"
        const inp = input as never as AutoDocInput;
        state.invocationCount += 1;
        const result = await runAutoDoc(inp, api);
        state.lastInvocation = {
          when: new Date().toISOString(),
          files: Array.isArray(inp.files) ? inp.files.length : 0,
          style: inp.style === 'jsdoc' ? 'jsdoc' : 'tsdoc',
          dryRun: inp.dry_run === true,
        };
        return result;
      },
    });

    api.log.info('auto-doc plugin loaded', { version: '0.2.0', capabilities: ['auto_doc'] });
  },

  teardown(api) {
    // H1 pattern: zero counters on unload. auto-doc has no file
    // handles or timers to release — the existing log is preserved
    // plus a final invocation count so operators can see how many
    // docstrings the session generated.
    const finalCount = state.invocationCount;
    const finalLlmDocs = state.llmDocs;
    state.invocationCount = 0;
    state.llmDocs = 0;
    state.llmFallbacks = 0;
    state.lastInvocation = null;
    api.log.info('auto-doc: teardown complete', { invocations: finalCount, llmDocs: finalLlmDocs });
  },

  async health() {
    // /diag plugins — surface a one-line status plus per-session
    // counters so an operator can confirm the plugin is wired and
    // see how heavily it's been used. No resources to track (the
    // tool is a per-call pure function).
    return {
      ok: true,
      message:
        state.lastInvocation === null
          ? `auto-doc: ${state.invocationCount} invocation(s) this session`
          : `auto-doc: last run ${state.lastInvocation.files} file(s) at ${state.lastInvocation.when} (${state.lastInvocation.dryRun ? 'dry-run' : 'write'}); ${state.llmDocs} LLM doc(s), ${state.llmFallbacks} fallback(s)`,
      invocationCount: state.invocationCount,
      llmDocs: state.llmDocs,
      llmFallbacks: state.llmFallbacks,
      lastInvocation: state.lastInvocation,
    };
  },
};

export default plugin;
