import type { JSONSchema, Tool } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type MCPServerToolHost,
} from '@wrongstack/mcp';
import {
  codebaseAstReplaceTool,
  codebaseAtlasTool,
  codebaseContextTool,
  codebaseDiffImpactTool,
  codebaseFlowTraceTool,
  codebaseImpactAnalysisTool,
  codebaseIncomingCallsTool,
  codebaseIndexTool,
  codebaseInvariantCheckTool,
  codebaseOnboardTool,
  codebaseOutgoingCallsTool,
  codebaseReadSymbolTool,
  codebaseRepoMapTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseStatsTool,
  codebaseTargetedTestTool,
  fileGraphService,
  packageGraphService,
  symbolGraphService,
} from '@wrongstack/tools/codebase-index';
import { deadCodeFixTool, deadCodeScanTool } from '@wrongstack/tools/dead-code';
import {
  type CodebaseIndexMcpPolicyOptions,
  type CodebaseIndexMcpToolName,
  codebaseIndexMcpWriteVariant,
  selectCodebaseIndexMcpTools,
} from './policy.js';
import { SERVER_INFO } from './version.js';

interface GraphBaseArgs {
  projectRoot: string;
  indexDir?: string | undefined;
}

interface FileGraphArgs extends GraphBaseArgs {
  packageFilter: string;
}

interface SymbolGraphArgs extends GraphBaseArgs {
  fileFilter: string;
}

export interface CodebaseIndexMcpDependencies {
  executeTool?: (
    tool: Tool,
    args: Record<string, unknown>,
    context: Context,
    signal: AbortSignal,
  ) => Promise<unknown>;
  packageGraph?: (args: GraphBaseArgs, signal?: AbortSignal) => Promise<unknown>;
  fileGraph?: (args: FileGraphArgs, signal?: AbortSignal) => Promise<unknown>;
  symbolGraph?: (args: SymbolGraphArgs, signal?: AbortSignal) => Promise<unknown>;
}

export interface CodebaseIndexMcpToolHostOptions extends CodebaseIndexMcpPolicyOptions {
  indexDir?: string | undefined;
  dependencies?: CodebaseIndexMcpDependencies | undefined;
}

const GRAPH_SCHEMAS = {
  codebase_package_graph: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  codebase_file_graph: {
    type: 'object',
    properties: {
      package: {
        type: 'string',
        description:
          'Package name or path fragment whose file dependency graph should be returned.',
      },
    },
    required: ['package'],
    additionalProperties: false,
  },
  codebase_symbol_graph: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Project-relative file path whose symbol dependency graph should be returned.',
      },
    },
    required: ['file'],
    additionalProperties: false,
  },
} as const satisfies Partial<Record<CodebaseIndexMcpToolName, Record<string, unknown>>>;

const TOOL_DESCRIPTIONS: Record<CodebaseIndexMcpToolName, string> = {
  codebase_context:
    'Find files and declarations relevant to a task using ranked symbol search and a reference-graph walk.',
  codebase_search:
    'Search the project symbol index with SQLite FTS5 and BM25 ranking. Use this before broad filesystem exploration.',
  codebase_stats:
    'Inspect the persisted project index health, freshness, symbol counts, language breakdown, and storage path.',
  codebase_package_graph:
    'Return the project package dependency graph from the authoritative Codebase Index service.',
  codebase_file_graph: 'Return the file dependency graph for one package or package-path fragment.',
  codebase_symbol_graph: 'Return the symbol dependency graph for one project-relative source file.',
  codebase_incoming_calls:
    'List who calls or references a function, method or type: compact call sites with file and line. Use this, not codebase_symbol_graph, to find callers.',
  codebase_outgoing_calls:
    'List what a function or method calls: compact call sites with file and line.',
  codebase_read_symbol:
    "Return one symbol's source (function, class, method) by file and name, without reading the whole file.",
  codebase_skeleton:
    'Outline a file or directory: exported signatures and declarations without bodies.',
  codebase_impact_analysis:
    'Estimate what a change to a symbol affects: dependent symbols and files, optionally transitive.',
  codebase_repo_map:
    'A ranked overview of the repository: the most central files and their key symbols.',
  codebase_invariant_check:
    'Deterministically check AST backward-compatibility invariants (removed exports, mandatory parameters, interface breaks, return types) between original and candidate code.',
  codebase_diff_impact:
    'Analyze the blast radius of current git changes (working tree, staged diff, or commit/branch range): modified symbols, direct/transitive callers, AST contract invariant violations, and impacted test suites.',
  codebase_flow_trace:
    'Discover architectural entry points (HTTP routes, CLI commands, tools, handlers, main orchestrators) and trace their forward execution flows step-by-step across the call graph.',
  codebase_onboard:
    'Generate a dependency-ordered Guided Architectural Tour and Onboarding Guide combining PageRank hubs, Louvain community clusters, crux line spans, and primary execution flows.',
  codebase_atlas:
    'Inspect or project the Codebase Atlas: PageRank hubs, subsystem summaries, concept coverage, Louvain file communities, and `.wrongstack/atlas/` freshness.',
  dead_code_scan:
    'Find dead code in executable TS/JS sources: unreachable files, unused exports/re-exports, test-only code, and unused dependencies. Read-only; pass previewIds to preview cleanup diffs.',
  codebase_index:
    'Build or incrementally refresh the project Codebase Index. Hidden unless the server starts with --writable.',
  codebase_ast_replace:
    'Surgically replace a function, method, or class body/declaration via AST with automatic backward-compatibility invariant verification. Hidden unless the server starts with --writable.',
  codebase_targeted_test:
    'Discover and run only the test suites covering a changed symbol or file using call-graph references and conventions. Hidden unless the server starts with --writable.',
  dead_code_fix:
    'Remove dead code findings by id with automatic typecheck verification, rollback on failure, and undo backups. Hidden unless the server starts with --writable.',
};

const BUILTIN_TOOLS: Partial<Record<CodebaseIndexMcpToolName, Tool>> = {
  codebase_context: codebaseContextTool,
  codebase_search: codebaseSearchTool,
  codebase_stats: codebaseStatsTool,
  codebase_incoming_calls: codebaseIncomingCallsTool,
  codebase_outgoing_calls: codebaseOutgoingCallsTool,
  codebase_read_symbol: codebaseReadSymbolTool,
  codebase_skeleton: codebaseSkeletonTool,
  codebase_impact_analysis: codebaseImpactAnalysisTool,
  codebase_repo_map: codebaseRepoMapTool,
  codebase_invariant_check: codebaseInvariantCheckTool,
  codebase_diff_impact: codebaseDiffImpactTool,
  codebase_flow_trace: codebaseFlowTraceTool,
  codebase_onboard: codebaseOnboardTool,
  codebase_atlas: codebaseAtlasTool,
  dead_code_scan: deadCodeScanTool,
  codebase_index: codebaseIndexTool,
  codebase_ast_replace: codebaseAstReplaceTool,
  codebase_targeted_test: codebaseTargetedTestTool,
  dead_code_fix: deadCodeFixTool,
};

function cloneToolSchema(name: CodebaseIndexMcpToolName, tool: Tool): Record<string, unknown> {
  const schema = structuredClone(tool.inputSchema) as JSONSchema;
  if (name === 'codebase_search') {
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties) delete properties['preferLsp'];
    (schema as unknown as Record<string, unknown>)['additionalProperties'] = false;
  }
  return schema as unknown as Record<string, unknown>;
}

/**
 * The navigation tools a coding agent reaches for most. Claude Code defers MCP
 * tools behind a tool search, and an agent that must search before it can call
 * the index falls back to its always-loaded grep; loading these three upfront
 * costs little context and makes the index the shorter path.
 */
export const ALWAYS_LOADED_TOOLS: ReadonlySet<CodebaseIndexMcpToolName> = new Set([
  'codebase_search',
  'codebase_incoming_calls',
  'codebase_read_symbol',
]);

/** `InitializeResult.instructions`: shown to the client even while tools are deferred. */
export const CODEBASE_INDEX_MCP_INSTRUCTIONS =
  'A prebuilt, ranked symbol index of this repository. Use it before grep/glob or whole-file ' +
  'reads to navigate code: codebase_search finds where a symbol is defined, ' +
  'codebase_incoming_calls / codebase_outgoing_calls list callers and callees, ' +
  "codebase_read_symbol returns one symbol's source, codebase_skeleton outlines a file or " +
  'folder, codebase_impact_analysis estimates what a change affects, and codebase_context ' +
  'finds files relevant to a task. Grep stays the right tool for literal text such as ' +
  'strings, comments and config values.';

function toolDescriptor(name: CodebaseIndexMcpToolName): MCPServerTool {
  const builtin = BUILTIN_TOOLS[name];
  const graphSchema = GRAPH_SCHEMAS[name as keyof typeof GRAPH_SCHEMAS];
  if (!builtin && !graphSchema) throw new Error(`Codebase Index MCP: missing schema for ${name}`);
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: builtin ? cloneToolSchema(name, builtin) : graphSchema!,
    ...(ALWAYS_LOADED_TOOLS.has(name) ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
  };
}

function createContext(projectRoot: string, indexDir?: string): Context {
  return {
    systemPrompt: [],
    cwd: projectRoot,
    projectRoot,
    allowOutsideProjectRoot: false,
    model: 'codebase-index-mcp',
    tools: [],
    meta: {
      source: 'codebase-index-mcp',
      ...(indexDir ? { codebaseIndexDir: indexDir } : {}),
    },
  } as unknown as Context;
}

function isDegradedFailure(content: unknown): boolean {
  return (
    !!content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    (content as Record<string, unknown>)['indexStatus'] === 'error'
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const ALLOW_EMPTY_STRING_FIELDS: ReadonlySet<string> = new Set(['modifiedCode', 'newBody']);

function validateArgs(
  name: CodebaseIndexMcpToolName,
  args: Record<string, unknown>,
): string | null {
  if (name === 'codebase_search') {
    if (!nonEmptyString(args['query'])) {
      return 'codebase_search requires a non-empty string "query"';
    }
    if (args['preferLsp'] !== undefined) {
      return 'codebase_search does not accept "preferLsp" over MCP';
    }
  }
  if (name === 'codebase_file_graph' && !nonEmptyString(args['package'])) {
    return 'codebase_file_graph requires a non-empty string "package"';
  }
  // Built-in tools: every string field their own schema marks required.
  const builtin = BUILTIN_TOOLS[name];
  if (builtin && name !== 'codebase_search') {
    const schema = builtin.inputSchema as {
      required?: readonly string[];
      properties?: Record<string, { type?: unknown }>;
    };
    for (const field of schema.required ?? []) {
      if (schema.properties?.[field]?.type === 'string') {
        if (ALLOW_EMPTY_STRING_FIELDS.has(field)) {
          if (typeof args[field] !== 'string') {
            return `${name} requires a string "${field}"`;
          }
        } else if (!nonEmptyString(args[field])) {
          return `${name} requires a non-empty string "${field}"`;
        }
      }
    }
  }
  if (name === 'codebase_symbol_graph' && !nonEmptyString(args['file'])) {
    return 'codebase_symbol_graph requires a non-empty string "file"';
  }
  if (name === 'codebase_index') {
    if (args['force'] !== undefined && typeof args['force'] !== 'boolean') {
      return 'codebase_index "force" must be a boolean';
    }
    if (
      args['langs'] !== undefined &&
      (!Array.isArray(args['langs']) ||
        args['langs'].length === 0 ||
        !args['langs'].every((lang) => nonEmptyString(lang)))
    ) {
      return 'codebase_index "langs" must be an array of language strings';
    }
  }
  return null;
}

export function createCodebaseIndexMcpToolHost(
  projectRoot: string,
  opts: CodebaseIndexMcpToolHostOptions = {},
): MCPServerToolHost {
  const selected = selectCodebaseIndexMcpTools(opts);
  const allowed = new Set<CodebaseIndexMcpToolName>(selected);
  const context = createContext(projectRoot, opts.indexDir);
  const executeTool =
    opts.dependencies?.executeTool ??
    (async (tool: Tool, args: Record<string, unknown>, ctx: Context, signal: AbortSignal) =>
      await tool.execute(args as never, ctx, { signal }));
  const getPackageGraph = opts.dependencies?.packageGraph ?? packageGraphService;
  const getFileGraph = opts.dependencies?.fileGraph ?? fileGraphService;
  const getSymbolGraph = opts.dependencies?.symbolGraph ?? symbolGraphService;

  return {
    listTools(): MCPServerTool[] {
      return selected.map(toolDescriptor);
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      callOptions?: { signal?: AbortSignal | undefined },
    ): Promise<MCPServerCallResult> {
      if (!allowed.has(name as CodebaseIndexMcpToolName)) {
        return {
          content: `Tool "${name}" is not exposed by this Codebase Index MCP server`,
          isError: true,
        };
      }

      const toolName = name as CodebaseIndexMcpToolName;
      const validationError = validateArgs(toolName, args);
      if (validationError) return { content: validationError, isError: true };
      if (opts.writable !== true) {
        const writeVariant = codebaseIndexMcpWriteVariant(toolName, args);
        if (writeVariant) return { content: writeVariant, isError: true };
      }
      const signal = callOptions?.signal ?? new AbortController().signal;

      try {
        signal.throwIfAborted();
        const builtin = BUILTIN_TOOLS[toolName];
        if (builtin) {
          const validate = builtin.validate;
          if (typeof validate === 'function') {
            const errors = await validate(args);
            if (Array.isArray(errors) && errors.length > 0) {
              return { content: errors.join('\n'), isError: true };
            }
          }
          const content = await executeTool(builtin, args, context, signal);
          signal.throwIfAborted();
          // The built-in tools THROW on failure (caught below). This guards a
          // payload from an older tool build that still degraded a failed
          // query to `indexStatus: 'error'` — an MCP client must see a failure.
          if (isDegradedFailure(content)) return { content, isError: true };
          // A tool's own model-facing text, as the in-process agent gets it.
          // Without it codebase_skeleton went out as one-line JSON carrying
          // every file's skeleton twice.
          const serialize = builtin.serialize;
          return {
            content: typeof serialize === 'function' ? serialize(content, args) : content,
            isError: false,
          };
        }

        const base = {
          projectRoot,
          ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
        };
        if (toolName === 'codebase_package_graph') {
          const content = await getPackageGraph(base, signal);
          signal.throwIfAborted();
          return { content, isError: false };
        }
        if (toolName === 'codebase_file_graph') {
          const content = await getFileGraph(
            { ...base, packageFilter: String(args['package']).trim() },
            signal,
          );
          signal.throwIfAborted();
          return { content, isError: false };
        }
        const content = await getSymbolGraph(
          { ...base, fileFilter: String(args['file']).trim() },
          signal,
        );
        signal.throwIfAborted();
        return { content, isError: false };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

export function createCodebaseIndexMcpServer(
  projectRoot: string,
  opts: CodebaseIndexMcpToolHostOptions = {},
): MCPServer {
  return new MCPServer({
    host: createCodebaseIndexMcpToolHost(projectRoot, opts),
    serverInfo: { name: 'wrongstack-codebase-index-mcp', version: SERVER_INFO.version },
    instructions: CODEBASE_INDEX_MCP_INSTRUCTIONS,
    prompts: [
      {
        name: 'explore-codebase',
        title: 'Explore a project through Codebase Index',
        description: 'Check index readiness, then locate symbols and dependency relationships.',
        arguments: [{ name: 'query', description: 'Symbol or concept to locate', required: true }],
        template:
          'Use the Codebase Index MCP tools to explore {{query}}. Start with codebase_stats, use codebase_search before broad filesystem scans, and follow relevant package, file, or symbol graphs. If no persisted index exists and codebase_index is available, build it once and retry.',
      },
    ],
  });
}
