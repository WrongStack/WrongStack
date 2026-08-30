import type { Context } from '@wrongstack/core/agent';
import type { JSONSchema, Tool } from '@wrongstack/core/types';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type MCPServerToolHost,
} from '@wrongstack/mcp';
import {
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
  fileGraphService,
  packageGraphService,
  symbolGraphService,
} from '@wrongstack/tools/codebase-index';
import {
  type CodebaseIndexMcpPolicyOptions,
  type CodebaseIndexMcpToolName,
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
  packageGraph?: (args: GraphBaseArgs) => Promise<unknown>;
  fileGraph?: (args: FileGraphArgs) => Promise<unknown>;
  symbolGraph?: (args: SymbolGraphArgs) => Promise<unknown>;
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
  codebase_search:
    'Search the project symbol index with SQLite FTS5 and BM25 ranking. Use this before broad filesystem exploration.',
  codebase_stats:
    'Inspect the persisted project index health, freshness, symbol counts, language breakdown, and storage path.',
  codebase_package_graph:
    'Return the project package dependency graph from the authoritative Codebase Index service.',
  codebase_file_graph: 'Return the file dependency graph for one package or package-path fragment.',
  codebase_symbol_graph: 'Return the symbol dependency graph for one project-relative source file.',
  codebase_index:
    'Build or incrementally refresh the project Codebase Index. Hidden unless the server starts with --writable.',
};

const BUILTIN_TOOLS: Partial<Record<CodebaseIndexMcpToolName, Tool>> = {
  codebase_search: codebaseSearchTool,
  codebase_stats: codebaseStatsTool,
  codebase_index: codebaseIndexTool,
};

function cloneToolSchema(name: CodebaseIndexMcpToolName, tool: Tool): Record<string, unknown> {
  const schema = structuredClone(tool.inputSchema) as JSONSchema;
  if (name === 'codebase_search') {
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties) delete properties['preferLsp'];
  }
  return schema as unknown as Record<string, unknown>;
}

function toolDescriptor(name: CodebaseIndexMcpToolName): MCPServerTool {
  const builtin = BUILTIN_TOOLS[name];
  const graphSchema = GRAPH_SCHEMAS[name as keyof typeof GRAPH_SCHEMAS];
  if (!builtin && !graphSchema) throw new Error(`Codebase Index MCP: missing schema for ${name}`);
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: builtin ? cloneToolSchema(name, builtin) : graphSchema!,
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateArgs(
  name: CodebaseIndexMcpToolName,
  args: Record<string, unknown>,
): string | null {
  if (name === 'codebase_search' && !nonEmptyString(args['query'])) {
    return 'codebase_search requires a non-empty string "query"';
  }
  if (name === 'codebase_file_graph' && !nonEmptyString(args['package'])) {
    return 'codebase_file_graph requires a non-empty string "package"';
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
      (!Array.isArray(args['langs']) || !args['langs'].every((lang) => typeof lang === 'string'))
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

    async callTool(name: string, args: Record<string, unknown>): Promise<MCPServerCallResult> {
      if (!allowed.has(name as CodebaseIndexMcpToolName)) {
        return {
          content: `Tool "${name}" is not exposed by this Codebase Index MCP server`,
          isError: true,
        };
      }

      const toolName = name as CodebaseIndexMcpToolName;
      const validationError = validateArgs(toolName, args);
      if (validationError) return { content: validationError, isError: true };

      try {
        const builtin = BUILTIN_TOOLS[toolName];
        if (builtin) {
          const validate = builtin.validate;
          if (typeof validate === 'function') {
            const errors = await validate(args);
            if (Array.isArray(errors) && errors.length > 0) {
              return { content: errors.join('\n'), isError: true };
            }
          }
          const content = await executeTool(builtin, args, context, new AbortController().signal);
          return { content, isError: false };
        }

        const base = {
          projectRoot,
          ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
        };
        if (toolName === 'codebase_package_graph') {
          return { content: await getPackageGraph(base), isError: false };
        }
        if (toolName === 'codebase_file_graph') {
          return {
            content: await getFileGraph({ ...base, packageFilter: String(args['package']).trim() }),
            isError: false,
          };
        }
        return {
          content: await getSymbolGraph({ ...base, fileFilter: String(args['file']).trim() }),
          isError: false,
        };
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
