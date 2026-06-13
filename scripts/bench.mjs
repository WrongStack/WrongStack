// Unified benchmark suite for WrongStack performance optimizations.
//
// Benchmarks:
//   1. Token estimation cache — per-iteration CPU savings from _estTokens
//   2. parseInline memoization — TUI re-render savings from LRU cache
//   3. eliseOldToolResults early-exit — compaction allocation savings
//   4. Per-iteration hot loop — pre-flight + emit + middleware (H1 fix)
//
// Usage: node scripts/bench.mjs

import { writeFileSync } from 'node:fs';
import * as core from '../packages/core/dist/index.js';
import { parseInline } from '../packages/tui/dist/index.js';

const { AutoCompactionMiddleware, estimateMessageTokens, estimateRequestTokens, estimateRequestTokensCalibrated, computeMessageTokens, eliseOldToolResults, estimateToolResultTokens } = core;

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const ITER = 500, WARM = 50;

function bench(fn) {
  for (let i = 0; i < WARM; i++) fn();
  const times = [];
  for (let i = 0; i < ITER; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return {
    median: median(times),
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    min: Math.min(...times),
    max: Math.max(...times),
  };
}

function hline(label) {
  const bar = '═'.repeat(60);
  console.log(`\n${bar}\n  ${label}\n${bar}`);
}

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

// ═══════════════════════════════════════════════════════════════════════════
// Message builders (shared by benchmarks 1 and 3)
// ═══════════════════════════════════════════════════════════════════════════

function textBlock(text) { return { type: 'text', text }; }
function toolUseBlock(id, name, input) { return { type: 'tool_use', id, name, input }; }
function toolResultBlock(id, content, isError) { return { type: 'tool_result', tool_use_id: id, content, is_error: !!isError }; }

function userMsg(text) { return { role: 'user', content: [textBlock(text)] }; }
function assistantMsg(text) { return { role: 'assistant', content: [textBlock(text)] }; }
function toolUseMsg(id, name, input) { return { role: 'assistant', content: [textBlock('.'), toolUseBlock(id, name, input)] }; }
function toolResultMsg(id, content, isError) { return { role: 'user', content: [toolResultBlock(id, content, isError)] }; }

function readResult() {
  const lines = [];
  for (let i = 0; i < 80; i++) {
    lines.push(`  ${i + 1}| import { something } from "./module-${i}.js";`);
    lines.push(`  ${i + 1}| // realistic TypeScript source line for testing purposes`);
  }
  return lines.join('\n');
}

function grepResult() {
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`src/module-${i}/index.ts:42:  export function handler${i}(input) {}`);
  }
  return lines.join('\n');
}

function hugeResult(sizeKB) {
  // Simulate a very large tool result (e.g. read of a huge file)
  const lines = [];
  const targetChars = sizeKB * 1024;
  let chars = 0;
  while (chars < targetChars) {
    const line = `  ${lines.length + 1}| ${'x'.repeat(80)}`;
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join('\n');
}

function buildConversation(msgCount, { largeResults = 0 } = {}) {
  const messages = [];
  messages.push(userMsg('Analyze the WrongStack codebase performance.'));
  messages.push(assistantMsg("Starting exploration."));
  messages.push(toolUseMsg('tu_001', 'tree', { path: '.' }));
  messages.push(toolResultMsg('tu_001', 'packages/\n  core/src/token-estimate.ts'));
  messages.push(toolUseMsg('tu_002', 'read', { path: 'token-estimate.ts' }));
  messages.push(toolResultMsg('tu_002', readResult()));
  messages.push(assistantMsg('Token estimation is a hot-path bottleneck.'));
  messages.push(toolUseMsg('tu_003', 'grep', { pattern: 'estimate' }));
  messages.push(toolResultMsg('tu_003', grepResult()));

  let toolCounter = 4;
  let largeInserted = 0;
  while (messages.length < msgCount) {
    messages.push(userMsg(`Check file ${toolCounter}?`));
    messages.push(assistantMsg(`Reading file ${toolCounter}.`));
    const readId = `tu_${String(toolCounter++).padStart(3, '0')}`;

    if (largeInserted < largeResults) {
      messages.push(toolResultMsg(readId, hugeResult(10))); // 10KB result
      largeInserted++;
    } else {
      messages.push(toolResultMsg(readId, readResult()));
    }
    messages.push(assistantMsg(`Found issues in module ${toolCounter}.`));
  }
  return messages;
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark 1: Token estimation cache
// ═══════════════════════════════════════════════════════════════════════════

function bench1_tokenCache() {
  hline('Benchmark 1: Token estimation cache (_estTokens)');

  function makeSystemPrompt() {
    let text = 'You are WrongStack.';
    for (let i = 0; i < 10; i++) text += `\n${i + 1}. Core principle ${i + 1}`;
    for (let i = 0; i < 40; i++) text += `\n- **tool_${i}** — Description`;
    for (let i = 0; i < 15; i++) text += `\n## Skill ${i}: content`;
    return [{ type: 'text', text }];
  }

  function makeToolDefs(count) {
    return Array.from({ length: count }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i} description.`,
      inputSchema: { type: 'object', properties: { p1: { type: 'string' } }, required: ['p1'] },
    }));
  }

  function stamp(messages) {
    for (const m of messages) {
      if (m._estTokens === undefined) m._estTokens = computeMessageTokens(m);
    }
  }

  function clear(messages) {
    for (const m of messages) delete m._estTokens;
  }

  console.log('  Size   uncached    cached    speedup  saved/iter   reduction');
  console.log('  ' + '─'.repeat(6) + '  ' + '─'.repeat(10) + '  ' + '─'.repeat(10) + '  ' + '─'.repeat(8) + '  ' + '─'.repeat(12) + '  ' + '─'.repeat(10));

  const sizes = [50, 100, 200, 400];
  const systemPrompt = makeSystemPrompt();
  const tools = makeToolDefs(40);
  const rows = [];

  for (const sz of sizes) {
    const msgs = buildConversation(sz);

    clear(msgs);
    const r1 = bench(() => estimateRequestTokens(msgs, systemPrompt, tools));

    stamp(msgs);
    const r2 = bench(() => estimateRequestTokens(msgs, systemPrompt, tools));

    const speedup = (r1.median / Math.max(r2.median, 0.001));
    const savedPerIter = (r1.median - r2.median) * 4;
    const reduction = (1 - r2.median / Math.max(r1.median, 0.001)) * 100;

    console.log(
      `${String(sz).padStart(4)}msg  ${r1.median.toFixed(3).padStart(8)}ms  ${r2.median.toFixed(3).padStart(8)}ms  ${(speedup.toFixed(1) + 'x').padStart(6)}  ${savedPerIter.toFixed(3).padStart(10)}ms  ${(reduction.toFixed(0) + '%').padStart(8)}`,
    );

    rows.push({
      messages: sz,
      uncachedMs: +r1.median.toFixed(4),
      cachedMs: +r2.median.toFixed(4),
      speedup: +speedup.toFixed(1),
      savedPerIterMs: +savedPerIter.toFixed(4),
      reductionPct: +reduction.toFixed(0),
    });
  }
  return { rows };
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark 2: parseInline memoization
// ═══════════════════════════════════════════════════════════════════════════

function bench2_parseInline() {
  hline('Benchmark 2: parseInline() memoization cache');

  function buildMarkdownText(totalLines) {
    const lines = [];
    lines.push('# Performance Analysis');
    lines.push('');
    lines.push('This document analyzes **performance** of the *WrongStack* codebase.');
    lines.push('We focus on three critical paths: `token estimation`, compaction, and rendering.');
    lines.push('');
    lines.push('## Token Estimation');
    lines.push('');
    lines.push('The `estimateRequestTokens` function is called **4–5 times per iteration**.');
    lines.push('');
    lines.push('### Key Findings');
    lines.push('');
    lines.push('- **Pre-flight**: `agent-loop.ts:236` — before every LLM request');
    lines.push('- **Middleware**: `auto-compaction-middleware.ts:140` — context check');
    lines.push('- **Compactor**: `compactor.ts:107` — before AND after compaction');
    lines.push('- **Context bar**: `agent-loop.ts:92` — live display');
    lines.push('');
    lines.push('> Messages are immutable after construction. Computing once at append-time');
    lines.push('> turns the O(n·m) walk into an O(n) sum of pre-computed integers.');

    let i = lines.length;
    while (lines.length < totalLines) {
      const p = (i++) % 10;
      switch (p) {
        case 0: lines.push(`### Section ${Math.floor(i / 10) + 3}`); break;
        case 1: lines.push(`**Bold** and *italic* and \`code\` and ~~strike~~ mixed.`); break;
        case 2: lines.push(`Call \`estimateMessageTokens(messages)\` with \`_estTokens\`.`); break;
        case 3: lines.push(`- Item ${i}: \`code\` with **bold** and *italic*`); break;
        case 4: lines.push(`${Math.floor(i / 10) + 1}. Numbered step with \`inline.code()\``); break;
        case 5: lines.push(`> Blockquote with **emphasis** and \`code\` tokens.`); break;
        case 6: lines.push(`**Bold** then *italic* then \`code\` then ~~strike~~ then normal.`); break;
        case 7: lines.push(`File: \`packages/core/src/utils/token-estimate.ts\``); break;
        case 8: lines.push(`Use \`vi.mock()\` for external deps; never mock internals.`); break;
        case 9: lines.push('├── packages/core/src/utils/token-estimate.ts'); break;
      }
    }
    return lines;
  }

  const LINES = 500;
  const allLines = buildMarkdownText(LINES);
  const uniqueLines = new Set(allLines).size;

  // Force all lines into the cache
  for (const line of allLines) parseInline(line);

  // Warm benchmark
  const r = bench(() => {
    for (const line of allLines) parseInline(line);
  });

  console.log(`  Lines: ${allLines.length}  Unique: ${uniqueLines}  (${((1 - uniqueLines / allLines.length) * 100).toFixed(0)}% dup)`);
  console.log(`  Full parse (warm):  ${r.median.toFixed(4)}ms  (${(r.median / LINES * 1_000_000).toFixed(0)}ns/line)`);
  console.log(`  Per-line (warm):    ${(r.median / LINES * 1_000).toFixed(2)}µs  → essentially Map.get lookup`);

  return {
    lines: allLines.length,
    uniqueLines,
    duplicationPct: +((1 - uniqueLines / allLines.length) * 100).toFixed(0),
    warmFullParseMs: +r.median.toFixed(4),
    warmPerLineNs: +(r.median / LINES * 1_000_000).toFixed(0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark 3: eliseOldToolResults early-exit scan
// ═══════════════════════════════════════════════════════════════════════════

function bench3_elision() {
  hline('Benchmark 3: eliseOldToolResults() early-exit scan');

  console.log('  Size   w/o early-exit   w/ early-exit     saved');
  console.log('  ' + '─'.repeat(6) + '  ' + '─'.repeat(15) + '  ' + '─'.repeat(15) + '  ' + '─'.repeat(10));

  for (const sz of [50, 100, 200]) {
    // Scenario A: No oversized results → early-exit fires
    const msgsNoLarge = buildConversation(sz, { largeResults: 0 });

    // Warmup
    eliseOldToolResults(msgsNoLarge, { preserveK: 5, eliseThreshold: 2000 });

    const r = bench(() => {
      eliseOldToolResults(msgsNoLarge, { preserveK: 5, eliseThreshold: 2000 });
    });

    console.log(
      `${String(sz).padStart(4)}msg  ${'—'.padStart(13)}  ${r.median.toFixed(3).padStart(12)}ms  ${'—'.padStart(8)}`,
    );

    // Scenario B: With oversized results → early-exit doesn't fire, allocation happens
    const msgsWithLarge = buildConversation(sz, { largeResults: 3 });

    // Warmup
    eliseOldToolResults(msgsWithLarge, { preserveK: 5, eliseThreshold: 2000 });

    const r2 = bench(() => {
      eliseOldToolResults(msgsWithLarge, { preserveK: 5, eliseThreshold: 2000 });
    });

    console.log(
      `${String(sz).padStart(4)}msg  ${'—'.padStart(13)}  ${r2.median.toFixed(3).padStart(12)}ms  ${'—'.padStart(8)} (with 3× 10KB results)`,
    );
  }

  // Direct comparison: same array, cached vs uncached elision path
  console.log('\n  Direct early-exit comparison (200 messages):');
  const msgs = buildConversation(200, { largeResults: 0 });

  // Force the cache to compute
  eliseOldToolResults(msgs, { preserveK: 5, eliseThreshold: 2000 });

  const rNoLarge = bench(() => eliseOldToolResults(msgs, { preserveK: 5, eliseThreshold: 2000 }));
  console.log(`    No large results (early-exit fires):    ${rNoLarge.median.toFixed(3)}ms — O(preserveK·blocks) scan, no allocation`);

  const msgsLarge = buildConversation(200, { largeResults: 5 });
  eliseOldToolResults(msgsLarge, { preserveK: 5, eliseThreshold: 2000 });
  const rLarge = bench(() => eliseOldToolResults(msgsLarge, { preserveK: 5, eliseThreshold: 2000 }));
  console.log(`    With large results (full allocation):   ${rLarge.median.toFixed(3)}ms — full array copy + block mapping`);

  return {
    earlyExitMs: +rNoLarge.median.toFixed(4),
    fullAllocMs: +rLarge.median.toFixed(4),
    messages: 200,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark 4: Per-iteration hot loop (H1 — shared token estimate cache)
// ═══════════════════════════════════════════════════════════════════════════
//
// Simulates one full agent iteration: the pre-flight token estimate
// (estimateRequestTokens), the emitContextPct call that drives the live
// context bar, and the AutoCompactionMiddleware.handler() invocation that
// decides whether to compact. Each of these three call sites used to
// walk the same messages/system/tools arrays independently — three
// redundant O(n) scans per iteration. The H1 fix stashes the pre-flight
// total on ctx and has the other two consult it.
//
// We measure the cost of running 50 iterations of this trio, comparing
// the pre-fix (each call site recomputes) vs post-fix (stashed) path.

function bench4_perIterHotLoop() {
  hline('Benchmark 4: Per-iteration hot loop (H1 shared token cache)');

  function makeSystemPrompt() {
    let text = 'You are WrongStack, an expert AI coding mentor.';
    for (let i = 0; i < 10; i++) text += `\n${i + 1}. Core principle ${i + 1}`;
    for (let i = 0; i < 40; i++) text += `\n- **tool_${i}** — Description`;
    for (let i = 0; i < 15; i++) text += `\n## Skill ${i}: content`;
    return [{ type: 'text', text }];
  }

  function makeToolDefs(count) {
    return Array.from({ length: count }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i} description.`,
      inputSchema: { type: 'object', properties: { p1: { type: 'string' } }, required: ['p1'] },
    }));
  }

  function makeContext(msgs, systemPrompt, tools) {
    return {
      messages: msgs,
      todos: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      systemPrompt,
      provider: { id: 'mock', capabilities: { maxContext: 200_000 } },
      session: { append: async () => {} },
      signal: new AbortController().signal,
      tokenCounter: { account: () => {}, total: () => ({ input: 0, output: 0 }) },
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'mock-model',
      tools,
      meta: {},
      // H1 fields — present in the post-fix code, undefined in the pre-fix path.
      lastRequestTokens: undefined,
      toolAdjacencyDirty: false,
      clearFileTracking: () => {},
      // ConversationState is a class in the real codebase; the middleware
      // doesn't use it directly so a stand-in object is fine for the bench.
      state: { replaceMessages: () => {} },
    };
  }

  function makeCompactor() {
    return {
      async compact() {
        return { before: 0, after: 0, reductions: [] };
      },
    };
  }

  const systemPrompt = makeSystemPrompt();
  const tools = makeToolDefs(40);
  const ITERATIONS_PER_BENCH = 50;

  console.log(
    `\n  Size   pre-fix    post-fix   speedup  saved/iter   reduction`,
  );
  console.log(
    `  ` + '─'.repeat(6) + `  ` + '─'.repeat(10) + `  ` + '─'.repeat(10) + `  ` + '─'.repeat(8) + `  ` + '─'.repeat(12) + `  ` + '─'.repeat(10),
  );

  const rows = [];
  for (const sz of [50, 100, 200, 400]) {
    const baseMessages = buildConversation(sz);

    // ── Pre-fix: each of the three call sites recomputes ──────────────
    // Mirrors the pre-H1 hot path: pre-flight uses estimateRequestTokens,
    // emitContextPct and the middleware each call estimateRequestTokensCalibrated.
    const ctxOld = makeContext(baseMessages, systemPrompt, tools);
    const mwOld = new AutoCompactionMiddleware(
      makeCompactor(),
      200_000,
      () => 0, // _estimator is required; never called because we pass 0 tokens
      { warn: 0.6, soft: 0.75, hard: 0.9 },
    );

    // Force stamp so the per-message cache mirrors the production path
    // (ConversationState stamps _estTokens on appendMessage).
    for (const m of baseMessages) {
      if (m._estTokens === undefined) m._estTokens = computeMessageTokens(m);
    }

    // Warmup
    for (let n = 0; n < WARM; n++) {
      const pre = estimateRequestTokens(ctxOld.messages, ctxOld.systemPrompt, ctxOld.tools);
      estimateRequestTokensCalibrated(ctxOld.messages, ctxOld.systemPrompt, ctxOld.tools, 'mock/mock-model');
      mwOld.handler()(ctxOld, async (c) => c);
    }

    const rOld = bench(() => {
      for (let n = 0; n < ITERATIONS_PER_BENCH; n++) {
        const pre = estimateRequestTokens(ctxOld.messages, ctxOld.systemPrompt, ctxOld.tools);
        // emitContextPct — its own calibrate call
        estimateRequestTokensCalibrated(ctxOld.messages, ctxOld.systemPrompt, ctxOld.tools, 'mock/mock-model');
        // Middleware — same calibrate call
        mwOld.handler()(ctxOld, async (c) => c);
        // Reference `pre` to prevent dead-code elimination
        if (pre.total < -1) throw new Error('unreachable');
      }
    });

    // ── Post-fix: pre-flight stashes, the other two consult ctx ───────
    // Mirrors the new H1 code path. The middleware hits the stashed fast
    // path (no calibrate call). emitContextPct skips its own call and
    // reads ctx.lastRequestTokens. Pre-flight is the only walk per iter.
    const ctxNew = makeContext(baseMessages, systemPrompt, tools);
    const mwNew = new AutoCompactionMiddleware(
      makeCompactor(),
      200_000,
      () => 0,
      { warn: 0.6, soft: 0.75, hard: 0.9 },
    );

    // Warmup
    for (let n = 0; n < WARM; n++) {
      const pre = estimateRequestTokens(ctxNew.messages, ctxNew.systemPrompt, ctxNew.tools);
      ctxNew.lastRequestTokens = pre.total;
      ctxNew.meta['lastRequestTokensAt'] = { msgCount: ctxNew.messages.length, toolCount: ctxNew.tools.length };
      mwNew.handler()(ctxNew, async (c) => c);
    }

    const rNew = bench(() => {
      for (let n = 0; n < ITERATIONS_PER_BENCH; n++) {
        // Pre-flight — the only walk per iteration in the new code.
        const pre = estimateRequestTokens(ctxNew.messages, ctxNew.systemPrompt, ctxNew.tools);
        ctxNew.lastRequestTokens = pre.total;
        ctxNew.meta['lastRequestTokensAt'] = { msgCount: ctxNew.messages.length, toolCount: ctxNew.tools.length };
        // emitContextPct reads the stash, no walk.
        // Middleware reads the stash, no walk.
        mwNew.handler()(ctxNew, async (c) => c);
        if (pre.total < -1) throw new Error('unreachable');
      }
    });

    const speedup = rOld.median / Math.max(rNew.median, 0.001);
    const savedPerIter = (rOld.median - rNew.median) / ITERATIONS_PER_BENCH;
    const reduction = (1 - rNew.median / Math.max(rOld.median, 0.001)) * 100;

    console.log(
      `  ${String(sz).padStart(4)}msg  ${rOld.median.toFixed(3).padStart(8)}ms  ${rNew.median.toFixed(3).padStart(8)}ms  ${(speedup.toFixed(2) + 'x').padStart(8)}  ${savedPerIter.toFixed(4).padStart(10)}ms  ${(reduction.toFixed(0) + '%').padStart(8)}`,
    );

    rows.push({
      messages: sz,
      iterations: ITERATIONS_PER_BENCH,
      oldMs: +rOld.median.toFixed(4),
      newMs: +rNew.median.toFixed(4),
      speedup: +speedup.toFixed(2),
      savedPerIterMs: +savedPerIter.toFixed(4),
      reductionPct: +reduction.toFixed(0),
    });
  }

  return { iterationsPerBench: ITERATIONS_PER_BENCH, rows };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║     WrongStack Performance Benchmark Suite          ║');
console.log(`║     Node ${process.version.padEnd(31)}║`);
console.log(`║     ${ITER} iterations, ${WARM} warmup per test`.padEnd(53) + '║');
console.log('╚══════════════════════════════════════════════════════╝');

const results = {
  meta: {
    node: process.version,
    iterations: ITER,
    warmup: WARM,
    timestamp: new Date().toISOString(),
  },
  benchmarks: {},
};

results.benchmarks.tokenCache = bench1_tokenCache();
results.benchmarks.parseInline = bench2_parseInline();
results.benchmarks.elision = bench3_elision();
results.benchmarks.perIterHotLoop = bench4_perIterHotLoop();

// Write CI artifact
writeFileSync('bench-results.json', JSON.stringify(results, null, 2));

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${PASS} All benchmarks complete.`);
console.log(`  ${PASS} Results written to bench-results.json\n`);
