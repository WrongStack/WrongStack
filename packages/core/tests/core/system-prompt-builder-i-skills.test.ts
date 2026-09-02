/**
 * I-area (Sprint 3 audit): Skill body injection
 *
 * Hypotheses tested:
 *   I1 — Skill bodies injected at full length have NO size cap.
 *        Test exposes: a 1 MB skill body injected at 'off' tier
 *        bloats the prompt by ~1 MB.
 *
 *   I3 — Overlapping skill triggers: no dedup logic. Two skills
 *        with the same/overlapping trigger both appear in the
 *        Skills list block. Documented behavior.
 *
 *   I4 — Skill trigger appears in env-block (compact), full body
 *        appears in main block. Two presentation forms, both
 *        intended.
 *
 *   I5 — Compact mode (any tier where isCompact=true) bounds the
 *        skill body via readSaveBody's internal 450-char cap. A
 *        1 MB body returns ~300 chars in compact mode.
 *
 *   I6 — stripFrontmatter handles malformed YAML gracefully:
 *        - no frontmatter (returns raw)
 *        - unterminated frontmatter (returns raw — no `---` close)
 *        - malformed YAML inside frontmatter (returns body after
 *          closing marker)
 *
 * Adjacent findings (out of scope for I5 fix):
 *   - I7 path traversal: covered by sprint-2 audit E3.
 *   - I2 trigger compaction: 72-char cap at word boundary is fine,
 *     tested indirectly via trigger shape assertions.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/index.js';
import type { SkillLoader } from '../../src/index.js';

/** Build a SkillLoader mock from an in-memory skill map. */
function mkSkillLoader(
  skills: Array<{
    name: string;
    trigger?: string;
    body?: string;
    scope?: string[];
  }>,
): SkillLoader {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    list: async () =>
      skills.map((s) => ({
        name: s.name,
        description: s.trigger ?? '',
        path: `/mock/${s.name}`,
        source: 'bundled' as const,
      })),
    listEntries: async () =>
      skills.map((s) => ({
        name: s.name,
        trigger: s.trigger ?? '',
        scope: s.scope ?? [],
        source: 'bundled' as const,
        path: `/mock/${s.name}`,
      })),
    find: async (name: string) =>
      byName.has(name)
        ? {
            name,
            description: byName.get(name)!.trigger ?? '',
            path: `/mock/${name}`,
            source: 'bundled' as const,
          }
        : undefined,
    manifestText: async () => '',
    readBody: async (name: string) => byName.get(name)?.body ?? '',
    readSaveBody: async (name: string) => {
      // For tests, simulate the real loader's behavior: try SKILL.save.md,
      // fall back to a 300-char truncation of the body.
      const full = byName.get(name)?.body ?? '';
      return full.length > 300 ? full.slice(0, 300) + '…' : full;
    },
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('DefaultSystemPromptBuilder — I-area skill injection', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt-i-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function buildWithSkills(
    mode: 'off' | 'minimal' | 'light' | 'medium' | 'aggressive' | boolean | undefined,
    skills: SkillLoader,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-06-27',
      tokenSavingMode: mode,
      skillLoader: skills,
      ...extra,
    });
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [],
    });
    return blocks.map((bl) => bl.text).join('\n');
  }

  describe('I1 + I5 — skill body size: full vs compact', () => {
    // 1 MB body — realistic worst case for a misbehaving skill.
    const ONE_MB = 'x'.repeat(1_000_000);

    it('I5 fix: 1 MB skill body at "off" tier is CAPPED at MAX_SKILL_BODY_CHARS', async () => {
      // After the I5 fix (capSkillBody helper + MAX_SKILL_BODY_CHARS
      // constant), a 1 MB skill body is truncated to ~16 KB even at
      // the full (off) tier. Real-world skill files are unaffected
      // because they're <5 KB; misconfigured multi-MB files are
      // bounded so they can't bloat the prompt.
      const loader = mkSkillLoader([
        { name: 'huge-skill', trigger: 'Use when doing X.', body: ONE_MB },
      ]);
      const p = await buildWithSkills('off', loader);
      // Prompt must NOT contain the full 1 MB
      expect(p.length).toBeLessThan(100_000);
      // But the skill name IS present (the section header is emitted)
      expect(p).toContain('huge-skill');
      // And a truncation marker is present
      expect(p).toMatch(/…/);
    });

    it('I5: 1 MB skill body at "aggressive" tier is bounded by readSaveBody cap', async () => {
      // The compact path uses readSaveBody which falls back to a 300-char
      // truncation. The mock loader mirrors that behavior. Even if the
      // underlying skill file is 1 MB, the prompt sees a bounded body.
      const loader = mkSkillLoader([
        { name: 'huge-skill', trigger: 'Use when doing X.', body: ONE_MB },
      ]);
      const p = await buildWithSkills('aggressive', loader);
      // Compact form should NOT contain the full 1 MB
      expect(p.length).toBeLessThan(100_000);
      expect(p).toContain('huge-skill');
    });

    it('I5: 100 KB skill body at "medium" tier is bounded (compact path)', async () => {
      const BODY_100K = 'y'.repeat(100_000);
      const loader = mkSkillLoader([
        { name: 'medium-skill', trigger: 'Use for medium-tier testing.', body: BODY_100K },
      ]);
      const p = await buildWithSkills('medium', loader);
      // Medium uses compact path because isCompact=true (medium != 'off')
      expect(p.length).toBeLessThan(50_000);
    });

    it('I5: 100 KB skill body at "off" tier IS capped at ~16 KB (was unbounded)', async () => {
      // After the I5 fix, the off-tier path is bounded. Pre-fix this
      // would be >100 KB; post-fix the body is capped at MAX_SKILL_BODY_CHARS.
      const BODY_100K = 'y'.repeat(100_000);
      const loader = mkSkillLoader([
        { name: 'off-skill', trigger: 'Use for off-tier testing.', body: BODY_100K },
      ]);
      const p = await buildWithSkills('off', loader);
      // The body substring (100 KB of 'y') is NOT in the prompt anymore
      expect(p).not.toContain(BODY_100K);
      // And the truncated body (≤ MAX_SKILL_BODY_CHARS) is present
      // We check that the prompt contains a manageable amount of 'y' chars
      // rather than asserting exact total length (which depends on
      // the rest of the prompt content).
      const yCount = (p.match(/y/g) ?? []).length;
      // Before fix: 100_000. After fix: ~16_000 + few stragglers from
      // the trigger text. Allow 18_000 to be safe.
      expect(yCount).toBeLessThan(18_000);
    });

    it('I5: small skill body passes through unchanged (no truncation artifact)', async () => {
      // Sanity check: small skills aren't affected by the cap. A 1 KB
      // body should appear verbatim in the prompt.
      const loader = mkSkillLoader([
        { name: 'small', trigger: 'Use for testing small skills.', body: 'a'.repeat(1000) },
      ]);
      const p = await buildWithSkills('off', loader);
      // Full body appears (no ellipsis marker for small skills)
      expect(p).toContain('a'.repeat(1000));
      // But the cap didn't add an ellipsis (small body fits)
      const skillSection = p.slice(p.indexOf('## Skill: small'));
      expect(skillSection).not.toContain('…');
    });
  });

  describe('I3 — overlapping triggers do not dedup', () => {
    it('two skills with identical triggers both appear in the Skills list', async () => {
      const loader = mkSkillLoader([
        { name: 'alpha', trigger: 'Use when scanning source code.', body: 'Alpha body.' },
        { name: 'beta', trigger: 'Use when scanning source code.', body: 'Beta body.' },
      ]);
      const p = await buildWithSkills('off', loader);
      // Both names appear (no dedup on identical trigger)
      expect(p).toContain('**alpha**');
      expect(p).toContain('**beta**');
      // Both bodies appear (no shadowing)
      expect(p).toContain('Alpha body.');
      expect(p).toContain('Beta body.');
    });

    it('two skills with overlapping (not identical) triggers both appear', async () => {
      const loader = mkSkillLoader([
        { name: 'webui', trigger: 'Use when working with the webui tab.', body: 'webui body' },
        {
          name: 'webui-tabs',
          trigger: 'Use when working with the webui tab and tabs.',
          body: 'tabs body',
        },
      ]);
      const p = await buildWithSkills('off', loader);
      expect(p).toContain('**webui**');
      expect(p).toContain('**webui-tabs**');
      expect(p).toContain('webui body');
      expect(p).toContain('tabs body');
    });
  });

  describe('I4 — trigger shape vs body shape', () => {
    it('trigger appears compact in env-block, body appears verbatim in Active Skills', async () => {
      const loader = mkSkillLoader([
        {
          name: 'formatter',
          trigger: 'Use when formatting source code with biome or prettier.',
          body: '# formatter\n\nDetailed instructions about formatting code.',
        },
      ]);
      const p = await buildWithSkills('off', loader);
      // Trigger is in env-block ("Skills in scope")
      expect(p).toContain('formatter');
      // Body is in Active Skills block
      expect(p).toContain('# Active Skills');
      expect(p).toContain('## Skill: formatter');
      expect(p).toContain('Detailed instructions about formatting code.');
      // The full trigger string is in the env-block (no truncation
      // needed for short triggers — they're typically < 100 chars)
      expect(p).toContain('biome or prettier');
    });

    it('long trigger is truncated by compactTrigger to ~72 chars', async () => {
      const longTrigger =
        'Use when doing something really really long that exceeds the seventy-two character truncation limit and needs to be shortened.';
      const loader = mkSkillLoader([{ name: 'long-trigger', trigger: longTrigger, body: 'body' }]);
      const p = await buildWithSkills('off', loader);
      // The compact form drops the "Use when " prefix and truncates with …
      expect(p).toContain('…');
      // Should NOT contain the full 100+ char trigger
      const idx = p.indexOf(longTrigger);
      expect(idx).toBe(-1);
    });
  });

  describe('I6 — malformed frontmatter handling (via mock body)', () => {
    // The prompt-builder calls stripFrontmatter on the body returned
    // by readBody/readSaveBody. Since the mock loader controls the
    // raw body, this section tests the prompt-builder's response to
    // bodies that look malformed. The stripFrontmatter logic itself
    // is in system-prompt-builder.ts:1187-1195.

    it('body without frontmatter marker passes through verbatim', async () => {
      const loader = mkSkillLoader([
        {
          name: 'plain',
          trigger: 'Use when no frontmatter.',
          body: '# Plain\n\nNo frontmatter at all. Just plain markdown.',
        },
      ]);
      const p = await buildWithSkills('off', loader);
      expect(p).toContain('No frontmatter at all. Just plain markdown.');
    });

    it('body with malformed frontmatter (no closing ---) is read in full', async () => {
      // If the loader returns the raw body and stripFrontmatter sees
      // an opening --- without a closing ---, it returns the raw body.
      // The mock returns the raw text, so we test that the prompt
      // contains the body verbatim regardless of internal parsing.
      const malformed = '---\nname: foo\ndescription: bar\n# Body\n\nNo closing ---';
      const loader = mkSkillLoader([
        { name: 'malformed', trigger: 'Use when testing malformed.', body: malformed },
      ]);
      const p = await buildWithSkills('off', loader);
      // Whatever the loader returns is what gets injected; the prompt
      // reflects that. The stripFrontmatter function (tested
      // separately at the unit level) handles this internally.
      expect(p).toContain('# Body');
      expect(p).toContain('No closing ---');
    });
  });

  describe('I-totals — multiple skills aggregate without dedup', () => {
    it('five skills each with 10 KB body aggregate without dedup (budget disabled)', async () => {
      // Five 10 KB skills with DISTINCT bodies so the test can verify each one
      // appears in the prompt. The default eager budget would move the overflow
      // into a manifest; here we disable it to test raw aggregation/dedup.
      const skills = Array.from({ length: 5 }, (_, i) => ({
        name: `skill${i}`,
        trigger: `Use when testing skill number ${i}.`,
        body: `body-${i}-${'z'.repeat(10_000)}`, // unique prefix per skill
      }));
      const loader = mkSkillLoader(skills);
      const p = await buildWithSkills('off', loader, { skillEagerMaxChars: 200_000 });
      // Each skill's distinct body content appears exactly once
      for (const s of skills) {
        expect(p.split(s.body).length - 1).toBe(1);
      }
      // Total body content is roughly 5 × 10 KB = 50 KB
      const totalBodyBytes = skills.reduce((n, s) => n + s.body.length, 0);
      // Prompt contains the body content but might be wrapped
      // (e.g. with `## Skill: name` headers). Just verify it's
      // there in aggregate.
      expect(p.length).toBeGreaterThan(totalBodyBytes);
    });
  });
});
