import type { Tool } from '@wrongstack/contracts/types';

export interface ToolSearchInput {
  query?: string | undefined;
  tags?: string[] | undefined;
  permission?: 'auto' | 'confirm' | 'deny' | undefined;
  mutating?: boolean | undefined;
  limit?: number | undefined;
}

export interface ToolSearchOutput {
  tools: {
    name: string;
    description: string;
    /**
     * Exact schema required by tool_use for an on-demand invocation. Present
     * on the leading results only; see `schemaOmitted`.
     */
    inputSchema?: Tool['inputSchema'] | undefined;
    usageHint?: string | undefined;
    /** Runtime family, suitable for passing back through the `tags` filter. */
    category?: string | undefined;
    /** Fine-grained runtime capabilities, when the tool declares them. */
    capabilities?: readonly string[] | undefined;
    permission: string;
    mutating: boolean;
    /** True when the schema was left out; search the exact name to get it. */
    schemaOmitted?: true | undefined;
  }[];
  total: number;
  truncated: boolean;
  /** Guidance: why nothing matched, or how to get an omitted schema. */
  hint?: string | undefined;
  /** Total count of tools in the registry (for "no results" hints). */
  _available?: number;
}

export const toolSearchTool: Tool<ToolSearchInput, ToolSearchOutput> = {
  name: 'tool_search',
  category: 'Meta',
  description:
    'Search the catalog of available tools by name or description. Use this to discover which tool to use for a task, ' +
    'including tools whose schemas were withheld from this request to save tokens. Results include the exact input schema needed by tool_use.',
  usageHint:
    'SELF-DISCOVERY TOOL:\n\n' +
    '- Use when you need to find the right tool for a job.\n' +
    '- `query` searches names and descriptions.\n' +
    '- You can filter by `tags` (category, capability, or name terms), `permission`, or `mutating`.\n' +
    '- The catalog searched here is the full registry, not just the tools listed in this request.\n' +
    '- The first 3 results include `inputSchema`; for another result, search its exact name to get the schema.\n' +
    '- Once you find the right tool name, invoke it with `tool_use`.\n' +
    'Call this before concluding a capability is unavailable.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 1_000,
  capabilities: ['tool.meta'],
  icon: 'meta',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for tool name or description',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by tags (e.g. "filesystem", "network", "dev")',
      },
      permission: {
        type: 'string',
        enum: ['auto', 'confirm', 'deny'],
        description: 'Filter by required permission level',
      },
      mutating: {
        type: 'boolean',
        description: 'Filter by mutating flag (true=filters that modify, false=read-only)',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results to return (default: 20)',
        minimum: 1,
        maximum: 100,
      },
    },
  },
  async execute(input, ctx) {
    const rawLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 20;
    const limit = Math.max(1, Math.min(Math.floor(rawLimit), 100));
    const tools = ctx.catalogTools ?? ctx.tools;
    const query = input.query?.toLowerCase() ?? '';
    const scores = new Map<Tool, number>();

    const filtered = tools.filter((t: Tool) => {
      if (query) {
        const score = queryScore(t, query);
        if (score === 0) return false;
        scores.set(t, score);
      }
      if (input.tags && input.tags.length > 0) {
        // Tool historically exposed only a broad `category`, even though the
        // input called this filter `tags`. Include category, declared
        // capabilities, and name segments so callers can make a useful
        // semantic selection without already knowing a tool's exact family.
        // Empty candidates are dropped: `category` is optional and a name can
        // split into empty segments (`mcp__server__tool`, trailing `_`/`-`),
        // and the match below is bidirectional — `tag.includes('')` is always
        // true, so a single empty candidate made the tool match EVERY tag
        // filter, defeating it entirely.
        const searchableTags = [
          t.category ?? '',
          ...(t.capabilities ?? []),
          ...t.name.split(/[_-]/),
        ]
          .map((value) => value.toLowerCase())
          .filter((value) => value.length > 0);
        const requestedTags = input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
        if (
          requestedTags.length > 0 &&
          !requestedTags.some((tag) =>
            searchableTags.some((candidate) => candidate.includes(tag) || tag.includes(candidate)),
          )
        ) {
          return false;
        }
      }
      if (input.permission && t.permission !== input.permission) {
        return false;
      }
      if (typeof input.mutating === 'boolean' && t.mutating !== input.mutating) {
        return false;
      }
      return true;
    });

    // Best match first; ties keep registry order.
    if (query) filtered.sort((x, y) => (scores.get(y) ?? 0) - (scores.get(x) ?? 0));
    // Full schemas only for the leading matches: a 20-result answer carrying
    // every schema and usage hint cost ~29 KB of context, most of it for tools
    // the model never calls. The rest stay identifiable by name and a short
    // description; searching the exact name returns that tool's schema.
    const results = filtered.slice(0, limit).map((t: Tool, index: number) =>
      index < SCHEMA_RESULTS
        ? {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.usageHint ? { usageHint: t.usageHint } : {}),
            ...(t.category ? { category: t.category } : {}),
            ...(t.capabilities?.length ? { capabilities: t.capabilities } : {}),
            permission: t.permission,
            mutating: t.mutating,
          }
        : {
            name: t.name,
            description: shortDescription(t.description),
            ...(t.category ? { category: t.category } : {}),
            permission: t.permission,
            mutating: t.mutating,
            schemaOmitted: true as const,
          },
    );

    // When no tools match, give the model actionable guidance so it
    // doesn't spiral through random queries. Tell it how many tools exist and
    // how to list them, so the next call narrows instead of guessing again.
    const totalAvailable = tools.length;
    // Tools the query found that `tags` / `permission` / `mutating` then
    // dropped. Saying "no tools matched" there sent models hunting for a tool
    // that was in the catalog all along (an `image_generate` search with
    // `permission: 'auto'` hid a confirm-gated tool).
    const excludedByFilters = results.length === 0 && query ? scores.size : 0;
    const hint =
      excludedByFilters > 0
        ? `${excludedByFilters} tool(s) match "${input.query}" but the tags/permission/mutating filters excluded them; search again without those filters.`
        : results.length === 0 && query
          ? `No tools matched "${input.query}". ${totalAvailable} tools are available; try a broader query, or call tool_search with no query and limit up to 100.`
          : results.length > SCHEMA_RESULTS
            ? `Schemas are included for the first ${SCHEMA_RESULTS} results; call tool_search with another tool's exact name to get its inputSchema.`
            : undefined;

    return {
      tools: results,
      total: filtered.length,
      truncated: filtered.length > limit,
      ...(hint ? { hint } : {}),
      _available: totalAvailable,
    };
  },
  serialize: (output, input) => renderToolSearch(output, input ?? {}),
};

/** Words that carry no signal about which tool is meant. */
const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'to',
  'of',
  'for',
  'with',
  'from',
  'into',
  'in',
  'on',
  'or',
  'by',
  'that',
  'this',
  'tool',
  'tools',
  'use',
  'using',
  'run',
  'make',
  'do',
  'get',
  'some',
  'my',
  'two',
  'want',
  'need',
]);

/** Results that carry their full input schema and usage hint. */
const SCHEMA_RESULTS = 3;

/** A usage hint beside a full schema; the exact-name search shows all of it. */
const USAGE_HINT_CHARS = 500;

/**
 * What the model reads. The generic object renderer clipped every result line
 * at 1,000 chars, so the "exact input schema" arrived cut mid-JSON and the
 * model guessed tool_use arguments. Leading schemas are sent whole here; usage
 * hints are bounded (the exact-name search returns one in full); the rest is
 * one line per tool.
 */
function renderToolSearch(output: ToolSearchOutput, input: ToolSearchInput): string {
  const exactName =
    output.tools.length > 0 && input.query?.trim().toLowerCase() === output.tools[0]?.name;
  const header = [
    `tool_search: ${output.total} match(es)`,
    input.query ? ` for "${input.query}"` : '',
    output.truncated ? `, showing ${output.tools.length}` : '',
    typeof output._available === 'number' ? ` (${output._available} tools in catalog)` : '',
  ].join('');
  const lines = output.tools.map((tool, index) => {
    const flags = `${tool.permission}${tool.mutating ? ', mutating' : ''}`;
    if (tool.schemaOmitted) return `${index + 1}. ${tool.name} [${flags}] — ${tool.description}`;
    // The exact-name lookup is the "give me everything" call: usage verbatim.
    // Beside a ranked list, one bounded line.
    const usage = exactName ? tool.usageHint?.trim() : tool.usageHint?.replace(/\s+/g, ' ').trim();
    const shownUsage =
      usage && !exactName && usage.length > USAGE_HINT_CHARS
        ? `${usage.slice(0, USAGE_HINT_CHARS - 1)}…`
        : usage;
    return [
      `${index + 1}. ${tool.name} [${flags}${tool.category ? `, ${tool.category}` : ''}]`,
      `   ${tool.description}`,
      `   inputSchema: ${JSON.stringify(tool.inputSchema ?? {})}`,
      ...(shownUsage ? [exactName ? `   usage:\n${shownUsage}` : `   usage: ${shownUsage}`] : []),
    ].join('\n');
  });
  return [header, ...lines, ...(output.hint ? [`hint: ${output.hint}`] : [])].join('\n');
}

/** First sentence of a description, capped — enough to tell tools apart. */
function shortDescription(description: string): string {
  const firstSentence = description.split(/(?<=\.)\s/)[0] ?? description;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}...` : firstSentence;
}

/**
 * The words people use for a need, mapped to the words the tool catalog uses
 * for it. One-directional: a query term expands; tool text is never
 * rewritten. A model describing a task ("download", "website", "folder") does
 * not speak the catalog's vocabulary ("fetch", "browser", "directory").
 */
const QUERY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  download: ['fetch', 'url'],
  http: ['fetch', 'url'],
  request: ['fetch'],
  api: ['fetch', 'url'],
  website: ['browser', 'page', 'url'],
  webpage: ['browser', 'page', 'url'],
  site: ['browser', 'page', 'url'],
  internet: ['web', 'search'],
  google: ['web', 'search'],
  screenshot: ['capture', 'png'],
  image: ['png', 'screenshot', 'vision'],
  picture: ['png', 'screenshot', 'image'],
  photo: ['png', 'screenshot', 'image'],
  folder: ['directory', 'tree'],
  list: ['tree', 'directory'],
  find: ['search', 'glob', 'grep'],
  name: ['path'],
  compare: ['diff'],
  difference: ['diff'],
  filename: ['glob', 'path'],
  text: ['grep', 'content'],
  task: ['todo', 'kanban'],
  checklist: ['todo'],
  script: ['exec', 'command'],
  command: ['exec', 'bash', 'shell'],
  shell: ['bash', 'pwsh', 'exec'],
  terminal: ['bash', 'pwsh', 'exec', 'shell'],
  powershell: ['pwsh'],
  commit: ['git'],
  branch: ['git'],
  history: ['git', 'log'],
  archive: ['zip', 'tar', 'compress'],
  zip: ['archive', 'compress'],
  subagent: ['delegate', 'spawn'],
  worker: ['delegate', 'subagent', 'spawn'],
  remember: ['memory'],
  recall: ['memory', 'remember'],
  dependency: ['install', 'package'],
  library: ['install', 'package'],
  vulnerability: ['audit', 'security'],
  cve: ['audit', 'security'],
};

/** Plural and verb forms reduced to the stem a tool's text most likely uses. */
function termForms(term: string): string[] {
  const forms = [term];
  if (term.length > 4 && term.endsWith('ies')) forms.push(`${term.slice(0, -3)}y`);
  else if (term.length > 4 && term.endsWith('es')) forms.push(term.slice(0, -2), term.slice(0, -1));
  else if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) {
    forms.push(term.slice(0, -1));
  }
  if (term.length > 5 && term.endsWith('ing')) forms.push(term.slice(0, -3));
  if (term.length > 4 && term.endsWith('ed')) forms.push(term.slice(0, -2), term.slice(0, -1));
  return forms;
}

/** Every word that counts as a hit for one query term. */
function termAlternatives(term: string): string[] {
  const out = new Set<string>();
  for (const form of termForms(term)) {
    out.add(form);
    for (const synonym of QUERY_SYNONYMS[form] ?? []) out.add(synonym);
  }
  return [...out].filter((alt) => alt.length > 1);
}

/**
 * How well a tool answers a query. An exact tool name wins, then the whole
 * query found in the name or description. Otherwise the query is split into
 * words; each word counts through its plural/verb forms and catalog synonyms,
 * scored by where it lands (the whole name 6, a name segment 4, inside the name 2,
 * description/usage/category/capabilities 1). A tool must cover at least half
 * of the words: models describe what they need in phrases such as "generate
 * image with prompt and path", which as one literal substring matched nothing.
 */
function queryScore(t: Tool, query: string): number {
  const name = t.name.toLowerCase();
  const description = t.description.toLowerCase();
  if (name === query.trim()) return 2_000;
  if (name.includes(query) || description.includes(query)) return 1_000;
  const nameSegments = new Set(name.split(/[^a-z0-9]+/).filter(Boolean));
  const text = [
    description,
    (t.usageHint ?? '').toLowerCase(),
    (t.category ?? '').toLowerCase(),
    ...(t.capabilities ?? []).map((capability) => capability.toLowerCase()),
  ].join(' ');
  const terms = [
    ...new Set(
      query
        .split(/[^a-z0-9_-]+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 1 && !QUERY_STOP_WORDS.has(w)),
    ),
  ];
  if (terms.length === 0) return 0;
  let hits = 0;
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const alt of termAlternatives(term)) {
      if (alt === name) best = Math.max(best, 6);
      else if (nameSegments.has(alt)) best = Math.max(best, 4);
      else if (alt.length > 2 && name.includes(alt)) best = Math.max(best, 2);
      else if (text.includes(alt)) best = Math.max(best, 1);
    }
    if (best > 0) {
      hits++;
      score += best;
    }
  }
  return hits * 2 >= terms.length ? score : 0;
}
