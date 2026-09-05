/**
 * Description coverage test for @wrongstack/tools
 *
 * Ensures every Tool exported from this package has a non-empty description.
 * Factory tools (modeTool, skillTool, nextStepsTool) need runtime context and
 * are tested separately. Memory tools (remember/forget/search/related) are also
 * factory functions that require MemoryStore injection and are excluded.
 */
import { describe, expect, it } from 'vitest';

// --- Static tools (no runtime injection required) ---
import { auditTool } from '../src/audit.js';
import { bashTool } from '../src/bash.js';
import { batchToolUseTool } from '../src/batch-tool-use.js';
import { browserOpenTool, browserCloseTool, browserStatusTool } from '../src/browser/tools.js';
import { browserNavigateTool } from '../src/browser/tools.js';
import { browserSnapshotTool } from '../src/browser/tools.js';
import { browserClickTool } from '../src/browser/tools.js';
import { browserTypeTool } from '../src/browser/tools.js';
import { browserSelectTool } from '../src/browser/tools.js';
import { browserPressTool } from '../src/browser/tools.js';
import { browserHoverTool } from '../src/browser/tools.js';
import { browserDragTool } from '../src/browser/tools.js';
import { browserUploadTool } from '../src/browser/tools.js';
import { browserScreenshotTool } from '../src/browser/tools.js';
import { browserListTool } from '../src/browser/tools.js';
import { browserWaitTool } from '../src/browser/tools.js';
import { browserEvaluateTool } from '../src/browser/tools.js';
import { clarifyTool } from '../src/clarify.js';
import {
  codebaseIndexTool,
  codebaseSearchTool,
  codebaseSkeletonTool,
  codebaseStatsTool,
  codebaseAstReplaceTool,
  codebaseImpactAnalysisTool,
  codebaseIncomingCallsTool,
  codebaseOutgoingCallsTool,
  codebaseRepoMapTool,
  codebaseInvariantCheckTool,
  codebaseTargetedTestTool,
  deadCodeScanTool,
} from '../src/codebase-index/index.js';
import { designTool } from '../src/design.js';
import { diffTool } from '../src/diff.js';
import { documentTool } from '../src/document.js';
import { editTool } from '../src/edit.js';
import { e2ePlanTool } from '../src/e2e.js';
import { execTool } from '../src/exec.js';
import { fetchTool } from '../src/fetch.js';
import { formatTool } from '../src/format.js';
import { gitTool } from '../src/git.js';
import { globTool } from '../src/glob.js';
import { grepTool } from '../src/grep.js';
import { installTool } from '../src/install.js';
import { jsonTool } from '../src/json.js';
import { kanbanTool } from '../src/kanban.js';
import { languageTool } from '../src/languages/execute-tool.js';
import { languageInfoTool } from '../src/languages/tool.js';
import { languagePackageTool } from '../src/languages/package-tool.js';
import { lintTool } from '../src/lint.js';
import { logsTool } from '../src/logs.js';
import { outdatedTool } from '../src/outdated.js';
import { patchTool } from '../src/patch.js';
import { planTool } from '../src/plan.js';
import { pwshTool } from '../src/pwsh.js';
import { readTool } from '../src/read.js';
import { replaceTool } from '../src/replace.js';
import { scaffoldTool } from '../src/scaffold.js';
import { searchTool } from '../src/search.js';
import { securityAstScanTool } from '../src/security-ast-scan-tool.js';
import { setWorkingDirTool } from '../src/set-working-dir.js';
import { taskTool } from '../src/task.js';
import { testTool } from '../src/test.js';
import { todoTool } from '../src/todo.js';
import { toolHelpTool } from '../src/tool-help.js';
import { toolSearchTool } from '../src/tool-search.js';
import { toolUseTool } from '../src/tool-use.js';
import { treeTool } from '../src/tree.js';
import { typecheckTool } from '../src/typecheck.js';
import { writeTool } from '../src/write.js';
import { nextStepsTool } from '../src/next-steps-tool.js';

/**
 * All static (non-factory) tool objects exported from the package.
 * Tool.name uses snake_case as declared in each tool definition.
 */
const STATIC_TOOLS: Array<{ name: string; tool: { name: string; description: string } }> = [
  { name: 'audit', tool: auditTool },
  { name: 'bash', tool: bashTool },
  { name: 'batch_tool_use', tool: batchToolUseTool },
  { name: 'browser_open', tool: browserOpenTool },
  { name: 'browser_navigate', tool: browserNavigateTool },
  { name: 'browser_snapshot', tool: browserSnapshotTool },
  { name: 'browser_click', tool: browserClickTool },
  { name: 'browser_type', tool: browserTypeTool },
  { name: 'browser_select', tool: browserSelectTool },
  { name: 'browser_press', tool: browserPressTool },
  { name: 'browser_hover', tool: browserHoverTool },
  { name: 'browser_drag', tool: browserDragTool },
  { name: 'browser_upload', tool: browserUploadTool },
  { name: 'browser_screenshot', tool: browserScreenshotTool },
  { name: 'browser_list', tool: browserListTool },
  { name: 'browser_close', tool: browserCloseTool },
  { name: 'browser_status', tool: browserStatusTool },
  { name: 'browser_wait', tool: browserWaitTool },
  { name: 'browser_evaluate', tool: browserEvaluateTool },
  { name: 'clarify', tool: clarifyTool },
  { name: 'codebase-index', tool: codebaseIndexTool },
  { name: 'codebase-search', tool: codebaseSearchTool },
  { name: 'codebase-skeleton', tool: codebaseSkeletonTool },
  { name: 'codebase-stats', tool: codebaseStatsTool },
  { name: 'codebase-ast-replace', tool: codebaseAstReplaceTool },
  { name: 'codebase-impact-analysis', tool: codebaseImpactAnalysisTool },
  { name: 'codebase-incoming-calls', tool: codebaseIncomingCallsTool },
  { name: 'codebase-outgoing-calls', tool: codebaseOutgoingCallsTool },
  { name: 'codebase-repo-map', tool: codebaseRepoMapTool },
  { name: 'codebase-invariant-check', tool: codebaseInvariantCheckTool },
  { name: 'codebase-targeted-test', tool: codebaseTargetedTestTool },
  { name: 'dead-code-scan', tool: deadCodeScanTool },
  { name: 'design', tool: designTool },
  { name: 'diff', tool: diffTool },
  { name: 'document', tool: documentTool },
  { name: 'edit', tool: editTool },
  { name: 'e2e_plan', tool: e2ePlanTool },
  { name: 'exec', tool: execTool },
  { name: 'fetch', tool: fetchTool },
  { name: 'format', tool: formatTool },
  { name: 'git', tool: gitTool },
  { name: 'glob', tool: globTool },
  { name: 'grep', tool: grepTool },
  { name: 'install', tool: installTool },
  { name: 'json', tool: jsonTool },
  { name: 'kanban', tool: kanbanTool },
  { name: 'language', tool: languageTool },
  { name: 'language_info', tool: languageInfoTool },
  { name: 'language_package', tool: languagePackageTool },
  { name: 'lint', tool: lintTool },
  { name: 'logs', tool: logsTool },
  { name: 'outdated', tool: outdatedTool },
  { name: 'patch', tool: patchTool },
  { name: 'plan', tool: planTool },
  { name: 'pwsh', tool: pwshTool },
  { name: 'read', tool: readTool },
  { name: 'replace', tool: replaceTool },
  { name: 'scaffold', tool: scaffoldTool },
  { name: 'search', tool: searchTool },
  { name: 'security-ast-scan', tool: securityAstScanTool },
  { name: 'set_working_dir', tool: setWorkingDirTool },
  { name: 'task', tool: taskTool },
  { name: 'test', tool: testTool },
  { name: 'todo', tool: todoTool },
  { name: 'tool_help', tool: toolHelpTool },
  { name: 'tool_search', tool: toolSearchTool },
  { name: 'tool_use', tool: toolUseTool },
  { name: 'tree', tool: treeTool },
  { name: 'typecheck', tool: typecheckTool },
  { name: 'write', tool: writeTool },
  { name: 'nextsteps', tool: nextStepsTool },
];

describe('Tool description coverage', () => {
  it.each(STATIC_TOOLS)(
    '[$name] tool.name is "$name" and description is non-empty',
    ({ name, tool }) => {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.trim().length).toBeGreaterThan(0);
    },
  );

  it('gives every provider-facing built-in description non-empty, declarative text', async () => {
    const { BUILTIN_TOOL_DESCRIPTIONS, builtinTools } = await import('../src/builtin.js');

    expect(Object.keys(BUILTIN_TOOL_DESCRIPTIONS).sort()).toEqual(
      builtinTools.map((tool) => tool.name).sort(),
    );
    for (const tool of builtinTools) {
      expect(BUILTIN_TOOL_DESCRIPTIONS[tool.name]).toBe(tool.description);
      expect(tool.description.trim()).toMatch(/^[A-Z]/);
      expect(tool.description.trim()).toMatch(/[.!?]$/);
    }
  });

  // --- Factual accuracy checks (verified against implementation) ---

  it('diff: description must not claim side-by-side is supported', () => {
    // Implementation: git diff --side-by-side is not wired; falls back to unified.
    expect(diffTool.description).not.toMatch(/"side-by-side" is (fully )?supported/i);
  });

  it('json: read-only description explicitly says it does not write files', () => {
    // jsonTool.execute calls read/query/validate/transform/merge — no file write path.
    expect(jsonTool.mutating).toBe(false);
    expect(jsonTool.description).toMatch(/read-only.*does not write files/i);
  });

  it('scaffold: mutating is true, description must reflect file creation', () => {
    // scaffoldTool.execute calls atomicWrite when dry_run is false.
    expect(scaffoldTool.mutating).toBe(true);
    expect(scaffoldTool.description).toMatch(/write|file|generate|create/i);
  });

  it('document: description must not overclaim real JSDoc generation', () => {
    // documentTool.execute is a placeholder stub — does not generate real docs.
    expect(documentTool.description).not.toMatch(/^Generate or update project documentation/);
  });

  it('design: description must describe UI design kits, not implementation plans', () => {
    // designTool is a Design Studio kit selector (e.g. minimal-clarity, neo-brutalist).
    expect(designTool.description).not.toMatch(/implementation design/i);
    expect(designTool.description).toMatch(/design kit|design.?token|kit.?id/i);
  });

  it('codebase-repo-map: description must mention the ~1200 token budget', () => {
    expect(codebaseRepoMapTool.description).toMatch(/~?1200\s*token/i);
  });

  it('logs: description mentions docker/service/path', () => {
    // logsTool supports both Docker containers and local files via `path`/`service`/`lines`.
    expect(logsTool.description).toMatch(/docker|container|service|path/i);
  });

  it('browser-open: description mentions private-origin allowlisting', () => {
    expect(browserOpenTool.description).toMatch(/private.*origin|allowlist|WRONGSTACK_BROWSER/i);
  });
});
