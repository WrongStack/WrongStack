/**
 * Park-and-advance is a directive, not prose — it survives prompt rewrites.
 *
 * The rule has two halves and a trim that keeps only the first one inverts it.
 * "Stop retrying a refused card" alone reads as permission to drop the work;
 * "keep working" alone reads as permission to loop. Both must stay, in every
 * identity variant, alongside the clause that parking never sheds scope.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INSTRUCTIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'instructions');

const read = (...segments: string[]) =>
  readFileSync(join(INSTRUCTIONS, ...segments), 'utf8').replace(/\s+/g, ' ');

const VARIANTS = [
  ['system.md', read('system.md')],
  ['system-pro.md', read('system-pro.md')],
  ['system-lite.md', read('system-lite.md')],
] as const;

describe('park-and-advance anchors', () => {
  it.each(VARIANTS)('%s states that verification gates Done, not progress', (_name, text) => {
    expect(text).toContain('Two refusals park the card');
    expect(text).toMatch(/[Vv]erification guards \*?Done\*?, not \*?progress\*?/);
  });

  it.each(VARIANTS)('%s keeps both halves of the rule', (_name, text) => {
    // Half one: stop retrying the refused card.
    expect(text).toMatch(/never retry a parked card unchanged|retry a parked card|do not argue/i);
    // Half two: keep working. Without this the rule reads as permission to quit.
    expect(text).toContain('next ready card');
  });

  it.each(VARIANTS)('%s keeps parking from becoming a scope escape', (_name, text) => {
    expect(text).toMatch(/never sheds scope|never a way to shed scope/);
    expect(text).toMatch(/not Done, not abandoned/);
  });

  it('the full variants explain what to do about a parked dependency', () => {
    for (const [name, text] of VARIANTS.filter(([variant]) => variant !== 'system-lite.md')) {
      expect(text, name).toContain('parked dependency');
      expect(text, name).toContain('dependsOn');
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
      expect(text, name).not.toMatch(/status: ?`?blocked`? (with|via|through|using) `?update_task/i);
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
