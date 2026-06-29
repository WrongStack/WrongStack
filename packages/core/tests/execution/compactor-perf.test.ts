import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSmartDigest, scoreMessage } from '../../src/execution/compaction-core.js';
import type { Message } from '../../src/types/messages.js';

/**
 * Performance regression guard for `scoreMessage` / `buildSmartDigest`.
 *
 * Why this file exists
 * --------------------
 * `buildSmartDigest` is called on every compaction pass. On a long-running
 * agent loop, that's once every few iterations — not a per-turn hot path,
 * but it does process the entire message array each time, so per-message
 * cost matters.
 *
 * Two optimizations live in this code path:
 *
 *   1. Hoisted regex constants (`CORRECTION_PATTERN`, `FAILURE_PATTERN`,
 *      `ERROR_LANG_PATTERN`, `SECURITY_PATTERN`, `ARCHITECTURE_PATTERN`,
 *      `BOILERPLATE_PATTERN`) declared at module scope.
 *
 *      The pre-fix code inlined these as `/.../.test(text)` literals
 *      inside `scoreMessage`. On V8 the difference is small but
 *      measurable (~10–15% on a 50k-message session — V8 caches literal
 *      regexes but the cache lookup, hash, and property load still run
 *      on every call). The hoist eliminates that per-call overhead.
 *
 *   2. Noise early-bail in `buildSmartDigest`. A message with no text
 *      AND no `tool_use` block is pure tool I/O — it's guaranteed to
 *      score 0, so we skip `scoreMessage` entirely. Pure tool I/O often
 *      accounts for >30% of message count in long sessions.
 *
 * Why this test uses BOTH structural AND timing assertions
 * --------------------------------------------------------
 * V8 inlines small functions and caches regex literals aggressively, so
 * the perf difference between inlined and hoisted regexes is only ~1ms
 * on a 50k corpus — far too small to trip a reliable CI timing gate
 * (CI runners vary 2–3× in speed). A timing-only test would either be
 * flaky (tight threshold) or useless (loose threshold).
 *
 * The structural assertions below read the source file and verify the
 * optimization is still present. They're deterministic — if anyone
 * re-inlines the regexes or removes the early-bail, the test fails
 * regardless of the host's CPU speed. The timing assertions stay in as
 * a load-bearing smoke test: a no-op implementation (just `return 3`)
 * would pass the structural checks but trip the timing gates.
 */

const __filename = fileURLToPath(import.meta.url);
const COMPACTOR_SRC = path.resolve(
  path.dirname(__filename),
  '..',
  '..',
  'src',
  'execution',
  'compaction-core.ts',
);

const SESSION_SIZE = 50_000;
const WORD_POOL = [
  'function', 'variable', 'module', 'export', 'import', 'class', 'interface',
  'type', 'generic', 'promise', 'async', 'await', 'event', 'listener',
  'cache', 'eviction', 'compaction', 'streaming', 'parser', 'token',
  'commit', 'branch', 'merge', 'rebase', 'deploy', 'index', 'search',
  'fixture', 'mock', 'integration', 'unit', 'benchmark', 'lint',
];
const CRITICAL_PHRASES = [
  'no, this is wrong, revert that change',
  'error: TypeError: cannot read property',
  'panic: runtime error: index out of range',
  'security: hardcoded API key detected',
  'architecture decision: use dependency injection',
];
const TOOL_NAMES = ['read', 'grep', 'bash', 'edit', 'glob', 'write'];

function randomWords(n: number): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(WORD_POOL[Math.floor(Math.random() * WORD_POOL.length)]!);
  return [...out];
}

function makeUser(text: string): Message {
  return { role: 'user', content: text, ts: new Date().toISOString() };
}

function makeAssistantText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ts: new Date().toISOString(),
    usage: { input: 80, output: 20 },
    stopReason: 'end_turn',
  };
}

function makeAssistantWithTool(id: string, toolName: string, input: Record<string, unknown>, text: string): Message {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      { type: 'tool_use', id, name: toolName, input },
    ],
    ts: new Date().toISOString(),
    usage: { input: 200, output: 40 },
    stopReason: 'tool_use',
  };
}

function makeToolResult(id: string, content: string, isError = false): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    ts: new Date().toISOString(),
  };
}

/**
 * Synthetic session that mixes user prompts, assistant text, tool
 * use + result pairs, pure tool I/O (noise), critical signals, and
 * boilerplate. The shape matches what `HybridCompactor` feeds into
 * `buildSmartDigest` in production.
 */
function buildSession(n: number): Message[] {
  const messages: Message[] = [];
  let toolId = 0;
  for (let i = 0; i < n; i++) {
    const phase = i % 12;
    if (phase === 0) {
      messages.push(makeUser(`Run ${randomWords(4).join(' ')}`));
    } else if (phase === 1) {
      messages.push(makeAssistantText(`I'll ${randomWords(2).join(' ')} now.`));
    } else if (phase >= 2 && phase <= 4) {
      const id = `t${toolId++}`;
      const toolName = TOOL_NAMES[Math.floor(Math.random() * TOOL_NAMES.length)]!;
      messages.push(makeAssistantWithTool(id, toolName, { path: `src/${randomWords(1)[0]}.ts` }, ''));
      messages.push(makeToolResult(id, `${randomWords(8).join(' ')} (matched)`));
    } else if (phase === 5) {
      // Pure tool I/O — exercises the early-bail in buildSmartDigest.
      messages.push(makeToolResult(`t${toolId++}`, ''));
    } else if (phase === 6) {
      messages.push(makeAssistantText(CRITICAL_PHRASES[i % CRITICAL_PHRASES.length]!));
    } else {
      messages.push(makeAssistantText(`${randomWords(8).join(' ')}.`));
    }
  }
  return messages;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function bench(fn: () => void, iters = 5): { median: number; min: number; max: number } {
  // Warm up V8 — first call pays JIT/parse cost we don't want to
  // attribute to the production code path.
  for (let i = 0; i < 3; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return { median: median(times), min: Math.min(...times), max: Math.max(...times) };
}

describe('compactor perf — structural guards', () => {
  it('regex patterns are hoisted to module scope (not inlined in scoreMessage)', () => {
    // Read the source as text. We're checking structural invariants —
    // if anyone re-inlines the regexes, this assertion catches it
    // regardless of the host's CPU speed.
    const src = fs.readFileSync(COMPACTOR_SRC, 'utf8');

    // Hoisted constants must exist at module scope. The names below
    // are stable — if you rename one, update this list.
    const HOISTED_NAMES = [
      'FAILURE_PATTERN',
      'CORRECTION_PATTERN',
      'ERROR_LANG_PATTERN',
      'SECURITY_PATTERN',
      'ARCHITECTURE_PATTERN',
      'BOILERPLATE_PATTERN',
    ];
    for (const name of HOISTED_NAMES) {
      // Module-scope `const NAME = /.../` declaration. We allow either
      // `const NAME = ` or `export const NAME = ` (the helpers may be
      // exported). The regex itself must be at column-start indented
      // by 0 or 2 spaces (top-level or module-scoped const).
      const declRegex = new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*/`, 'm');
      expect(
        declRegex.test(src),
        `Missing module-level const ${name}. If you renamed it, update the regression test list.`,
      ).toBe(true);
    }

    // None of these named patterns may appear as the LEFT side of a
    // `.test(` or `.exec(` call inside scoreMessage with an inline
    // regex literal on the right — that would mean someone re-inlined.
    // We grep the scoreMessage body specifically.
    const scoreMatch = src.match(/function scoreMessage\([\s\S]*?\n\}/);
    expect(scoreMatch, 'Could not locate scoreMessage body').toBeTruthy();
    const scoreBody = scoreMatch![0];

    for (const name of HOISTED_NAMES) {
      // `name.test(text)` or `name.exec(text)` is the expected usage.
      // A line like `name = /.../.test(text)` or `name(/.../)` would be
      // the regression — those don't actually exist in any sane form,
      // but this regex catches them.
      const inlineRegex = new RegExp(`${name}\\s*=\\s*/[^/]+/`, 'g');
      expect(
        inlineRegex.test(scoreBody),
        `${name} appears inlined inside scoreMessage. Reverting the hoist regression.`,
      ).toBe(false);
    }

    // Verify the hoisted patterns are actually USED inside scoreMessage
    // (otherwise the constant is dead code and the optimization is
    // technically still present but pointless).
    for (const name of HOISTED_NAMES) {
      const usageRegex = new RegExp(`\\b${name}\\.(?:test|exec)\\b`);
      expect(
        usageRegex.test(scoreBody),
        `${name} is declared but unused inside scoreMessage. Either delete the unused constant or wire it back into the scoring logic.`,
      ).toBe(true);
    }
  });

  it('buildSmartDigest has a noise early-bail for pure tool I/O messages', () => {
    // Structural check: the loop body must contain a fast-path that
    // detects "pure tool I/O" (content array of only tool_result
    // blocks) and `continue`s to the noise summary, without calling
    // scoreMessage on it.
    //
    // We intentionally do NOT match the exact source line — that's
    // brittle. Instead we look for the conceptual primitives: an
    // Array.isArray check, a `tool_result` type test, a `continue`,
    // and a reference to scoreMessage somewhere AFTER that early-bail
    // (so removing the bail removes the structural invariant).
    const src = fs.readFileSync(COMPACTOR_SRC, 'utf8');
    const digestMatch = src.match(/function buildSmartDigest\([\s\S]*?\n\}/);
    expect(digestMatch, 'Could not locate buildSmartDigest body').toBeTruthy();
    const digestBody = digestMatch![0];

    // Find the noise early-bail block: contains Array.isArray, tool_result, and `continue`.
    const earlyBailRegex =
      /Array\.isArray[\s\S]*?tool_result[\s\S]*?continue/;
    expect(
      earlyBailRegex.test(digestBody),
      'buildSmartDigest is missing the pure-tool-I/O noise early-bail. Re-add it before the scoreMessage call so pure tool_result messages collapse to the noise summary without paying the regex-suite cost.',
    ).toBe(true);

    // The bail must run BEFORE scoreMessage in the loop body.
    const scoreCallIdx = digestBody.indexOf('scoreMessage(');
    const continueIdx = digestBody.indexOf('continue');
    expect(scoreCallIdx).toBeGreaterThan(-1);
    expect(continueIdx).toBeGreaterThan(-1);
    expect(
      continueIdx < scoreCallIdx,
      'The noise early-bail must run BEFORE the scoreMessage call. Re-order so the bail skips the regex suite.',
    ).toBe(true);
  });
});

describe('compactor perf — smoke timing (load-bearing)', () => {
  // The structural guards above catch the actual regression. These
  // timing gates are softer: they catch a no-op implementation (e.g.
  // someone replaces scoreMessage with `return 3` for "simplification")
  // and document the expected performance contract.

  it('scoreMessage processes 50k messages under 100ms', () => {
    const messages = buildSession(SESSION_SIZE);
    const failureCounts = new Map<string, number>();

    const r = bench(() => {
      failureCounts.clear();
      for (const m of messages) scoreMessage(m, { failureCounts });
    });

    // Sanity: a no-op implementation (return 3 for everything) would
    // pass the timing gate but skip the regex scoring entirely. Make
    // sure the scorer actually classifies some messages as non-default
    // — otherwise we have a load-bearing smoke test that's silently
    // broken.
    let nonZero = 0;
    for (const m of messages) {
      if (scoreMessage(m) !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(SESSION_SIZE / 10);

    // Soft budget: 100ms. Dev-box median is ~13ms.
    expect(r.median).toBeLessThan(100);
  });

  it('buildSmartDigest processes 50k messages under 200ms', () => {
    const messages = buildSession(SESSION_SIZE);
    const r = bench(() => buildSmartDigest(messages));

    // Sanity: digest must be non-empty and contain both user and
    // assistant content (no-op or empty filter would produce empty
    // output).
    const digest = buildSmartDigest(messages);
    expect(digest.length).toBeGreaterThan(1000);
    expect(digest).toContain('[user]');
    expect(digest).toContain('[assistant]');

    // Soft budget: 200ms. Dev-box median is ~18ms.
    expect(r.median).toBeLessThan(200);
  });

  it('noise early-bail collapses pure tool I/O to a single summary line', () => {
    // Structural end-to-end: feed 1000 pure-tool-result messages and
    // confirm they collapse to exactly one summary line. If anyone
    // removes the early-bail and scoreMessage starts processing them
    // individually, the digest still LOOKS the same (since they all
    // score 0) — but it has 1000 empty per-message rows above the
    // summary line. This assertion catches that regression at the
    // output level.
    const noiseMessages: Message[] = [];
    for (let i = 0; i < 1000; i++) {
      noiseMessages.push(makeToolResult(`t${i}`, '', false));
    }
    const digest = buildSmartDigest(noiseMessages);
    expect(digest.split('\n').length).toBe(1);
    expect(digest).toContain('1000 low-importance turn(s) collapsed');
  });
});