import type { Tool } from '@wrongstack/core/types';
import { auditTool } from './audit.js';
import { bashTool } from './bash.js';
import { batchToolUseTool } from './batch-tool-use.js';
import { browserTools } from './browser/tools.js';
import { clarifyTool } from './clarify.js';
import {
  codebaseAstReplaceTool,
  codebaseImpactAnalysisTool,
  codebaseIncomingCallsTool,
  codebaseIndexTool,
  codebaseInvariantCheckTool,
  codebaseOutgoingCallsTool,
  codebaseRepoMapTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseStatsTool,
  codebaseTargetedTestTool,
  deadCodeScanTool,
} from './codebase-index/index.js';
import { designTool } from './design.js';
import { diffTool } from './diff.js';
import { documentTool } from './document.js';
import { e2ePlanTool } from './e2e.js';
import { editTool } from './edit.js';
import { execTool } from './exec.js';
import { fetchTool } from './fetch.js';
import { formatTool } from './format.js';
import { gitTool } from './git.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { installTool } from './install.js';
import { jsonTool } from './json.js';
import { kanbanTool } from './kanban.js';
import { languageTool } from './languages/execute-tool.js';
import { languagePackageTool } from './languages/package-tool.js';
import { languageInfoTool } from './languages/tool.js';
import { lintTool } from './lint.js';
import { logsTool } from './logs.js';
import { outdatedTool } from './outdated.js';
import { patchTool } from './patch.js';
import { planTool } from './plan.js';
import { pwshTool } from './pwsh.js';
import { readTool } from './read.js';
import { replaceTool } from './replace.js';
import { scaffoldTool } from './scaffold.js';
import { searchTool } from './search.js';
import { securityAstScanTool } from './security-ast-scan-tool.js';
import { setWorkingDirTool } from './set-working-dir.js';
import { taskTool } from './task.js';
import { testTool } from './test.js';
import { todoTool } from './todo.js';
import { toolHelpTool } from './tool-help.js';
import { toolSearchTool } from './tool-search.js';
import { toolUseTool } from './tool-use.js';
import { treeTool } from './tree.js';
import { typecheckTool } from './typecheck.js';
import { writeTool } from './write.js';

/**
 * Provider-facing descriptions for every built-in tool.
 *
 * Keep these decision-oriented: state the primary job, the appropriate time
 * to use the tool, and any important boundary. This is deliberately kept next
 * to the canonical catalog so tools discovered lazily receive the same useful
 * guidance as directly exposed tools.
 */
export const BUILTIN_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  browser_open:
    'Create an isolated, agent-owned Playwright browser session, optionally opening an approved HTTP(S) URL. Use it to begin browser QA; private and localhost origins require an explicit allowlist.',
  browser_list:
    'List browser sessions owned by this agent, including their state and current page, without exposing sessions owned by other agents.',
  browser_status:
    'Check whether the managed Playwright Chromium installation is available before attempting browser automation.',
  browser_navigate:
    'Navigate one of this agent’s browser sessions to an approved HTTP(S) URL. Use browser_open first; private and localhost origins require an explicit allowlist.',
  browser_snapshot:
    'Inspect the current page through a bounded accessibility snapshot, with redacted console and network summaries. Prefer this before interacting with page elements.',
  browser_screenshot:
    'Capture a PNG of the current page or a selected element for visual QA. The result is a sensitive artifact with integrity metadata.',
  browser_type:
    'Fill a form control in an owned browser session. Use secretEnv for credentials so secret values never enter tool arguments or the audit trail.',
  browser_click:
    'Click a verified page element in an owned browser session. Snapshot first and use the most specific stable selector available.',
  browser_hover:
    'Hover over a verified page element in an owned browser session to reveal menus, tooltips, or other hover-driven UI state.',
  browser_select:
    'Choose an option in a select control in an owned browser session after confirming the target selector and intended value.',
  browser_press:
    'Send a keyboard key or shortcut to an owned browser session, such as Enter after verifying a form is ready to submit.',
  browser_drag:
    'Drag one page element onto another in an owned browser session. Use only when the page’s drag-and-drop interaction is the intended action.',
  browser_wait:
    'Wait for a selector, navigation condition, or bounded duration in an owned browser session before taking the next browser action.',
  browser_evaluate:
    'Run a bounded JavaScript expression in an owned page when browser APIs cannot inspect the needed state. Treat page code as arbitrary and use sparingly.',
  browser_upload:
    'Upload project-local files through a page file input in an owned browser session. Verify both the file path and target control before uploading.',
  browser_close:
    'Close an owned browser session and reclaim its resources, returning trace-artifact metadata when tracing was enabled.',
  e2e_plan:
    'Create an end-to-end test plan from a feature or user flow. Use it to identify scenarios and acceptance coverage; it plans tests rather than executing them.',
  read: 'Read a project file safely, with optional line ranges and binary-aware output. Use it to inspect source before editing; paths must stay within the project.',
  write:
    'Create or replace one project file with the complete supplied content. Use for new files or intentional full rewrites, after reading existing content when applicable.',
  edit: 'Make a precise, guarded text edit by replacing an expected block in a project file. Prefer it for small source changes so mismatches prevent accidental overwrites.',
  clarify:
    'Record or ask a focused clarification when a missing decision would materially change the implementation. Do not use it for questions that can be answered from the repository.',
  'codebase-ast-replace':
    'Replace a named declaration using source-aware structure instead of fragile text matching. Use it for a function, method, class, interface, or variable when the target is unambiguous.',
  'codebase-invariant-check':
    'Compare candidate code with its original source and report structural invariants that may have changed. Use before writing a risky refactor; it validates but does not modify files.',
  'codebase-stats':
    'Report codebase-index health, indexed file and symbol counts, languages, and freshness. Use it before relying on indexed discovery results.',
  'codebase-search':
    'Search indexed symbols, signatures, and documentation with optional language, kind, path, or LSP-kind filters. Use it for semantic discovery before broad text search.',
  'codebase-skeleton':
    'Extract a compact structural skeleton from a source file or directory, preserving declarations while omitting implementation detail. Use it to understand unfamiliar code quickly.',
  'codebase-repo-map':
    'Generate a concise map of important files, symbols, and relationships in a project area. Use it for orientation before a cross-file change.',
  'codebase-impact-analysis':
    'Find likely callers, dependents, related tests, and change risk for a named symbol. Use it before changing a public or widely used declaration.',
  'codebase-targeted-test':
    'Discover and run tests that cover a specified symbol, source file, or explicit test files. Use it for focused regression validation after a change.',
  'security-ast-scan':
    'Statically scan source code for supported security patterns and return findings with locations. Use it as a focused code check, not as a substitute for a full security assessment.',
  'codebase-incoming-calls':
    'Find indexed call sites that invoke a named function, method, or type, optionally scoped to a file. Use it to estimate breakage before changing an API.',
  'codebase-outgoing-calls':
    'Find indexed symbols called by a named function, method, or type, optionally scoped to a file. Use it to understand dependencies before refactoring behavior.',
  'codebase-index':
    'Build or refresh the local semantic codebase index, optionally for selected languages. Use it when index results are absent or stale; force performs a full reindex.',
  'dead-code-scan':
    'Analyze the indexed project for declarations that appear unreachable from configured entry points. Treat results as candidates for review, not automatic deletion instructions.',
  replace:
    'Preview or apply a regular-expression replacement across selected project files. Start with dry_run, constrain files and globs carefully, then apply only reviewed changes.',
  glob: 'Find project files by glob pattern, respecting repository boundaries and ignore rules. Use it to locate candidate paths before reading or editing them.',
  grep: 'Search project text with a bounded regular expression and contextual matches. Use it for exact literals or patterns when semantic codebase search is not appropriate.',
  bash: 'Run a shell command in the project with bounded output and timeout controls. Use it for development commands after checking side effects; background mode returns a process handle.',
  exec: 'Execute a command directly without shell interpretation, using explicit program arguments. Prefer it when argument safety and predictable process invocation matter.',
  pwsh: 'Execute a PowerShell command in the project with timeout, output, and background controls. Use it for Windows-native project operations and verify commands that can modify state.',
  fetch:
    'Fetch and extract content from an approved HTTP(S) URL for research or integration work. Use it for a known page or endpoint, not for general web discovery.',
  search:
    'Search the public web for current external information, then inspect selected results with fetch. Use it when repository evidence is insufficient or the fact may have changed.',
  todo: 'Create, update, or list the session’s concrete work items and their progress. Use it to keep multi-step work visible; it does not implement the tasks itself.',
  plan: 'Create and manage higher-level plan-board items, priorities, and status. Use it for strategic work tracking rather than small immediate edits.',
  kanban:
    'Manage project Kanban boards, cards, assignments, and acceptance evidence. Use it for persistent team workflow; changing board state is intentional and reviewable.',
  task: 'Manage structured task records, dependencies, ownership, and promotion into actionable session work. Use it to organize bounded work before delegation or execution.',
  git: 'Inspect or run scoped Git operations in the project, including status, diff, history, branches, and commits. Review the target and working tree before mutating operations.',
  patch:
    'Apply a unified diff to project files with patch-style context checking. Use it for a reviewed multi-file change when exact patch content is available.',
  json: 'Read, query, validate, or update JSON files while preserving valid structure. Use it instead of raw text edits when changing structured JSON data.',
  diff: 'Compare two files, revisions, or text inputs and return a readable unified diff. Use it to review intended changes before applying or committing them.',
  tree: 'Render a bounded directory tree with depth, file, hidden-file, and ignore controls. Use it for repository orientation without reading every file.',
  lint: 'Run the project’s configured linter for a target path or working directory and return diagnostics. Use it after code edits to catch style and static-analysis issues.',
  format:
    'Run the project’s configured formatter on selected files or directories. Use it after editing code, while reviewing the resulting diff for unintended formatting scope.',
  typecheck:
    'Run TypeScript type checking for an auto-detected or specified tsconfig. Use it after type-affecting changes; it reports diagnostics without writing source files.',
  test: 'Run the detected test runner for selected tests, with optional name filtering, coverage, watch, and timeout controls. Prefer focused tests first, then broader validation as needed.',
  language_info:
    'Inspect detected language tooling, workspaces, and supported operations for the project or target path. Use it before invoking language-specific tooling.',
  language:
    'Run a supported language-tooling operation in a detected workspace. Use it when the language profile provides a safer, structured alternative to an arbitrary shell command.',
  language_package:
    'Plan or perform a dependency operation through the detected package ecosystem. Use dry-run first when possible and specify the workspace or dependency scope deliberately.',
  install:
    'Install project dependencies with the detected package manager. Use only when dependency changes are required, and inspect lockfile and manifest changes afterward.',
  audit:
    'Run the package manager’s dependency vulnerability audit and summarize actionable findings. Use it to assess known dependency advisories, not source-code vulnerabilities.',
  outdated:
    'List outdated project dependencies and available versions without changing manifests or lockfiles. Use it to plan dependency maintenance.',
  logs: 'Read or tail configured local, container, or process logs with bounded output. Use it to investigate a known runtime failure or service behavior.',
  document:
    'Generate or update project documentation from supplied scope and source context. Use it to record verified behavior; review generated text before treating it as authoritative.',
  scaffold:
    'Preview or generate files from a built-in or custom scaffold template. Use dry_run first to inspect paths and content before creating project files.',
  design:
    'Create a structured implementation design with goals, constraints, approach, and risks. Use it before a substantial change that needs an explicit technical decision.',
  tool_search:
    'Discover registered tools by name, description, tag, permission, or mutating status. Use it to find a lazy capability before calling it through tool-use.',
  tool_use:
    'Invoke a registered tool by name with its input object, including a tool discovered lazily. Use it only after confirming the target tool’s schema and side effects.',
  batch_tool_use:
    'Invoke several independent registered tools as a batch and return each result. Use it for parallel read-only discovery; avoid batching dependent or destructive operations.',
  tool_help:
    'Show a tool’s purpose, input schema, permission, and examples, or summarize the catalog. Use it before invoking an unfamiliar or lazily discovered tool.',
  set_working_dir:
    'Show or change the session working directory within the permitted project scope. Use it when subsequent commands must target another project subdirectory.',
};

/**
 * Non-essential tools that can be omitted in token-saving mode to reduce
 * per-request token consumption. Each tool definition adds ~50-200 tokens
 * to the system prompt; skipping these saves ~2000-3000 tokens per iteration.
 *
 * These tools are useful but not critical for core development flow:
 * package management (install/audit/outdated run once per session at most),
 * meta-tools (toolSearch/toolUse/batchToolUse/toolHelp duplicate built-in
 * model capabilities), scaffolding, logging, and auto-documentation.
 */
export const OPTIONAL_TOOLS: Tool[] = [
  ...browserTools,
  e2ePlanTool,
  installTool,
  auditTool,
  outdatedTool,
  logsTool,
  documentTool,
  scaffoldTool,
  toolSearchTool,
  toolUseTool,
  batchToolUseTool,
  toolHelpTool,
  setWorkingDirTool,
];

/**
 * Specialized built-ins intentionally exposed directly only when token saving
 * is off. Keeping this set explicit prevents newly registered built-ins from
 * becoming off-only merely because somebody forgot to classify them.
 */
export const OFF_ONLY_TOOLS: Tool[] = [...browserTools, e2ePlanTool];

/**
 * Tier 1 (Token Saving) tool set — the absolute minimum for useful work.
 * 23 tools covering core file ops, indexed project discovery, structured
 * edits, shell, search, and utilities. Codebase index lifecycle tools stay
 * available at every tier so token saving does not force broad filesystem
 * scans. Saves ~3500-5500 tokens vs full mode by omitting specialized
 * schemas from direct provider exposure; hosts may retain those tools in a
 * lazy catalog.
 *
 * Tier 1 tools:
 *   read, write, edit, clarify                 — file operations
 *   codebase-stats/search/index/skeleton/repo-map/impact/targeted-test/
 *   incoming-calls/outgoing-calls/ast-replace/invariant-check,
 *   security-ast-scan                          — indexed project discovery
 *   bash, grep, glob                           — shell + exact/path fallback
 *   diff, patch, json                          — utility
 *   search                                     — web research
 */
export const TIER1_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  clarifyTool,
  codebaseAstReplaceTool,
  codebaseInvariantCheckTool,
  codebaseStatsTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseRepoMapTool,
  codebaseImpactAnalysisTool,
  codebaseTargetedTestTool,
  securityAstScanTool,
  codebaseIncomingCallsTool,
  codebaseOutgoingCallsTool,
  codebaseIndexTool,
  bashTool,
  grepTool,
  globTool,
  diffTool,
  patchTool,
  jsonTool,
  searchTool,
];

/**
 * Tier 2 tool set — standard development tools useful for non-trivial work.
 * Adds 20 tools: replace, exec, pwsh, fetch, git, tree, lint, format,
 * typecheck, test, languageInfo, language, languagePackage, todo, plan,
 * kanban, task, install, audit, design.
 *
 * These tools are used regularly during development but are not essential for
 * every turn. Omitting them in minimal/light tier saves ~900 tokens per prompt.
 */
export const TIER2_TOOLS: Tool[] = [
  replaceTool,
  execTool,
  pwshTool,
  fetchTool,
  gitTool,
  treeTool,
  lintTool,
  formatTool,
  typecheckTool,
  testTool,
  languageInfoTool,
  languageTool,
  languagePackageTool,
  todoTool,
  planTool,
  kanbanTool,
  taskTool,
  installTool,
  auditTool,
  designTool,
];

/**
 * Tier 3 tool set — specialized, administrative, and exploratory tools.
 * Adds 10 tools: outdated, logs, document, scaffold, dead-code-scan,
 * tool-search, tool-use, batch-tool-use, tool-help, set-working-dir.
 *
 * These tools are situational (e.g. documentation generation, scaffolding,
 * log tailing, dependency audits). Omitting them in standard tier saves
 * tokens while keeping all core capabilities available.
 */
export const TIER3_TOOLS: Tool[] = [
  outdatedTool,
  logsTool,
  documentTool,
  scaffoldTool,
  deadCodeScanTool,
  toolSearchTool,
  toolUseTool,
  batchToolUseTool,
  toolHelpTool,
  setWorkingDirTool,
];

const rawBuiltinTools: Tool[] = [
  ...browserTools,
  e2ePlanTool,
  readTool,
  writeTool,
  editTool,
  clarifyTool,
  codebaseAstReplaceTool,
  codebaseInvariantCheckTool,
  codebaseStatsTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseRepoMapTool,
  codebaseImpactAnalysisTool,
  codebaseTargetedTestTool,
  securityAstScanTool,
  codebaseIncomingCallsTool,
  codebaseOutgoingCallsTool,
  codebaseIndexTool,
  deadCodeScanTool,
  replaceTool,
  globTool,
  grepTool,
  bashTool,
  execTool,
  pwshTool,
  fetchTool,
  searchTool,
  todoTool,
  planTool,
  kanbanTool,
  taskTool,
  gitTool,
  patchTool,
  jsonTool,
  diffTool,
  treeTool,
  lintTool,
  formatTool,
  typecheckTool,
  testTool,
  languageInfoTool,
  languageTool,
  languagePackageTool,
  installTool,
  auditTool,
  outdatedTool,
  logsTool,
  documentTool,
  scaffoldTool,
  designTool,
  toolSearchTool,
  toolUseTool,
  batchToolUseTool,
  toolHelpTool,
  setWorkingDirTool,
];

/** The executable catalog always exposes the reviewed description above. */
export const builtinTools: Tool[] = rawBuiltinTools.map((tool) => {
  const description = BUILTIN_TOOL_DESCRIPTIONS[tool.name];
  if (!description) {
    throw new Error(`Missing provider-facing description for built-in tool: ${tool.name}`);
  }
  return { ...tool, description };
});
