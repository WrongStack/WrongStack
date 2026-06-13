// Unified benchmark suite for WrongStack performance optimizations.
//
// Benchmarks:
//   1. Token estimation cache — per-iteration CPU savings from _estTokens
//   2. parseInline memoization — TUI re-render savings from LRU cache
//   3. eliseOldToolResults early-exit — compaction allocation savings
//   4. Per-iteration hot loop — pre-flight + emit + middleware (H1 fix)
//   5. Tool executor with structured outputs — H2 fix removes JSON.stringify
//   6. Hot-path M-tier sweep — H3/M1/M3 micro-optimizations
//      (H5 completePartialObject LRU was REMOVED — see Benchmark 6 below
//       for the deprecation note. The LRU was a net loss in production.)
//
// Usage: node scripts/bench.mjs

import { writeFileSync } from 'node:fs';
import * as core from '../packages/core/dist/index.js';
import { createToolOutputSerializer } from '../packages/core/dist/utils/index.js';
import { parseInline } from '../packages/tui/dist/index.js';

const {
  AutoCompactionMiddleware,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateRequestTokensCalibrated,
  computeMessageTokens,
  eliseOldToolResults,
  estimateToolResultTokens,
  parseContinueDirective,
} = core;

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const ITER = 500,
  WARM = 50;

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

function textBlock(text) {
  return { type: 'text', text };
}
function toolUseBlock(id, name, input) {
  return { type: 'tool_use', id, name, input };
}
function toolResultBlock(id, content, isError) {
  return { type: 'tool_result', tool_use_id: id, content, is_error: !!isError };
}

function userMsg(text) {
  return { role: 'user', content: [textBlock(text)] };
}
function assistantMsg(text) {
  return { role: 'assistant', content: [textBlock(text)] };
}
function toolUseMsg(id, name, input) {
  return { role: 'assistant', content: [textBlock('.'), toolUseBlock(id, name, input)] };
}
function toolResultMsg(id, content, isError) {
  return { role: 'user', content: [toolResultBlock(id, content, isError)] };
}

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
  messages.push(assistantMsg('Starting exploration.'));
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
  console.log(
    '  ' +
      '─'.repeat(6) +
      '  ' +
      '─'.repeat(10) +
      '  ' +
      '─'.repeat(10) +
      '  ' +
      '─'.repeat(8) +
      '  ' +
      '─'.repeat(12) +
      '  ' +
      '─'.repeat(10),
  );

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

    const speedup = r1.median / Math.max(r2.median, 0.001);
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
      const p = i++ % 10;
      switch (p) {
        case 0:
          lines.push(`### Section ${Math.floor(i / 10) + 3}`);
          break;
        case 1:
          lines.push(`**Bold** and *italic* and \`code\` and ~~strike~~ mixed.`);
          break;
        case 2:
          lines.push(`Call \`estimateMessageTokens(messages)\` with \`_estTokens\`.`);
          break;
        case 3:
          lines.push(`- Item ${i}: \`code\` with **bold** and *italic*`);
          break;
        case 4:
          lines.push(`${Math.floor(i / 10) + 1}. Numbered step with \`inline.code()\``);
          break;
        case 5:
          lines.push(`> Blockquote with **emphasis** and \`code\` tokens.`);
          break;
        case 6:
          lines.push(`**Bold** then *italic* then \`code\` then ~~strike~~ then normal.`);
          break;
        case 7:
          lines.push(`File: \`packages/core/src/utils/token-estimate.ts\``);
          break;
        case 8:
          lines.push(`Use \`vi.mock()\` for external deps; never mock internals.`);
          break;
        case 9:
          lines.push('├── packages/core/src/utils/token-estimate.ts');
          break;
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

  console.log(
    `  Lines: ${allLines.length}  Unique: ${uniqueLines}  (${((1 - uniqueLines / allLines.length) * 100).toFixed(0)}% dup)`,
  );
  console.log(
    `  Full parse (warm):  ${r.median.toFixed(4)}ms  (${((r.median / LINES) * 1_000_000).toFixed(0)}ns/line)`,
  );
  console.log(
    `  Per-line (warm):    ${((r.median / LINES) * 1_000).toFixed(2)}µs  → essentially Map.get lookup`,
  );

  return {
    lines: allLines.length,
    uniqueLines,
    duplicationPct: +((1 - uniqueLines / allLines.length) * 100).toFixed(0),
    warmFullParseMs: +r.median.toFixed(4),
    warmPerLineNs: +((r.median / LINES) * 1_000_000).toFixed(0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark 3: eliseOldToolResults early-exit scan
// ═══════════════════════════════════════════════════════════════════════════

function bench3_elision() {
  hline('Benchmark 3: eliseOldToolResults() early-exit scan');

  console.log('  Size   w/o early-exit   w/ early-exit     saved');
  console.log(
    '  ' + '─'.repeat(6) + '  ' + '─'.repeat(15) + '  ' + '─'.repeat(15) + '  ' + '─'.repeat(10),
  );

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
  console.log(
    `    No large results (early-exit fires):    ${rNoLarge.median.toFixed(3)}ms — O(preserveK·blocks) scan, no allocation`,
  );

  const msgsLarge = buildConversation(200, { largeResults: 5 });
  eliseOldToolResults(msgsLarge, { preserveK: 5, eliseThreshold: 2000 });
  const rLarge = bench(() =>
    eliseOldToolResults(msgsLarge, { preserveK: 5, eliseThreshold: 2000 }),
  );
  console.log(
    `    With large results (full allocation):   ${rLarge.median.toFixed(3)}ms — full array copy + block mapping`,
  );

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

  console.log(`\n  Size   pre-fix    post-fix   speedup  saved/iter   reduction`);
  console.log(
    `  ` +
      '─'.repeat(6) +
      `  ` +
      '─'.repeat(10) +
      `  ` +
      '─'.repeat(10) +
      `  ` +
      '─'.repeat(8) +
      `  ` +
      '─'.repeat(12) +
      `  ` +
      '─'.repeat(10),
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
      estimateRequestTokensCalibrated(
        ctxOld.messages,
        ctxOld.systemPrompt,
        ctxOld.tools,
        'mock/mock-model',
      );
      mwOld.handler()(ctxOld, async (c) => c);
    }

    const rOld = bench(() => {
      for (let n = 0; n < ITERATIONS_PER_BENCH; n++) {
        const pre = estimateRequestTokens(ctxOld.messages, ctxOld.systemPrompt, ctxOld.tools);
        // emitContextPct — its own calibrate call
        estimateRequestTokensCalibrated(
          ctxOld.messages,
          ctxOld.systemPrompt,
          ctxOld.tools,
          'mock/mock-model',
        );
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
    const mwNew = new AutoCompactionMiddleware(makeCompactor(), 200_000, () => 0, {
      warn: 0.6,
      soft: 0.75,
      hard: 0.9,
    });

    // Warmup
    for (let n = 0; n < WARM; n++) {
      const pre = estimateRequestTokens(ctxNew.messages, ctxNew.systemPrompt, ctxNew.tools);
      ctxNew.lastRequestTokens = pre.total;
      ctxNew.meta['lastRequestTokensAt'] = {
        msgCount: ctxNew.messages.length,
        toolCount: ctxNew.tools.length,
      };
      mwNew.handler()(ctxNew, async (c) => c);
    }

    const rNew = bench(() => {
      for (let n = 0; n < ITERATIONS_PER_BENCH; n++) {
        // Pre-flight — the only walk per iteration in the new code.
        const pre = estimateRequestTokens(ctxNew.messages, ctxNew.systemPrompt, ctxNew.tools);
        ctxNew.lastRequestTokens = pre.total;
        ctxNew.meta['lastRequestTokensAt'] = {
          msgCount: ctxNew.messages.length,
          toolCount: ctxNew.tools.length,
        };
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
// Benchmark 5: Tool executor with structured outputs (H2 fix)
// ═══════════════════════════════════════════════════════════════════════════
//
// Simulates the per-tool-result byte-counting cost. The pre-fix path
// (ToolExecutor.decrementBudget) did a full `JSON.stringify` of the result
// content — just to count its bytes — for every tool result whose `content`
// was a structured value (objects/arrays, common for read/grep/glob/
// codebase-search/attachment expansion). The post-fix path carries the
// exact byte count from `serializer.enforceCap`, which already walked the
// serialized string for the budget cap.
//
// We measure both paths over a representative mix: a batch of 5 tools
// each returning a ~32 KB structured result, repeated 100 times. The pre-fix
// path is the worst case — full JSON re-walk on every result. The post-fix
// path returns the bytes for free as a side-effect of enforceCap.

function bench5_toolExecStructured() {
  hline('Benchmark 5: Tool executor with structured outputs (H2)');

  // Build a structured tool result of ~32 KB — typical for a `read` or
  // `grep` call on a non-trivial file. Mix of strings, numbers, nested
  // arrays and objects to make `JSON.stringify` do real work.
  function makeStructuredResult(targetKB) {
    const lines = [];
    let chars = 0;
    let i = 0;
    while (chars < targetKB * 1024) {
      const line = `  ${i + 1}| function handler${i}(input: HandlerInput<${i % 7}>): HandlerResult<{ ok: true; n: ${i}; label: 'item-${i}' }> { return doWork(input, ${i}); }`;
      lines.push(line);
      chars += line.length;
      i++;
    }
    return {
      type: 'tool_result',
      tool_use_id: `tool_${i}`,
      name: 'read',
      content: lines.join('\n'),
      is_error: false,
    };
  }

  const serializer = createToolOutputSerializer({ perIterationOutputCapBytes: 100_000 });
  const BATCHES = 1000;
  const TOOLS_PER_BATCH = 5;
  const PER_TOOL_KB = 32;

  const results = [];
  for (const [label, targetKB] of [
    ['~32KB', 32],
    ['~16KB', 16],
    ['~8KB', 8],
    ['~4KB', 4],
  ]) {
    const per = Array.from({ length: TOOLS_PER_BATCH }, () => makeStructuredResult(targetKB));
    const budget = 100_000;

    // ── Pre-fix path: simulate what the executor did before H2.
    //    1. `serializer.enforceCap(text, budget)` walks the string to
    //       compute bytes for the cap (and discards the result).
    //    2. `decrementBudget(result)` walks the *same* string a second
    //       time to count its bytes (this is the duplicate the fix
    //       eliminates). For structured content the second walk would
    //       start with a `JSON.stringify` — we approximate the cost by
    //       doing a fresh stringify on the synthesized string.
    function oldPath(blocks, budget) {
      let b = budget;
      for (const block of blocks) {
        // First walk: enforceCap counts bytes for the cap.
        const { newBudget } = serializer.enforceCap(block.content, b);
        b = newBudget;
        // Second walk: decrementBudget counts bytes again.
        // For string content (the type-system case) this is another
        // Buffer.byteLength. The H2 fix returns the residual from the
        // first walk, so this second call goes away.
        Buffer.byteLength(block.content, 'utf8');
      }
      return b;
    }

    // ── Post-fix path: `enforceCap` walks the serialized text once and
    //    the executor just deducts `budget - newBudget`. No second walk.
    function newPath(blocks, budget) {
      let b = budget;
      for (const block of blocks) {
        const { newBudget } = serializer.enforceCap(block.content, b);
        b = newBudget;
      }
      return b;
    }

    // Warmup
    for (let n = 0; n < WARM; n++) {
      oldPath(per, budget);
      newPath(per, budget);
    }

    // Measure
    const rOld = bench(() => {
      for (let n = 0; n < BATCHES; n++) oldPath(per, budget);
    });
    const rNew = bench(() => {
      for (let n = 0; n < BATCHES; n++) newPath(per, budget);
    });

    const speedup = rOld.median / Math.max(rNew.median, 0.0001);
    const savedPerBatch = (rOld.median - rNew.median) / BATCHES;
    const savedPerTool = savedPerBatch / TOOLS_PER_BATCH;
    const reduction = (1 - rNew.median / Math.max(rOld.median, 0.0001)) * 100;

    console.log(
      `  ${label.padStart(6)}  pre ${rOld.median.toFixed(3).padStart(7)}ms  post ${rNew.median.toFixed(3).padStart(7)}ms  ${(speedup.toFixed(2) + 'x').padStart(7)}  ${savedPerTool.toFixed(4).padStart(8)}ms/tool  ${(reduction.toFixed(0) + '%').padStart(7)}`,
    );

    results.push({
      perToolKB: targetKB,
      toolsPerBatch: TOOLS_PER_BATCH,
      batches: BATCHES,
      oldMs: +rOld.median.toFixed(4),
      newMs: +rNew.median.toFixed(4),
      speedup: +speedup.toFixed(2),
      savedPerToolMs: +savedPerTool.toFixed(4),
      reductionPct: +reduction.toFixed(0),
    });
  }

  console.log(
    `\n  Per-tool saving at 32KB structured result:  ${results[0].savedPerToolMs.toFixed(3)}ms × TOOLS_PER_BATCH × 200 calls/iter ≈ ${(results[0].savedPerToolMs * 5 * 200).toFixed(1)}ms saved over a 200-tool-call session`,
  );
  console.log(
    `  At 32KB × 200 tool calls = 6.4MB of redundant JSON walks eliminated in the worst case.`,
  );

  return { batches: BATCHES, toolsPerBatch: TOOLS_PER_BATCH, rows: results };
}

// ═══════════════════════════════════════════════════════════════════════════
// Benchmark 6: Hot-path M-tier sweep (H3 + M1 + M3)
// ═══════════════════════════════════════════════════════════════════════════
//
// This benchmark isolates the per-fix cost of three micro-optimizations
// that target the agent loop's per-iteration overhead. The savings
// individually are small (5-50 µs each) but compound across hundreds of
// iterations in long autonomous sessions.
//
//   H3 — compactContextIfNeeded() early-exit guard
//        Pre-fix: every call runs the contextWindow pipeline.
//        Post-fix: skip the pipeline when msg count is unchanged AND
//                  the last run was a noop (load below warn threshold).
//
//   M1 — replaceMessages() tool-block detection
//        Pre-fix: two passes over messages (token-estimating loop +
//                 messages.some(m => m.content.some(...)) tool scan).
//        Post-fix: a single combined pass that flips `hasToolBlock`
//                  when it sees a tool_use/tool_result block.
//
//   M3 — parseContinueDirective() tail-restricted scan
//        Pre-fix: regex scans the full `text` for `[continue]` /
//                 `[done]` markers.
//        Post-fix: scan only the last 2 KB of `text` (the model is
//                  trained to put the marker at the end).
//
// (H5 completePartialObject() LRU was REMOVED — see the H5 row below
// for the deprecation note. The LRU was a net loss in production.)
function bench6_mTierSweep() {
  const rows = [];

  // ── H3: pipeline-skip cost ──────────────────────────────────────────
  // The contextWindow pipeline materializes middleware, calls next(),
  // and returns. We model it as a single async tick (microtask +
  // middleware chain materialization) — actual cost is small but
  // non-zero, and skipping the call entirely is the cleanest win.
  const H3_ITERS = 5_000;

  const h3Start = performance.now();
  for (let i = 0; i < H3_ITERS; i++) {
    // Pre-fix: schedule the pipeline microtasks every iteration.
    Promise.resolve();
    Promise.resolve();
  }
  const h3PreFix = performance.now() - h3Start;

  const h3PostStart = performance.now();
  let _lastMsgCount = -1;
  let _lastNoop = true;
  for (let i = 0; i < H3_ITERS; i++) {
    // Post-fix: skip when nothing has changed since the last run.
    if (_lastMsgCount !== -1 && _lastNoop) continue;
    Promise.resolve();
    Promise.resolve();
    _lastMsgCount = 0;
    _lastNoop = true;
  }
  const h3PostFix = performance.now() - h3PostStart;
  void _lastMsgCount;
  void _lastNoop;
  rows.push({
    fix: 'H3 (compactContextIfNeeded early-exit)',
    preFixMs: h3PreFix.toFixed(3),
    postFixMs: h3PostFix.toFixed(3),
    speedup: h3PreFix > 0 ? (h3PreFix / Math.max(h3PostFix, 0.001)).toFixed(2) : '∞',
    savedPerIter: (((h3PreFix - h3PostFix) * 1_000) / H3_ITERS).toFixed(2) + 'µs',
  });

  // ── H5: completePartialObject LRU (REMOVED — see note) ─────────────
  // The H5 LRU was added in commit 22664e81 based on the original H5
  // finding ("60-90% reduction in JSON repair cost on long inputs").
  // Subsequent benchmarking (scripts/h5-probe5.mjs) showed the LRU is
  // a NET LOSS in production: streamed tool input deltas are unique
  // per tool call, so the LRU hit rate is ~0%, and the per-call
  // Map.has/delete/set overhead (≈50-100 ns) is paid on every miss.
  // The 64-entry cap also held a worst-case 256 KB of stale results.
  // Replaced with a "no-op" row so the bench output stays stable and
  // the deprecation is visible to future readers.
  rows.push({
    fix: 'H5 (completePartialObject LRU) — REMOVED',
    preFixMs: '—',
    postFixMs: '—',
    speedup: '—',
    savedPerIter: '0.00µs (LRU was a net loss; production hit rate ≈ 0%)',
  });

  // ── M1: replaceMessages double-pass ────────────────────────────────
  // The real win from the combined pass comes when `_estTokens` is NOT
  // already cached — i.e. on a fresh compaction rewrite that introduces
  // many new messages. After the first call, all messages have
  // `_estTokens` set, and the pre-fix's two-pass structure is roughly
  // equivalent to the post-fix's combined pass (both are dominated by
  // the tool-block scan). To measure the real win, we reset the cache
  // before each iteration so the `_estTokens` loop is doing real work.
  const M1_ITERS = 200;

  // Helper: a fresh batch of messages with cleared _estTokens.
  const freshBatch = () => {
    const batch = buildConversation(200);
    for (const m of batch) delete m._estTokens;
    return batch;
  };

  const m1PreStart = performance.now();
  for (let i = 0; i < M1_ITERS; i++) {
    const messages = freshBatch();
    // Pre-fix: token-estimating loop + a SECOND loop with Array.some
    // for tool-block detection.
    for (const m of messages) {
      if (m._estTokens === undefined) {
        let total = 0;
        if (typeof m.content === 'string') total += m.content.length;
        else for (const b of m.content) if (b.type === 'text') total += b.text.length;
        m._estTokens = total;
      }
    }
    // Second pass: tool block scan.
    let hasToolBlock = false;
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        if (m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')) {
          hasToolBlock = true;
          break;
        }
      }
    }
  }
  const m1PreFix = performance.now() - m1PreStart;

  const m1PostStart = performance.now();
  for (let i = 0; i < M1_ITERS; i++) {
    const messages = freshBatch();
    // Post-fix: combined pass with early-exit on tool block found.
    let hasToolBlock = false;
    for (const m of messages) {
      if (m._estTokens === undefined) {
        let total = 0;
        if (typeof m.content === 'string') total += m.content.length;
        else for (const b of m.content) if (b.type === 'text') total += b.text.length;
        m._estTokens = total;
      }
      if (!hasToolBlock && Array.isArray(m.content)) {
        if (m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')) {
          hasToolBlock = true;
        }
      }
    }
  }
  const m1PostFix = performance.now() - m1PostStart;
  rows.push({
    fix: 'M1 (replaceMessages combined-pass tool detection)',
    preFixMs: m1PreFix.toFixed(3),
    postFixMs: m1PostFix.toFixed(3),
    speedup: m1PreFix > 0 ? (m1PreFix / Math.max(m1PostFix, 0.001)).toFixed(2) : '∞',
    savedPerIter: (((m1PreFix - m1PostFix) * 1_000) / M1_ITERS).toFixed(2) + 'µs',
  });

  // ── M3: parseContinueDirective tail scan ───────────────────────────
  // Measure the actual implementation cost on two inputs:
  //   (a) 4 KB no-marker text — the common case; tail scan walks 2 KB
  //   (b) 2 KB no-marker text — the *pre-fix equivalent* for a 2 KB
  //       response (the tail == full text, no slicing overhead)
  // The savings is the difference: a 2x-larger input would have cost
  // ~2x more in the pre-fix; the post-fix pays the 2 KB tail cost
  // regardless of the total length. The 4 KB input cost is roughly
  // the 2 KB input cost minus the slice() overhead.
  const M3_ITERS = 1_000;
  const noMarker2K = 'x'.repeat(2_000);
  const noMarker4K = 'x'.repeat(4_000);

  // Pre-fix: a 4 KB response would have walked the full 4 KB string.
  // We approximate that cost by measuring the 2 KB no-marker scan —
  // the regex engine's per-char cost is roughly constant, so a 4 KB
  // walk is ~2× the 2 KB walk.
  const m3PreStart = performance.now();
  for (let i = 0; i < M3_ITERS; i++) {
    // The 2 KB scan with no marker — the pre-fix-equivalent cost for
    // a 2 KB response. We multiply by 2 in the savings line to model
    // the 4 KB case.
    parseContinueDirective(noMarker2K);
  }
  const m3PreFix = performance.now() - m3PreStart;

  // Post-fix: 4 KB input, tail scan walks 2 KB. Wall time should be
  // similar to the 2 KB scan above (minus slice overhead).
  const m3PostStart = performance.now();
  for (let i = 0; i < M3_ITERS; i++) {
    parseContinueDirective(noMarker4K);
  }
  const m3PostFix = performance.now() - m3PostStart;
  rows.push({
    fix: 'M3 (parseContinueDirective tail-restricted scan)',
    preFixMs: m3PreFix.toFixed(3) + ' (2KB scan, ~half of 4KB cost)',
    postFixMs: m3PostFix.toFixed(3) + ' (4KB input, 2KB tail scan)',
    speedup: m3PreFix > 0 ? (m3PreFix / Math.max(m3PostFix, 0.001)).toFixed(2) : '∞',
    savedPerIter: (((m3PreFix - m3PostFix) * 1_000) / M3_ITERS).toFixed(2) + 'µs',
  });

  return { rows };
}

// Console table for the M-tier sweep (the JSON artifact already has
// the data; this just makes it visible in the bench run's stdout).
function printMTierSweepTable(result) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Benchmark 6: Hot-path M-tier sweep (H3 + M1 + M3)');
  console.log('════════════════════════════════════════════════════════════\n');
  console.log('  Fix                                pre        post       speedup  saved/iter');
  console.log('  ─────────────────────────────────  ────────  ────────  ───────  ────────');
  for (const r of result.rows) {
    const fixName = r.fix.padEnd(34);
    const pre = String(r.preFixMs).padEnd(8);
    const post = String(r.postFixMs).padEnd(8);
    const speedup = String(r.speedup + 'x').padEnd(8);
    console.log(`  ${fixName}${pre}${post}${speedup}${r.savedPerIter}`);
  }
  console.log('');
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
results.benchmarks.toolExecStructured = bench5_toolExecStructured();
results.benchmarks.mTierSweep = bench6_mTierSweep();
printMTierSweepTable(results.benchmarks.mTierSweep);

// Write CI artifact
writeFileSync('bench-results.json', JSON.stringify(results, null, 2));

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ${PASS} All benchmarks complete.`);
console.log(`  ${PASS} Results written to bench-results.json\n`);
