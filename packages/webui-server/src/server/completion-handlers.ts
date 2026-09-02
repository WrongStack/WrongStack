/**
 * Context-aware editor completion for the WebUI Monaco surface.
 *
 * The handler combines fast symbol-index hits with a short, JSON-only LLM call.
 * It is intentionally side-effect free: it never writes files and only reads the
 * existing codebase index when available.
 */

import * as path from 'node:path';
import type { WebSocket } from 'ws';
import type { Context } from '@wrongstack/core/agent';
import type { Provider, Request, Tool } from '@wrongstack/core/types';
import { searchCodebaseIndex, type SearchResult } from '@wrongstack/tools/codebase-index/index';
import { send, errMessage } from './ws-utils.js';

export type CompletionItemKind =
  | 'text'
  | 'method'
  | 'function'
  | 'constructor'
  | 'field'
  | 'variable'
  | 'class'
  | 'interface'
  | 'module'
  | 'property'
  | 'unit'
  | 'value'
  | 'enum'
  | 'keyword'
  | 'snippet'
  | 'file'
  | 'reference';

export interface CompletionSuggestion {
  label: string;
  insertText: string;
  kind?: CompletionItemKind | undefined;
  detail?: string | undefined;
  documentation?: string | undefined;
  sortText?: string | undefined;
  source?: 'llm' | 'index' | 'lsp' | undefined;
}

interface CompletionRequestPayload {
  requestId: string;
  filePath: string;
  language: string;
  lineNumber: number;
  column: number;
  content?: string | undefined;
  prefix: string;
  suffix?: string | undefined;
  triggerCharacter?: string | undefined;
  triggerKind?: number | undefined;
  allowLlm?: boolean | undefined;
}

export interface CompletionHandlerOptions {
  projectRoot: string;
  provider?: Provider | undefined;
  model?: string | undefined;
  indexDir?: string | undefined;
  lspCompletion?: LspCompletionSource | undefined;
  timeoutMs?: number | undefined;
}

export interface LspCompletionSourceRequest {
  filePath: string;
  lineNumber: number;
  column: number;
  content?: string | undefined;
  triggerCharacter?: string | undefined;
  signal: AbortSignal;
}

export type LspCompletionSource = (
  request: LspCompletionSourceRequest,
) => Promise<CompletionSuggestion[]>;

const MAX_PREFIX_CHARS = 12_000;
const MAX_SUFFIX_CHARS = 4_000;
const MAX_CONTENT_CHARS = 500_000;
const INDEX_LIMIT = 8;
const LLM_LIMIT = 8;
const DEFAULT_TIMEOUT_MS = 4_500;

const COMPLETION_SYSTEM_PROMPT = [
  'You are a code completion engine for an IDE.',
  'Return only JSON. No markdown, prose, or code fences.',
  'Suggest context-aware completions that fit the cursor location.',
  'Prefer project-local names, repository conventions, and type-safe APIs.',
  'Do not invent large code blocks; keep insertText small and directly insertable.',
].join('\n');

const COMPLETION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: LLM_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          insertText: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'text',
              'method',
              'function',
              'constructor',
              'field',
              'variable',
              'class',
              'interface',
              'module',
              'property',
              'unit',
              'value',
              'enum',
              'keyword',
              'snippet',
              'file',
              'reference',
            ],
          },
          detail: { type: 'string' },
          documentation: { type: 'string' },
          sortText: { type: 'string' },
        },
        required: ['label', 'insertText'],
      },
    },
  },
  required: ['items'],
};

export async function handleCompletionRequest(
  ws: WebSocket,
  msg: unknown,
  opts: CompletionHandlerOptions,
): Promise<void> {
  const parsed = parsePayload(msg);
  if (!parsed.ok) {
    send(ws, {
      type: 'completion.result',
      payload: {
        requestId: parsed.requestId ?? '',
        filePath: parsed.filePath ?? '',
        items: [],
        error: parsed.error,
      },
    });
    return;
  }

  const payload = parsed.payload;
  const projectRoot = path.resolve(opts.projectRoot);
  const resolved = path.resolve(projectRoot, payload.filePath);
  if (!isInside(projectRoot, resolved)) {
    send(ws, {
      type: 'completion.result',
      payload: {
        requestId: payload.requestId,
        filePath: payload.filePath,
        items: [],
        error: 'Forbidden',
      },
    });
    return;
  }

  const prefix = tail(payload.prefix, MAX_PREFIX_CHARS);
  const suffix = head(payload.suffix ?? '', MAX_SUFFIX_CHARS);
  const linePrefix = currentLinePrefix(prefix);
  const query = buildSearchQuery(linePrefix, payload.filePath);

  const [lspItems, indexItems] = await Promise.all([
    loadLspSuggestions(opts.lspCompletion, payload, resolved).catch(
      () => [] as CompletionSuggestion[],
    ),
    loadIndexSuggestions({
      projectRoot,
      indexDir: opts.indexDir,
      query,
    }).catch(() => [] as CompletionSuggestion[]),
  ]);

  const llmResult = shouldUseLlm(payload, linePrefix, query)
    ? await loadLlmSuggestions({
        provider: opts.provider,
        model: opts.model,
        payload,
        prefix,
        suffix,
        linePrefix,
        query,
        relatedSymbols: indexItems,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }).catch((err) => ({ error: errMessage(err), items: [] as CompletionSuggestion[] }))
    : ([] as CompletionSuggestion[]);

  const llmItems = Array.isArray(llmResult) ? llmResult : llmResult.items;
  const error = Array.isArray(llmResult) ? undefined : llmResult.error;
  const items = mergeSuggestions([...lspItems, ...llmItems, ...indexItems]).slice(
    0,
    LLM_LIMIT + INDEX_LIMIT,
  );

  send(ws, {
    type: 'completion.result',
    payload: {
      requestId: payload.requestId,
      filePath: payload.filePath,
      items,
      error: items.length === 0 ? error : undefined,
    },
  });
}

export function createToolLspCompletionSource(
  tool: Tool | undefined,
  ctx: Context,
): LspCompletionSource | undefined {
  if (!tool) return undefined;
  return async (request) => {
    const output = await tool.execute(
      {
        path: request.filePath,
        line: request.lineNumber,
        character: request.column,
        content: request.content,
        limit: 8,
        trigger_character: request.triggerCharacter,
        format: 'json',
      },
      ctx,
      { signal: request.signal },
    );
    return parseLspToolOutput(String(output));
  };
}

function parsePayload(
  msg: unknown,
):
  | { ok: true; payload: CompletionRequestPayload }
  | { ok: false; error: string; requestId?: string | undefined; filePath?: string | undefined } {
  const payload = (msg as { payload?: Partial<CompletionRequestPayload> | undefined }).payload;
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : undefined;
  const filePath = typeof payload?.filePath === 'string' ? payload.filePath : undefined;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'Missing payload' };
  }
  if (!requestId) {
    return { ok: false, error: 'Missing requestId', filePath };
  }
  if (!filePath) {
    return { ok: false, error: 'Missing filePath', requestId };
  }
  if (typeof payload.language !== 'string') {
    return { ok: false, error: 'Missing language', requestId, filePath };
  }
  if (typeof payload.prefix !== 'string') {
    return { ok: false, error: 'Missing prefix', requestId, filePath };
  }
  if (!isValidPositionValue(payload.lineNumber) || !isValidPositionValue(payload.column)) {
    return { ok: false, error: 'Invalid cursor position', requestId, filePath };
  }
  const content =
    typeof payload.content === 'string' && payload.content.length <= MAX_CONTENT_CHARS
      ? payload.content
      : undefined;
  return {
    ok: true,
    payload: {
      requestId,
      filePath,
      language: payload.language,
      lineNumber: payload.lineNumber,
      column: payload.column,
      content,
      prefix: payload.prefix,
      suffix: typeof payload.suffix === 'string' ? payload.suffix : undefined,
      triggerCharacter:
        typeof payload.triggerCharacter === 'string' ? payload.triggerCharacter : undefined,
      triggerKind: typeof payload.triggerKind === 'number' ? payload.triggerKind : undefined,
      allowLlm: typeof payload.allowLlm === 'boolean' ? payload.allowLlm : undefined,
    },
  };
}

function shouldUseLlm(
  payload: CompletionRequestPayload,
  linePrefix: string,
  query: string,
): boolean {
  if (payload.allowLlm !== undefined) return payload.allowLlm;
  if (payload.triggerCharacter === '.') return true;
  if (payload.triggerCharacter) return false;
  const token = linePrefix.match(/([A-Za-z_$][\w$]*)$/)?.[1] ?? query;
  return /^(findBy|findAllBy|create|update|delete|remove|get[A-Z_]|set[A-Z_]|use[A-Z_])/.test(
    token,
  );
}

async function loadIndexSuggestions(opts: {
  projectRoot: string;
  indexDir?: string | undefined;
  query: string;
}): Promise<CompletionSuggestion[]> {
  const query = opts.query.trim();
  if (query.length < 2) return [];
  const result = await searchCodebaseIndex(
    {
      projectRoot: opts.projectRoot,
      indexDir: opts.indexDir,
      query,
      limit: INDEX_LIMIT,
    },
    { timeoutMs: 1_500 },
  );

  return result.results.map(indexResultToSuggestion);
}

async function loadLspSuggestions(
  source: LspCompletionSource | undefined,
  payload: CompletionRequestPayload,
  resolvedFilePath: string,
): Promise<CompletionSuggestion[]> {
  if (!source) return [];
  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(new Error('lsp completion timeout')), 2_000);
  to.unref?.();
  try {
    return await source({
      filePath: resolvedFilePath,
      lineNumber: payload.lineNumber,
      column: payload.column,
      content: payload.content,
      triggerCharacter: payload.triggerCharacter,
      signal: timer.signal,
    });
  } finally {
    timer.abort();
    clearTimeout(to);
  }
}

async function loadLlmSuggestions(opts: {
  provider?: Provider | undefined;
  model?: string | undefined;
  payload: CompletionRequestPayload;
  prefix: string;
  suffix: string;
  linePrefix: string;
  query: string;
  relatedSymbols: CompletionSuggestion[];
  timeoutMs: number;
}): Promise<CompletionSuggestion[]> {
  if (!opts.provider || !opts.model) return [];

  const req: Request = {
    model: opts.model,
    system: [{ type: 'text', text: COMPLETION_SYSTEM_PROMPT }],
    messages: [
      {
        role: 'user',
        content: buildCompletionPrompt(opts),
      },
    ],
    maxTokens: 700,
  };

  if (opts.provider.capabilities.structuredOutput) {
    req.responseFormat = {
      type: 'json_schema',
      jsonSchema: {
        name: 'code_completion_suggestions',
        strict: false,
        schema: COMPLETION_JSON_SCHEMA,
      },
    };
  } else if (opts.provider.capabilities.jsonMode) {
    req.responseFormat = { type: 'json_object' };
  }

  const timer = new AbortController();
  const to = setTimeout(() => timer.abort(new Error('completion timeout')), opts.timeoutMs);
  to.unref?.();
  try {
    const res = await opts.provider.complete(req, { signal: timer.signal });
    const text = res.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return parseCompletionJson(text).slice(0, LLM_LIMIT);
  } finally {
    timer.abort();
    clearTimeout(to);
  }
}

function buildCompletionPrompt(opts: {
  payload: CompletionRequestPayload;
  prefix: string;
  suffix: string;
  linePrefix: string;
  query: string;
  relatedSymbols: CompletionSuggestion[];
}): string {
  const related =
    opts.relatedSymbols.length > 0
      ? opts.relatedSymbols
          .slice(0, INDEX_LIMIT)
          .map(
            (item) =>
              `- ${item.label}: ${item.detail ?? item.documentation ?? item.kind ?? 'symbol'}`,
          )
          .join('\n')
      : '(none)';

  return [
    `File: ${opts.payload.filePath}`,
    `Language: ${opts.payload.language}`,
    `Cursor: line ${opts.payload.lineNumber}, column ${opts.payload.column}`,
    `Trigger: ${opts.payload.triggerCharacter ?? 'manual'}`,
    `Current line prefix: ${opts.linePrefix}`,
    `Search/query hint: ${opts.query}`,
    '',
    'Relevant project symbols from the codebase index:',
    related,
    '',
    'Return JSON shaped exactly as:',
    '{"items":[{"label":"name","insertText":"text","kind":"function","detail":"short optional detail","documentation":"short optional docs","sortText":"optional"}]}',
    '',
    '<prefix>',
    opts.prefix,
    '</prefix>',
    '<suffix>',
    opts.suffix,
    '</suffix>',
  ].join('\n');
}

function parseCompletionJson(text: string): CompletionSuggestion[] {
  const parsed = JSON.parse(extractJson(text)) as { items?: unknown };
  if (!Array.isArray(parsed.items)) return [];
  return parsed.items
    .map(normalizeSuggestion)
    .filter((item): item is CompletionSuggestion => item !== null);
}

function normalizeSuggestion(value: unknown): CompletionSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const insertText = typeof raw.insertText === 'string' ? raw.insertText : '';
  if (!label || !insertText) return null;
  return {
    label,
    insertText,
    kind: normalizeKind(raw.kind),
    detail: optionalString(raw.detail),
    documentation: optionalString(raw.documentation),
    sortText: optionalString(raw.sortText),
    source: 'llm',
  };
}

function indexResultToSuggestion(result: SearchResult): CompletionSuggestion {
  return {
    label: result.name,
    insertText: result.name,
    kind: mapIndexKind(result.kind),
    detail: result.signature || `${result.kind} ${relativeDisplayPath(result.file, result.line)}`,
    documentation: result.docComment || result.snippet || undefined,
    sortText: `z-${String(Math.round(10_000 - result.score)).padStart(5, '0')}-${result.name}`,
    source: 'index',
  };
}

function parseLspToolOutput(output: string): CompletionSuggestion[] {
  if (!output || output.startsWith('No completions') || output.startsWith('[LSP_')) return [];
  const jsonItems = parseLspToolJson(output);
  if (jsonItems) return jsonItems;
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\d+\.\s+(.+?)\s+\[([^\]]+)](?:\s+—\s+(.+))?$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match, index): CompletionSuggestion => {
      const label = match[1]?.trim() ?? '';
      const detail = match[3]?.trim();
      return {
        label,
        insertText: label,
        kind: mapLspKindName(match[2]),
        detail: detail || undefined,
        sortText: `a-${String(index).padStart(3, '0')}-${label}`,
        source: 'lsp',
      };
    })
    .filter((item) => item.label);
}

function parseLspToolJson(output: string): CompletionSuggestion[] | null {
  try {
    const parsed = JSON.parse(output) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .map((value, index): CompletionSuggestion | null => {
        if (!value || typeof value !== 'object') return null;
        const raw = value as Record<string, unknown>;
        const label = typeof raw.label === 'string' ? raw.label.trim() : '';
        const insertText =
          typeof raw.insertText === 'string' && raw.insertText ? raw.insertText : label;
        if (!label || !insertText) return null;
        return {
          label,
          insertText,
          kind: mapLspKindName(typeof raw.kind === 'string' ? raw.kind : undefined),
          detail: optionalString(raw.detail),
          documentation: optionalString(raw.documentation),
          sortText: `a-${String(index).padStart(3, '0')}-${label}`,
          source: 'lsp',
        };
      })
      .filter((item): item is CompletionSuggestion => item !== null);
  } catch {
    return null;
  }
}

function mapLspKindName(kind: string | undefined): CompletionItemKind {
  switch (kind?.toLowerCase()) {
    case 'method':
      return 'method';
    case 'function':
      return 'function';
    case 'constructor':
      return 'constructor';
    case 'field':
      return 'field';
    case 'variable':
    case 'constant':
      return 'variable';
    case 'class':
    case 'struct':
      return 'class';
    case 'interface':
    case 'typeparameter':
      return 'interface';
    case 'module':
      return 'module';
    case 'property':
      return 'property';
    case 'unit':
      return 'unit';
    case 'value':
    case 'enummember':
      return 'value';
    case 'enum':
      return 'enum';
    case 'keyword':
      return 'keyword';
    case 'snippet':
      return 'snippet';
    case 'file':
      return 'file';
    case 'reference':
      return 'reference';
    default:
      return 'text';
  }
}

function mapIndexKind(kind: SearchResult['kind']): CompletionItemKind {
  switch (kind) {
    case 'class':
    case 'struct':
      return 'class';
    case 'interface':
    case 'trait':
    case 'type':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'function':
      return 'function';
    case 'method':
      return 'method';
    case 'property':
    case 'parameter':
      return 'property';
    case 'var':
    case 'let':
    case 'const':
    case 'static':
      return 'variable';
    case 'namespace':
    case 'mod':
      return 'module';
    default:
      return 'reference';
  }
}

function normalizeKind(value: unknown): CompletionItemKind | undefined {
  if (typeof value !== 'string') return undefined;
  const allowed: CompletionItemKind[] = [
    'text',
    'method',
    'function',
    'constructor',
    'field',
    'variable',
    'class',
    'interface',
    'module',
    'property',
    'unit',
    'value',
    'enum',
    'keyword',
    'snippet',
    'file',
    'reference',
  ];
  return allowed.includes(value as CompletionItemKind) ? (value as CompletionItemKind) : undefined;
}

function mergeSuggestions(items: CompletionSuggestion[]): CompletionSuggestion[] {
  const seen = new Set<string>();
  const merged: CompletionSuggestion[] = [];
  for (const item of items) {
    const key = `${item.label}\0${item.insertText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function buildSearchQuery(linePrefix: string, filePath: string): string {
  const memberMatch = linePrefix.match(/([A-Za-z_$][\w$]*)\.\s*([A-Za-z_$][\w$]*)?$/);
  if (memberMatch?.[2]) return memberMatch[2];
  if (memberMatch?.[1]) return memberMatch[1];
  const token = linePrefix.match(/([A-Za-z_$][\w$]*)$/)?.[1];
  if (token && token.length >= 2) return token;
  return path.basename(filePath, path.extname(filePath));
}

function currentLinePrefix(prefix: string): string {
  const idx = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
  return idx === -1 ? prefix : prefix.slice(idx + 1);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isValidPositionValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function relativeDisplayPath(file: string, line: number): string {
  return `${file.replace(/\\/g, '/')}:${line}`;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function head(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}
