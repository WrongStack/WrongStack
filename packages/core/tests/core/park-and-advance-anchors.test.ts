/**
 * Short task guidance must preserve both progress and accountability.
 * The tool schema owns lifecycle mechanics; blocked work must neither loop
 * unchanged nor disappear from the request's tracked scope.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expandSharedSystemInstructions } from '../../src/utils/instruction-file.js';

const INSTRUCTIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'instructions');

const read = (...segments: string[]) =>
  expandSharedSystemInstructions(readFileSync(join(INSTRUCTIONS, ...segments), 'utf8')).replace(
    /\s+/g,
    ' ',
  );

const VARIANTS = [
  ['system.md', read('system.md')],
  ['system-pro.md', read('system-pro.md')],
  ['system-lite.md', read('system-lite.md')],
] as const;

describe('park-and-advance anchors', () => {
  it.each(VARIANTS)('%s keeps completion evidence-based', (_name, text) => {
    expect(text).toContain('mark unverified work Done');
    expect(text).toContain('verification truthful');
  });

  it.each(VARIANTS)('%s keeps both halves of the rule', (_name, text) => {
    expect(text).toContain('do not stack speculative patches or repeat identical calls');
    expect(text).toContain('resolve its cause or advance other ready work');
  });

  it.each(VARIANTS)('%s keeps blockers from becoming a scope escape', (_name, text) => {
    expect(text).toContain('do not drop unfinished requirements');
    expect(text).toContain('Blocked work stays open');
    expect(text).toContain('without abandoning it');
  });

  it('the full variants preserve dependency and progress accountability', () => {
    for (const [name, text] of VARIANTS.filter(([variant]) => variant !== 'system-lite.md')) {
      expect(text, name).toContain('scope, dependencies, progress, and verification truthful');
    }
  });

  it('no variant tells the agent to set blocked status by hand', () => {
    // Managed boards derive status from the lifecycle stage and
    // assertManagedTaskPatchAllowed throws on an out-of-band status write, so
    // an instruction to "update_task status: blocked" would be unfollowable on
    // exactly the boards where the wedge is worst. The engine parks; the agent
    // moves on.
    for (const [name, text] of VARIANTS) {
      // Case-insensitive on purpose: the prose that slipped past an earlier
      // version of this guard read "Set `status: blocked` via `update_task`" —
      // capital S and "via" were the only reasons it matched neither pattern.
      expect(text, name).not.toMatch(
        /status: ?`?blocked`? (with|via|through|using) `?update_task/i,
      );
      expect(text, name).not.toMatch(/set `?status: ?`?blocked`?/i);
    }
  });

  it('the subagent baseline routes a repeated refusal into partial completion', () => {
    const baseline = read('coordination', 'subagent-baseline.md');
    expect(baseline).toContain('refuses the same work twice');
    expect(baseline).toContain('completion:"partial"');
    expect(baseline).toMatch(/third identical attempt is never the answer/);
  });
});
