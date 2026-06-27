import type { Tool } from '@wrongstack/core';
import { auditTool } from './audit.js';
import { bashTool } from './bash.js';
import { batchToolUseTool } from './batch-tool-use.js';
import { codebaseIndexTool, codebaseSearchTool, codebaseStatsTool } from './codebase-index/index.js';
import { designTool } from './design.js';
import { diffTool } from './diff.js';
import { documentTool } from './document.js';
import { editTool } from './edit.js';
import { execTool } from './exec.js';
import { fetchTool } from './fetch.js';
import { formatTool } from './format.js';
import { gitTool } from './git.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { installTool } from './install.js';
import { jsonTool } from './json.js';
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
 * model capabilities), indexing (background service), scaffolding, logging,
 * and auto-documentation.
 */
export const OPTIONAL_TOOLS: Tool[] = [
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
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
  setWorkingDirTool,
];

/**
 * Tier 1 (Token Saving) tool set — the absolute minimum for useful work.
 * ~10 tools covering core file ops, shell, search, and utilities.
 * Saves ~4000-6000 tokens vs full mode by omitting 90+ tools.
 *
 * Tier 1 tools:
 *   read, write, edit    — file operations
 *   bash, grep, glob     — shell + search
 *   diff, patch, json    — utility
 *   search              — web research
 */
export const TIER1_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
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
 * Adds ~14 tools: replace, exec, fetch, git, tree, lint, format, typecheck,
 * test, todo, plan, task, install, audit.
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
  todoTool,
  planTool,
  taskTool,
  installTool,
  auditTool,
  designTool,
];

/**
 * Tier 3 tool set — specialized/optional tools for specific workflows.
 * Adds ~14 tools: outdated, logs, document, scaffold, toolSearch, toolUse,
 * batchToolUse, toolHelp, codebaseIndex, codebaseSearch, codebaseStats, setWorkingDir.
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
  toolSearchTool,
  toolUseTool,
  batchToolUseTool,
  toolHelpTool,
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
  setWorkingDirTool,
];

export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  replaceTool,
  globTool,
  grepTool,
  bashTool,
  execTool,
  fetchTool,
  searchTool,
  todoTool,
  planTool,
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
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseStatsTool,
  setWorkingDirTool,
];