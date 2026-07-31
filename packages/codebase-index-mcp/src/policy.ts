export const CODEBASE_INDEX_READ_TOOLS = [
  'codebase_search',
  'codebase_stats',
  'codebase_package_graph',
  'codebase_file_graph',
  'codebase_symbol_graph',
] as const;

export const CODEBASE_INDEX_WRITE_TOOLS = ['codebase_index'] as const;

export type CodebaseIndexMcpReadToolName = (typeof CODEBASE_INDEX_READ_TOOLS)[number];
export type CodebaseIndexMcpWriteToolName = (typeof CODEBASE_INDEX_WRITE_TOOLS)[number];
export type CodebaseIndexMcpToolName = CodebaseIndexMcpReadToolName | CodebaseIndexMcpWriteToolName;

export interface CodebaseIndexMcpPolicyOptions {
  writable?: boolean;
}

export function selectCodebaseIndexMcpTools(
  opts: CodebaseIndexMcpPolicyOptions = {},
): CodebaseIndexMcpToolName[] {
  return opts.writable === true
    ? [...CODEBASE_INDEX_READ_TOOLS, ...CODEBASE_INDEX_WRITE_TOOLS]
    : [...CODEBASE_INDEX_READ_TOOLS];
}
