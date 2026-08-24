import type { Tool } from '@wrongstack/core/types';
import { auditTool } from './audit.js';
import { bashTool } from './bash.js';
import { batchToolUseTool } from './batch-tool-use.js';
import { browserTools } from './browser/tools.js';
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
import { clarifyTool } from './clarify.js';
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

export const builtinTools: Tool[] = [
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
