import type { JSONSchema } from '../types/tool.js';

export interface ToolWireDefinitionLike {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}

export interface CompactToolDefinitionForWireOptions {
  /** Top-level tool description budget. */
  descriptionMaxChars?: number | undefined;
  /** Per-JSON-Schema `description` annotation budget. */
  schemaDescriptionMaxChars?: number | undefined;
}

export interface CompactWireToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_DESCRIPTION_MAX_CHARS = 400;
const SCHEMA_DESCRIPTION_MAX_CHARS = 120;

const compactCache = new WeakMap<object, CompactWireToolDefinition>();

/**
 * Return the provider-wire version of a tool definition.
 *
 * Tool schemas remain structurally intact: validation keywords, property
 * names, required fields, enum values, and nested shapes are preserved. The
 * only reduction is on human prose annotations (`description`), which are the
 * largest repeated cost in provider tool declarations.
 */
export function compactToolDefinitionForWire(
  tool: ToolWireDefinitionLike,
  opts: CompactToolDefinitionForWireOptions = {},
): CompactWireToolDefinition {
  const useDefaultOptions =
    opts.descriptionMaxChars === undefined && opts.schemaDescriptionMaxChars === undefined;
  if (useDefaultOptions && typeof tool === 'object' && tool !== null) {
    const cached = compactCache.get(tool);
    if (cached) return cached;
  }

  const compact: CompactWireToolDefinition = {
    name: tool.name,
    description: compactDescription(
      tool.description ?? '',
      opts.descriptionMaxChars ?? TOOL_DESCRIPTION_MAX_CHARS,
    ),
    inputSchema: compactSchemaDescriptions(
      tool.inputSchema,
      opts.schemaDescriptionMaxChars ?? SCHEMA_DESCRIPTION_MAX_CHARS,
    ),
  };

  if (useDefaultOptions && typeof tool === 'object' && tool !== null) {
    compactCache.set(tool, compact);
  }
  return compact;
}

export function compactSchemaDescriptions(
  schema: unknown,
  maxDescriptionChars = SCHEMA_DESCRIPTION_MAX_CHARS,
): Record<string, unknown> {
  const compact = compactSchemaNode(schema, maxDescriptionChars);
  return isRecord(compact) ? compact : { type: 'object', properties: {} };
}

function compactSchemaNode(node: unknown, maxDescriptionChars: number): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => compactSchemaNode(item, maxDescriptionChars));
  }
  if (!isRecord(node)) return node;

  const out: JSONSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      out[key] = compactDescription(value, maxDescriptionChars);
    } else {
      out[key] = compactSchemaNode(value, maxDescriptionChars);
    }
  }
  return out;
}

export function compactDescription(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 20) return normalized.slice(0, maxChars);

  const hardLimit = maxChars - 12;
  const boundary = findSemanticBoundary(normalized, hardLimit);
  const head = normalized.slice(0, boundary > 0 ? boundary : hardLimit).trimEnd();
  return `${head} ...`;
}

export function findSemanticBoundary(text: string, limit: number): number {
  const punctuation = Math.max(
    text.lastIndexOf('. ', limit),
    text.lastIndexOf('; ', limit),
    text.lastIndexOf(': ', limit),
  );
  if (punctuation >= Math.floor(limit * 0.45)) return punctuation + 1;

  const comma = text.lastIndexOf(', ', limit);
  if (comma >= Math.floor(limit * 0.6)) return comma + 1;

  const space = text.lastIndexOf(' ', limit);
  return space >= Math.floor(limit * 0.6) ? space : limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
