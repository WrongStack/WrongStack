import type { Tool } from '@wrongstack/core/types';
import { auditTool } from './audit.js';
import { bashTool } from './bash.js';
import { batchToolUseTool } from './batch-tool-use.js';
import { browserTools } from './browser/tools.js';
import {
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
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
import { readTool } from './read.js';
import { replaceTool } from './replace.js';
import { scaffoldTool } from './scaffold.js';
import { searchTool } from './search.js';
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
 * Tier 1 (Token Saving) tool set — the absolute minimum for useful work.
 * 13 tools covering core file ops, indexed project discovery, shell, search,
 * and utilities. Codebase index lifecycle tools stay available at every tier
 * so token saving does not force broad filesystem scans.
 * Saves ~3500-5500 tokens vs full mode by omitting specialized tools.
 *
 * Tier 1 tools:
 *   read, write, edit                         — file operations
 *   codebase-stats, codebase-search/index     — indexed project discovery
 *   bash, grep, glob                          — shell + exact/path fallback
 *   diff, patch, json                         — utility
 *   search                                   — web research
 */
export const TIER1_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  codebaseStatsTool,
  codebaseSearchTool,
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
 * Adds 19 tools: replace, exec, fetch, git, tree, lint, format, typecheck,
 * test, languageInfo, language, languagePackage, todo, plan, kanban, task,
 * install, audit, design.
 *
 * These tools are used regularly during development but are not essential for
 * every turn. Omitting them in minimal/light tier saves ~900 tokens per prompt.
 */
export const TIER2_TOOLS: Tool[] = [
  replaceTool,
  execTool,
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
 * Tier 3 tool set — specialized/optional tools for specific workflows.
 * Adds 10 tools: deadCodeScan, outdated, logs, document, scaffold,
 * toolSearch, toolUse, batchToolUse, toolHelp, setWorkingDir.
 *
 * These tools are rarely used in typical development (once-per-session,
 * debugging, or one-time generation) and can be safely omitted in any
 * token-saving tier to save ~800 tokens per prompt.
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

export const builtinTools: Tool[] = [
  ...browserTools,
  e2ePlanTool,
  readTool,
  writeTool,
  editTool,
  codebaseStatsTool,
  codebaseSearchTool,
  codebaseIndexTool,
  deadCodeScanTool,
  replaceTool,
  globTool,
  grepTool,
  bashTool,
  execTool,
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
