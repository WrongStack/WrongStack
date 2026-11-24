import type { MCPTool, MCPToolAnnotations, ToolCallResult } from './contracts.js';
import { parseUrlElicitation, type UrlElicitation } from './elicitation.js';

/** `URLElicitationRequiredError` (spec 2025-11-25). */
const URL_ELICITATION_REQUIRED = -32042;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ANNOTATION_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

/** A hostile server must not be able to publish a megabyte-long display title. */
const ANNOTATION_TITLE_MAX_CHARS = 512;

/**
 * `ToolAnnotations` (spec 2025-03-26) is the server's claim about its own
 * behaviour, and the spec states a client MUST treat it as untrusted unless the
 * server is trusted. So keep only the five keys the schema defines, and only
 * when each carries the type the schema declares: an adversarial server cannot
 * smuggle a non-string `title`, a string-shaped boolean hint, or arbitrary
 * extra payload into whatever surfaces render this.
 *
 * Returns `undefined` when nothing usable survives, so the field is omitted
 * rather than published as an empty object.
 */
function sanitizeToolAnnotations(value: unknown): MCPToolAnnotations | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: MCPToolAnnotations = {};
  const title = value['title'];
  if (typeof title === 'string' && title.length > 0) {
    let end = ANNOTATION_TITLE_MAX_CHARS;
    const lastKept = title.charCodeAt(end - 1);
    if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
    out.title = title.slice(0, end);
  }
  for (const hint of ANNOTATION_HINTS) {
    const raw = value[hint];
    if (typeof raw === 'boolean') out[hint] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The ONE reading of a `tools/call` response, shared by every transport. A
 * JSON-RPC error becomes an error result; `structuredContent` is kept only
 * when it is the object the spec requires.
 */
export function toToolCallResult(
  response: {
    result?: unknown | undefined;
    error?: { message: string; code?: number | undefined; data?: unknown } | undefined;
  },
  allowUrlElicitation = true,
): ToolCallResult {
  if (response.error) {
    const pages = allowUrlElicitation ? urlElicitationsOf(response.error) : [];
    return {
      content: response.error.message,
      isError: true,
      ...(pages.length > 0 ? { urlElicitations: pages } : {}),
    };
  }
  const result = isPlainObject(response.result) ? response.result : {};
  const structured = result['structuredContent'];
  return {
    content: result['content'] ?? '',
    isError: Boolean(result['isError']),
    ...(isPlainObject(structured) ? { structuredContent: structured } : {}),
  };
}

/** The pages a `-32042` error names; entries that are not valid URL elicitations are dropped. */
function urlElicitationsOf(error: { code?: number | undefined; data?: unknown }): UrlElicitation[] {
  if (error.code !== URL_ELICITATION_REQUIRED || !isPlainObject(error.data)) return [];
  const listed = error.data['elicitations'];
  if (!Array.isArray(listed)) return [];
  const pages: UrlElicitation[] = [];
  for (const entry of listed) {
    const parsed = parseUrlElicitation(entry);
    if (parsed.ok) pages.push(parsed.value);
  }
  return pages;
}

const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 10_000;

/**
 * Collect every page of `tools/list`.
 *
 * The result carries `nextCursor` when a server paginates, and every transport
 * used to read only the first page — a server with a large catalog silently
 * lost the rest of its tools. Returns `null` when the FIRST page is a JSON-RPC
 * error (callers keep their previous catalog instead of wiping it); a failure
 * on a later page keeps the pages already collected. A transport exception on
 * the first page propagates, as it did before.
 */
export async function listAllTools(
  requestPage: (
    params: Record<string, unknown>,
  ) => Promise<{ result?: unknown | undefined; error?: unknown | undefined }>,
): Promise<MCPTool[] | null> {
  const tools: MCPTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    let response: { result?: unknown | undefined; error?: unknown | undefined };
    try {
      response = await requestPage(cursor ? { cursor } : {});
    } catch (err) {
      if (page === 0) throw err;
      break;
    }
    if (response.error) {
      if (page === 0) return null;
      break;
    }
    const result = response.result as
      | { tools?: unknown | undefined; nextCursor?: unknown | undefined }
      | undefined;
    if (!Array.isArray(result?.tools)) {
      if (page === 0) return null;
      break;
    }
    tools.push(...normalizeMCPTools(result?.tools));
    const next = result?.nextCursor;
    if (typeof next !== 'string' || next.length === 0) break;
    if (seenCursors.has(next) || tools.length >= MAX_TOOLS) break;
    seenCursors.add(next);
    cursor = next;
  }
  return tools.slice(0, MAX_TOOLS);
}

export function normalizeMCPTools(value: unknown): MCPTool[] {
  if (!Array.isArray(value)) return [];
  const tools: MCPTool[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as {
      name?: unknown | undefined;
      description?: unknown | undefined;
      inputSchema?: unknown | undefined;
      outputSchema?: unknown | undefined;
      annotations?: unknown | undefined;
    };
    if (typeof t.name !== 'string') continue;
    const name = t.name.trim();
    if (name.length === 0) continue;
    const inputSchema =
      t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} };
    const annotations = sanitizeToolAnnotations(t.annotations);
    // Log when a tool's schema is absent or invalid — this could indicate a
    // broken, misbehaving, or (if the server is untrusted) adversarial MCP
    // server trying to confuse the LLM with misleading type info.
    if (!t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema)) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'mcp.tool_schema_invalid',
          tool: name,
          message: 'no/invalid inputSchema — defaulting to empty object',
          timestamp: new Date().toISOString(),
        }),
      );
    }
    tools.push({
      name,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema,
      ...(isPlainObject(t.outputSchema) ? { outputSchema: t.outputSchema } : {}),
      ...(annotations ? { annotations } : {}),
    });
  }
  return tools;
}
