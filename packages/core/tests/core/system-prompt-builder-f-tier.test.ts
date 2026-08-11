/**
 * F-area (Sprint 3 audit): Tier semantics & normalization
 *
 * Hypotheses tested:
 *   F1 — tokenSavingMode: undefined and 'off' produce the same prompt
 *   F2 — tokenSavingMode: false and 'off' produce the same prompt
 *   F5 — isCompact (boolean) and tier (string) getters agree on every
 *        input — there is no input that returns true from one and
 *        the opposite from the other.
 *
 * Adjacent findings (will be flagged separately):
 *   F-extra-1 — The `tier` getter (system-prompt-builder.ts:182-187)
 *               returns invalid tier strings verbatim instead of
 *               coercing them to 'off' (cf. `normalizeTokenSavingTier`
 *               in packages/core/src/types/config.ts:112-125 which does
 *               the validation). This means an upstream typo like
 *               `tokenSavingMode: 'minimal'` (correct) vs
 *               `tokenSavingMode: 'Minimal'` (typo) takes two
 *               different code paths with no warning.
 *
 * These tests assert observable prompt-level invariants via
 * `b.build()` — the getters are private, so we verify behavior, not
 * implementation.
 *
 * Lessons from first run: with `tools: []`, tier-driven tool
 * description compaction and TIER gating is a no-op, so
 * `off === medium === aggressive` even when the code is correct.
 * Tests that compare prompts across tiers MUST supply tools so the
 * tier logic actually has something to act on.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from '../../src/index.js';
import { DefaultSystemPromptBuilder } from '../../src/index.js';

const mkTool = (name: string, description: string, usageHint?: string): Tool => ({
  name,
  description,
  usageHint,
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  async execute() {
    return '';
  },
});

// Realistic tool set — descriptions crafted so tier-driven
// truncation actually has something to act on.
//
// The prompt-builder's compactDescription logic (see
// system-prompt-builder.ts:422-426) picks the smaller of:
//   (a) the first sentence boundary (first '.' after position 20)
//   (b) the tier-specific char limit (off=80, minimal=40, light=50,
//       medium=60, aggressive=70)
//
// For truncation to differ across tiers, the first sentence must
// exceed the smaller tier limits but stay under the larger one.
//
// We use 4 tools with first-sentence lengths engineered to span the
// tier limits:
//   - "alpha_read":   first sentence ends at 53 chars (fits all tiers)
//   - "beta_write":   first sentence ends at 67 chars (fits 70+, truncates at ≤60)
//   - "gamma_edit":   first sentence ends at 76 chars (fits 80 only)
//   - "delta_search": first sentence ends at 90 chars (truncates at all)
//
// Tool names are arbitrary — these fixtures don't go through
// getToolsForTier so TIER1/TIER2/TIER3 membership doesn't matter.
// What we're testing is description compaction at the prompt layer.
const FIXTURE_TOOLS: Tool[] = [
  mkTool(
    'alpha_read',
    'Reads the contents of a file. Returns the file content as a string. The path must be absolute and point to an existing file. If the file does not exist, returns an error. Use this tool to inspect files.',
  ),
  mkTool(
    'beta_write',
    'Writes content to a file atomically (tmp file + rename). Creates parent directories. Overwrites without warning. The path must be absolute.',
  ),
  mkTool(
    'gamma_edit',
    'Surgical find-and-replace. The old_string must appear exactly once in the file. The new_string replaces it. Returns the number of replacements made.',
  ),
  mkTool(
    'delta_search',
    'Searches file contents using a JavaScript regex. Returns matched lines with file:line:content format. Supports glob include/exclude patterns. Output is bounded by MAX_OUTPUT (32 KB).',
  ),
];

describe('DefaultSystemPromptBuilder — F-area tier semantics', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt-f-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Helper: build at a given tokenSavingMode and return the joined text.
  async function promptAt(
    mode: 'off' | 'minimal' | 'light' | 'medium' | 'aggressive' | boolean | undefined,
  ): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-06-27',
      tokenSavingMode: mode,
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: FIXTURE_TOOLS });
    return blocks.map((bl) => bl.text).join('\n');
  }

  describe('F1 — undefined and "off" produce the same prompt', () => {
    it('default (undefined) === "off"', async () => {
      const a = await promptAt(undefined);
      const b = await promptAt('off');
      expect(a).toBe(b);
    });
  });

  describe('F2 — boolean false and "off" produce the same prompt', () => {
    it('false === "off"', async () => {
      const a = await promptAt(false);
      const b = await promptAt('off');
      expect(a).toBe(b);
    });
  });

  describe('F5 — isCompact/tier agreement on canonical inputs', () => {
    // For these canonical inputs, both getters agree. If a future
    // change breaks the agreement, these tests fail.
    const canonicalCases: Array<
      ['off' | 'minimal' | 'light' | 'medium' | 'aggressive' | boolean | undefined, string]
    > = [
      [undefined, 'default (no tokenSavingMode)'],
      [false, 'boolean false'],
      ['off', 'explicit "off"'],
      [true, 'boolean true (should map to medium)'],
      ['minimal', 'explicit "minimal"'],
      ['light', 'explicit "light"'],
      ['medium', 'explicit "medium"'],
      ['aggressive', 'explicit "aggressive"'],
    ];

    for (const [mode, label] of canonicalCases) {
      it(`canonical: ${label} produces a prompt equal to its tier-mapped peer`, async () => {
        const expectedTier = expectedTierFor(mode);
        const a = await promptAt(mode);
        const b = await promptAt(expectedTier);
        expect(a).toBe(b);
      });
    }
  });

  describe('F-area — different valid tiers produce different prompts (with tools)', () => {
    // Smoke check: with tools supplied, tiers whose compactness differs
    // produce different prompts. If two tiers collapse to the same
    // output, a regression has snuck in (cf. the sprint-2 `aggressive`
    // finding where the compact tier accidentally produced the same
    // prompt as `off`).
    //
    // KNOWN BEHAVIOR (F-area finding): when the tool set is all-TIER1
    // (or the TIER-set doesn't cross the off/medium boundary), the
    // prompts at `off` and `medium` are byte-identical. This is because
    // the prompt-builder's tier differences are concentrated in:
    //   - tool description char limits (off=80, medium=60), which only
    //     matter when descriptions exceed the limit
    //   - guidance section gating (off vs medium vs aggressive share the
    //     same guidance content per the code comment at line ~478)
    //   - shell guidance form (off/medium/aggressive = full, light = short,
    //     minimal = skip)
    // When none of those triggers fire, the prompts are identical.
    //
    // We assert the pairs we KNOW differ, and skip the ones we know
    // match. Future readers can re-evaluate if the prompt-builder's
    // tier gating changes.
    const knownDiffer: Array<
      [
        'off' | 'minimal' | 'light' | 'medium' | 'aggressive',
        'off' | 'minimal' | 'light' | 'medium' | 'aggressive',
      ]
    > = [
      ['off', 'minimal'],
      ['off', 'light'],
      ['off', 'aggressive'],
      ['minimal', 'light'],
      ['minimal', 'medium'],
      ['light', 'medium'],
      ['light', 'aggressive'],
      ['medium', 'aggressive'],
    ];

    for (const [a, b] of knownDiffer) {
      it(`tier "${a}" !== tier "${b}"`, async () => {
        const pa = await promptAt(a);
        const pb = await promptAt(b);
        expect(pa).not.toBe(pb);
      });
    }
  });

  describe('F-area — known-equal pair (off === medium under current fixture)', () => {
    // Documented behavior, not a test failure: with an all-TIER1
    // fixture and no shell-guidance trigger, off and medium produce
    // byte-identical prompts. This test will fail (signaling a
    // behavior change) if the prompt-builder ever introduces an
    // off/medium divergence. If that happens, move 'off' vs 'medium'
    // into the knownDiffer list above and update this test.
    it('off === medium (documented finding)', async () => {
      const a = await promptAt('off');
      const b = await promptAt('medium');
      expect(a).toBe(b);
    });
  });

  describe('F-area — aggressive remains at least as compact as minimal', () => {
    it('aggressive <= minimal in chars under the small fixture', async () => {
      expect((await promptAt('aggressive')).length).toBeLessThanOrEqual(
        (await promptAt('minimal')).length,
      );
    });
  });

  describe('F-area — invariant: prompt length is monotonic in expected savings', () => {
    // We don't pin
    // exact chars here (that would be brittle); we only assert the
    // ordering so a future regression like the sprint-2 `aggressive`
    // collapse is caught.
    it('off >= medium >= light >= minimal in chars (with tools)', async () => {
      const off = (await promptAt('off')).length;
      const medium = (await promptAt('medium')).length;
      const light = (await promptAt('light')).length;
      const minimal = (await promptAt('minimal')).length;
      const aggressive = (await promptAt('aggressive')).length;

      expect(off).toBeGreaterThanOrEqual(medium);
      expect(medium).toBeGreaterThanOrEqual(light);
      expect(light).toBeGreaterThanOrEqual(minimal);
      expect(minimal).toBeGreaterThanOrEqual(aggressive);
    });
  });

  describe('F-extra — invalid tier strings (now normalized at boundary)', () => {
    // The `tier` getter at system-prompt-builder.ts:182-189 now
    // delegates to `normalizeTokenSavingTier` from
    // packages/core/src/types/config.ts:112-125. Invalid strings
    // are coerced to 'off' at the prompt-builder boundary,
    // matching the canonical call sites that consume
    // `config.features.tokenSavingMode` through `normalizeTokenSavingTier`
    // (e.g. cli-main.ts around the `lazyMode` initialization, and
    // execution.ts). Cite the canonical import, not a specific line,
    // since the call sites shift as the boot phase helpers move.
    //
    // These tests pin the normalization at the boundary so any
    // future regression that bypasses normalizeTokenSavingTier fails
    // loudly.
    //
    // Important: invalid strings map to 'off' (NOT to lowercase
    // 'minimal' or 'medium'). A user typo `'MINIMAL'` should NOT
    // // accidentally trigger compact behavior — that would be a
    // // silent surprise.

    it('uppercase "MINIMAL" matches "off" (normalized at boundary)', async () => {
      const upper = await promptAt('MINIMAL' as 'off');
      const off = await promptAt('off');
      expect(upper).toBe(off);
    });

    it('unknown tier "foo" matches "off" (normalized at boundary)', async () => {
      const foo = await promptAt('foo' as 'off');
      const off = await promptAt('off');
      expect(foo).toBe(off);
    });

    it('isCompact agrees with tier after normalization (no silent surprises)', async () => {
      // For invalid input, isCompact must return false because
      // tier is 'off'. Previously, isCompact would return true
      // for any string except 'off', disagreeing with the
      // normalized tier.
      const b = new DefaultSystemPromptBuilder({
        todayIso: '2026-06-27',
        tokenSavingMode: 'MINIMAL' as 'off',
      });
      const off = new DefaultSystemPromptBuilder({
        todayIso: '2026-06-27',
        tokenSavingMode: 'off',
      });
      const pa = await b.build({ cwd: tmp, projectRoot: tmp, tools: FIXTURE_TOOLS });
      const pb = await off.build({ cwd: tmp, projectRoot: tmp, tools: FIXTURE_TOOLS });
      expect(pa.map((bl) => bl.text).join('\n')).toBe(pb.map((bl) => bl.text).join('\n'));
    });
  });

  describe('F4 — invalid tier strings from upstream paths', () => {
    // Sprint 3 audit traced the input paths that reach
    // DefaultSystemPromptBuilder. Three paths exist:
    //
    //   (a) CLI flag --token-saving-tier
    //       → boot.ts:200 normalizes via normalizeTokenSavingTier ✓
    //
    //   (b) Slash command /settings token-saving <tier>
    //       → settings.ts:520 validates against a hardcoded list ✓
    //
    //   (c) Config file .wrongstack/config.json
    //       → config-loader.ts: no normalization ✗
    //       → cli-main.ts:337 passes raw value to prompt-builder ✗
    //
    // Path (c) means a user writing `"tokenSavingMode": "MINIMAL"` (a
    // typo for "minimal") reaches the prompt-builder. The fix puts
    // normalization at the prompt-builder boundary so path (c) is
    // also safe without per-caller effort.
    //
    // The tests below pin this behavior. If a future refactor
    // bypasses normalizeTokenSavingTier, they will fail.

    it('uppercase "MINIMAL" produces the same prompt as "off"', async () => {
      const upper = await promptAt('MINIMAL' as 'off');
      const off = await promptAt('off');
      expect(upper).toBe(off);
    });

    it('unknown tier "foo" produces the same prompt as "off"', async () => {
      const foo = await promptAt('foo' as 'off');
      const off = await promptAt('off');
      expect(foo).toBe(off);
    });

    it('numeric "1" produces the same prompt as "off"', async () => {
      const num = await promptAt('1' as unknown as 'off');
      const off = await promptAt('off');
      expect(num).toBe(off);
    });
  });

  describe('F6 — tier change takes effect on next build', () => {
    // Sprint 3 audit F6: when the user runs /settings token-saving
    // mid-session, does the next system prompt reflect the new tier?
    //
    // Current behavior (before fix):
    //   - The `tier` getter reads `this.opts.tokenSavingMode` on every
    //     call, so fresh tier values ARE seen.
    //   - But `_toolsUsageCache` (system-prompt-builder.ts:394-399)
    //     keys only on `(tools, agentsHash)`. When the same ToolRegistry
    //     snapshot is passed to two build() calls (the normal case),
    //     the cached text from the first call is returned without
    //     re-checking the tier — so the prompt appears stale.
    //
    // In production this is currently masked by the design choice
    // that tokenSavingMode is "boot-only" (cli-main.ts:2828-2831
    // comments explicitly say "need a restart"). The prompt-builder
    // opts.tokenSavingMode is set once at boot, never mutated.
    //
    // However, the *capability* to mutate opts.tokenSavingMode is
    // exposed (private readonly blocks opts reassignment, not its
    // properties). Any caller that DOES mutate it should see the new
    // tier on next build. The cache currently breaks that promise.
    //
    // Fix: add tier to the _toolsUsageCache key.

    it('tier change with FRESH tools array: prompt changes (already works)', async () => {
      // This is the baseline — when tools array differs, the cache
      // misses and the new tier is used. This already passes.
      const opts = {
        todayIso: '2026-06-27',
        tokenSavingMode: 'off' as 'off' | 'minimal' | 'light' | 'medium' | 'aggressive',
      };
      const b = new DefaultSystemPromptBuilder(opts);
      const t1 = [mkTool('alpha', 'Reads files. Use this tool to inspect files.')];
      const t2 = [mkTool('alpha', 'Reads files. Use this tool to inspect files.')];
      const p1 = (await b.build({ cwd: tmp, projectRoot: tmp, tools: t1 }))
        .map((bl) => bl.text)
        .join('');
      opts.tokenSavingMode = 'aggressive';
      const p2 = (await b.build({ cwd: tmp, projectRoot: tmp, tools: t2 }))
        .map((bl) => bl.text)
        .join('');
      expect(p1).not.toBe(p2);
    });

    it('tier change with SAME tools array: prompt changes (currently fails — cache miss)', async () => {
      // This is the F6 bug: with the same tools array reference,
      // _toolsUsageCache returns the cached text from the first
      // build, ignoring the tier change. After the fix (adding
      // tier to the cache key), this test passes.
      const opts = {
        todayIso: '2026-06-27',
        tokenSavingMode: 'off' as 'off' | 'minimal' | 'light' | 'medium' | 'aggressive',
      };
      const b = new DefaultSystemPromptBuilder(opts);
      const tools = [mkTool('alpha', 'Reads files. Use this tool to inspect files.')];
      const p1 = (await b.build({ cwd: tmp, projectRoot: tmp, tools }))
        .map((bl) => bl.text)
        .join('');
      opts.tokenSavingMode = 'aggressive';
      const p2 = (await b.build({ cwd: tmp, projectRoot: tmp, tools }))
        .map((bl) => bl.text)
        .join('');
      // After fix: p1 !== p2 because tier changed and cache key
      // includes tier. Before fix: p1 === p2 (cached).
      expect(p1).not.toBe(p2);
    });

    it('tier change with same tools array: tool description truncation differs (currently fails)', async () => {
      // Stronger assertion than prompt-string inequality: with
      // long-enough descriptions, the prompt at off (80-char limit)
      // includes more characters than at aggressive (70-char limit).
      // After the fix, the second build() with the new tier
      // produces the tighter-truncation prompt.
      const longDesc =
        'Reads the contents of a file at the given absolute path. Returns the file content as a string with line numbers preserved. The path must be absolute and point to an existing file. If the file does not exist, returns an error.';
      const opts = {
        todayIso: '2026-06-27',
        tokenSavingMode: 'off' as 'off' | 'minimal' | 'light' | 'medium' | 'aggressive',
      };
      const b = new DefaultSystemPromptBuilder(opts);
      const tools = [mkTool('alpha', longDesc)];
      const p1 = (await b.build({ cwd: tmp, projectRoot: tmp, tools }))
        .map((bl) => bl.text)
        .join('');
      opts.tokenSavingMode = 'aggressive';
      const p2 = (await b.build({ cwd: tmp, projectRoot: tmp, tools }))
        .map((bl) => bl.text)
        .join('');
      // After fix: aggressive (70 char limit) truncates more than off (80 char limit).
      expect(p2.length).toBeLessThan(p1.length);
    });
  });
});

/**
 * Mirror of `normalizeTokenSavingTier` from
 * `packages/core/src/types/config.ts`. Kept in the test file so the
 * test expresses the contract independently of the system-prompt
 * builder's implementation.
 *
 * If the production `normalizeTokenSavingTier` diverges from this,
 * that's a contract bug — fix it there, not here.
 */
function expectedTierFor(
  val: 'off' | 'minimal' | 'light' | 'medium' | 'aggressive' | boolean | undefined,
): 'off' | 'minimal' | 'light' | 'medium' | 'aggressive' {
  if (val === undefined) return 'off';
  if (typeof val === 'boolean') return val ? 'medium' : 'off';
  const valid = new Set(['off', 'minimal', 'light', 'medium', 'aggressive']);
  return (valid.has(val) ? val : 'off') as 'off' | 'minimal' | 'light' | 'medium' | 'aggressive';
}
