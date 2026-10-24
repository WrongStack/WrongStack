import type { JSONSchema } from '@wrongstack/contracts/types/tool';

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

/**
 * Wire budgets for description prose. They are a ceiling against runaway
 * prose, not a trim target: every catalog description must fit, because
 * text past the budget never reaches the model. At 400/120 the cut silently
 * dropped ~14k characters of guidance across 60 tools (secret-handling and
 * code-execution warnings, required value formats, enum semantics) — audit
 * 2026-09-15. `tool-wire-budget.test.ts` keeps the catalog inside these.
 */
export const TOOL_DESCRIPTION_MAX_CHARS = 2048;
export const SCHEMA_DESCRIPTION_MAX_CHARS = 768;

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
    inputSchema: normalizeTopLevelToolSchema(
      compactSchemaDescriptions(
        tool.inputSchema,
        opts.schemaDescriptionMaxChars ?? SCHEMA_DESCRIPTION_MAX_CHARS,
      ),
    ),
  };

  if (useDefaultOptions && typeof tool === 'object' && tool !== null) {
    compactCache.set(tool, compact);
  }
  return compact;
}

/**
 * Tool inputs are always JSON objects, but dynamically supplied MCP/plugin
 * schemas sometimes express that object as a top-level oneOf/anyOf/allOf.
 * Anthropic-family endpoints reject those combinators at the input_schema
 * root (including when reached through an OpenAI-compatible gateway such as
 * OmniRoute). Keep nested combinators intact and flatten only the root.
 * Runtime validation still uses the tool's original schema.
 */
export function normalizeTopLevelToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const combinators = (['oneOf', 'anyOf', 'allOf'] as const)
    .map((keyword) => ({ keyword, branches: schema[keyword] }))
    .filter((entry): entry is { keyword: 'oneOf' | 'anyOf' | 'allOf'; branches: unknown[] } =>
      Array.isArray(entry.branches),
    );
  if (combinators.length === 0) return schema;

  const out: Record<string, unknown> = { ...schema, type: 'object' };
  delete out['oneOf'];
  delete out['anyOf'];
  delete out['allOf'];

  let properties: Record<string, unknown> = isRecord(schema['properties'])
    ? { ...schema['properties'] }
    : {};
  let required = stringSet(schema['required']);

  for (const { keyword, branches } of combinators) {
    const objectBranches = branches.filter(isRecord);
    for (const branch of objectBranches) {
      if (isRecord(branch['properties'])) properties = { ...properties, ...branch['properties'] };
    }

    const branchRequired = objectBranches.map((branch) => stringSet(branch['required']));
    if (keyword === 'allOf') {
      for (const fields of branchRequired) for (const field of fields) required.add(field);
    } else if (branchRequired.length > 0) {
      const common = new Set(
        [...branchRequired[0]!].filter((field) =>
          branchRequired.slice(1).every((fields) => fields.has(field)),
        ),
      );
      required = new Set([...required, ...common]);
    }
  }

  out['properties'] = properties;
  if (required.size > 0) out['required'] = [...required];
  else delete out['required'];
  return out;
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
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
    Object.defineProperty(out, key, {
      value:
        key === 'description' && typeof value === 'string'
          ? compactDescription(value, maxDescriptionChars)
          : compactSchemaNode(value, maxDescriptionChars),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

export function compactDescription(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 20) return dropSplitSurrogate(normalized.slice(0, maxChars));

  const hardLimit = maxChars - 12;
  const boundary = findSemanticBoundary(normalized, hardLimit);
  const head = dropSplitSurrogate(
    normalized.slice(0, boundary > 0 ? boundary : hardLimit),
  ).trimEnd();
  return `${head} ...`;
}

/** A UTF-16 cut can land between a surrogate pair; a lone high surrogate is invalid on the wire. */
function dropSplitSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
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
