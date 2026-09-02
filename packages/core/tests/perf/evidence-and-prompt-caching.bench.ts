import { bench, describe } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/core/system-prompt-builder.js';
import type { Context } from '../../src/core/context.js';
import {
  createContextEvidenceState,
  markAssistantReferencedEvidence,
  recordToolOutputEvidence,
} from '../../src/utils/context-evidence.js';
import type { ToolOutputMetadata } from '../../src/types/context-evidence.js';
import type { Tool } from '../../src/types/tool.js';

// ── B6: buildToolUsage + renderOnlineAgents cache — fingerprint vs reference ─
//
// Fix: online agents array is rebuilt as a fresh object on every mailbox
// status check, so caching by reference always misses. The fingerprint
// (FNV-1a over agent names) detects content equality instead.
//
// This benchmark measures:
//   (a) the fingerprint cost itself (cheap — O(total name chars), no concat)
//   (b) the buildToolUsage cache-hit path with fresh arrays (the new win)
//   (c) the cache-miss path (full rebuild) as a baseline

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool — does a useful thing in the system, with a moderately long description that captures real-world tool prose.`,
    usageHint: `Use ${name} when you need its specific functionality. Provide the required parameters per the inputSchema.`,
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
    async execute() {
      return undefined;
    },
  };
}

const BENCH_TOOLS = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'fetch',
  'todo',
  'replace',
  'search',
  'git',
  'exec',
  'patch',
  'json',
  'diff',
].map(makeTool);

const agentNames = [
  'Leader Agent',
  'Bug Hunter',
  'Security Scanner',
  'Refactor Planner',
  'chimera-review',
  'Einstein (Test)',
  'Lovelace (Frontend)',
  'Von Neumann (Architect)',
  'Newton (Research)',
  'Curie (Research)',
];

function makeAgents() {
  return agentNames.map((name) => ({
    agentId: `${name.toLowerCase().replace(/[^a-z]/g, '')}@session`,
    name,
    sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
    status: 'running' as const,
    source: 'cli',
  }));
}

describe('B6 — buildToolUsage + renderOnlineAgents cache (fingerprint key)', () => {
  // Primed builder — the cache is populated on the first call inside bench.
  let builder: DefaultSystemPromptBuilder;

  bench('cache hit — same content, fresh array (new)', async () => {
    // Ensure the builder is primed and its cache populated from a prior call.
    // The mailbox passes a fresh array object every time — the fingerprint
    // detects content equality and returns the cached string.
    if (!builder) {
      builder = new DefaultSystemPromptBuilder();
      // First call populates the cache (cache miss).
      await builder.build({
        cwd: '/tmp/project',
        projectRoot: '/tmp/project',
        tools: BENCH_TOOLS,
        provider: 'anthropic',
        model: 'anthropic-test-model',
        onlineAgents: makeAgents(),
      } as never);
    }
    // Second+ calls: fresh array, same content → fingerprint cache hit.
    await builder.build({
      cwd: '/tmp/project',
      projectRoot: '/tmp/project',
      tools: BENCH_TOOLS,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      onlineAgents: makeAgents(), // fresh array, same content
    } as never);
  });

  // Cold builder — simulates the old behavior where every build was a full
  // rebuild because reference equality always missed.
  bench('cache miss — full rebuild every iteration (old baseline)', async () => {
    const cold = new DefaultSystemPromptBuilder();
    await cold.build({
      cwd: '/tmp/project',
      projectRoot: '/tmp/project',
      tools: BENCH_TOOLS,
      provider: 'anthropic',
      model: 'anthropic-test-model',
      onlineAgents: makeAgents(),
    } as never);
  });
});

// ── B7: markAssistantReferencedEvidence — scan window cap ──────────────────
//
// Fix: only scan the last 20 tool calls instead of all 80. Each tool call's
// metadataReferencedByText does N includes() calls (files + symbols + errors).
//
// This benchmark fills the toolCalls buffer to 80 entries, then measures the
// cost of a single markAssistantReferencedEvidence call.

function fillToolCalls(count: number, _match = false): ToolOutputMetadata[] {
  const calls: ToolOutputMetadata[] = [];
  for (let i = 0; i < count; i++) {
    calls.push({
      toolUseId: `tu-${i}`,
      toolName: 'read',
      ok: true,
      summary: `read src/file-${i}.ts`,
      files: [`src/file-${i}.ts`, `src/helper-${i}.ts`],
      symbols: [`function${i}`, `class${i}`, `type${i}`],
      commands: [],
      errors: [],
      status: 'seen',
      referenceCount: 0,
      seenAt: Date.now(),
    });
  }
  return calls;
}

function makeEvidenceContext(calls: ToolOutputMetadata[]): Context {
  const state = createContextEvidenceState();
  state.toolCalls = calls;
  const ctx = { contextEvidence: state, projectRoot: '/tmp/project' } as never as Context;
  return ctx;
}

describe('B7 — markAssistantReferencedEvidence scan window', () => {
  // The fix caps the scan to the last 20 entries. These benchmarks can't
  // toggle the constant at runtime, so they approximate the old behavior
  // (scan all 80) by calling markAssistantReferencedEvidence on a context
  // with 80 tool calls whose entries all match the response text — worst
  // case for both old and new. The new path scans 20, old scans 80.
  // To show the delta, we measure with 80 matching entries (what old did)
  // vs 20 matching entries (what new does).

  const matching80 = fillToolCalls(80, true);
  const matching20 = fillToolCalls(20, true);
  // Response text matches ALL entries so both paths do full metadataReferencedByText work.
  const response80 = 'reviewed ' + matching80.map((c) => c.files[0]).join(' ');
  const response20 = 'reviewed ' + matching20.map((c) => c.files[0]).join(' ');

  bench('80 entries all match — scans last 20 (new cap)', () => {
    const ctx = makeEvidenceContext(matching80);
    markAssistantReferencedEvidence(ctx, response80);
  });

  bench('20 entries all match — equivalent workload', () => {
    const ctx = makeEvidenceContext(matching20);
    markAssistantReferencedEvidence(ctx, response20);
  });
});

// ── B8: recordToolOutputEvidence — regex extraction content cap ─────────────
//
// Fix: extractFiles and extractSymbols only scan the first 10KB; extractErrors
// only scans the last 200 lines. Without caps, a large file read triggers
// matchAll() over the full content for 3 regex patterns + per-line regex.
//
// This benchmark synthesizes a large tool output (~50KB) with file paths,
// symbols, and error lines, then measures the extraction cost.

function makeLargeToolOutput(sizeKb: number): string {
  const header = [
    'import { readFile } from "node:fs";',
    'import { resolvePath } from "./utils/paths.ts";',
    'export function parseConfig() {',
    'export class ConfigLoader {',
    'export type ConfigResult = {',
    '  const helper = new ConfigLoader();',
  ].join('\n');

  const filler = 'function dummyFunc() { return "padding"; }\n'.repeat(20);
  const block = filler + header + '\n';
  const repeats = Math.ceil((sizeKb * 1024) / block.length);
  let content = block.repeat(repeats);
  // Append error-like lines at the bottom (where errors actually surface).
  content += "\nError: ENOENT: no such file or directory, open 'missing.txt'\n";
  content += 'TypeError: Cannot read properties of undefined\n';
  content += '    at parseConfig (src/config.ts:42:15)\n';
  return content.slice(0, sizeKb * 1024 + 500);
}

describe('B8 — recordToolOutputEvidence regex extraction cap', () => {
  // Pre-generate the content so the benchmark only measures extraction cost.
  const largeContent = makeLargeToolOutput(50);
  const input = { path: 'src/large-file.ts' };

  bench('50KB output — capped extraction (new, 10KB + 200 lines)', () => {
    const ctx = makeEvidenceContext([]);
    recordToolOutputEvidence(ctx, {
      toolUseId: `tu-bench-${Math.random().toString(36).slice(2, 8)}`,
      toolName: 'read',
      input,
      content: largeContent,
      ok: true,
    });
  });

  bench('10KB output — under cap (baseline, no slicing overhead)', () => {
    const ctx = makeEvidenceContext([]);
    recordToolOutputEvidence(ctx, {
      toolUseId: `tu-bench-${Math.random().toString(36).slice(2, 8)}`,
      toolName: 'read',
      input,
      content: largeContent.slice(0, 10_000),
      ok: true,
    });
  });
});
