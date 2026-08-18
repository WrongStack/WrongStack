/**
 * Scope discipline is a directive, not prose — it survives prompt rewrites.
 *
 * `instructions/*.md` gets re-optimized for tokens periodically. Prose is fair
 * game; these anchors are not. Every leader variant must still (a) draw the
 * task's edges before non-trivial work and (b) tell the agent to report a
 * noticed out-of-scope problem instead of fixing it — the "bug five lines
 * above the one you were asked to fix" case. A prompt that drops either half
 * reads as a licence to wander. The subagent baseline and director preamble
 * carry the same contract on the fleet side and are anchored here with the
 * cost-ladder anchors in `cost-ladder-anchors.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INSTRUCTIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'instructions');

const read = (...segments: string[]) => readFileSync(join(INSTRUCTIONS, ...segments), 'utf8');

const SYSTEM = read('system.md');
const PRO = read('system-pro.md');
const LITE = read('system-lite.md');
const SUBAGENT = read('coordination', 'subagent-baseline.md');
const DIRECTOR = read('coordination', 'director-preamble.md');

const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('scope discipline anchors', () => {
  it.each([
    ['system.md', SYSTEM],
    ['system-pro.md', PRO],
  ])('%s announces the task edges before non-trivial work', (_name, text) => {
    expect(flat(text)).toMatch(/Announce the edges, then act/);
    expect(flat(text)).toMatch(/what is explicitly out of scope/);
  });

  it.each([
    ['system.md', SYSTEM],
    ['system-pro.md', PRO],
  ])('%s tells the agent to report noticed out-of-scope problems, not fix them', (_name, text) => {
    const flatText = flat(text);
    expect(flatText).toMatch(/do not fix it/);
    expect(flatText).toMatch(/name it in your final summary as an observation/);
  });

  it('system-lite.md keeps a compressed edge statement and report-only rule', () => {
    const flatText = flat(LITE);
    expect(flatText).toMatch(/what is in scope and what is not/);
    expect(flatText).toMatch(/report it in your summary instead of fixing it/);
  });

  it('subagent-baseline.md keeps the hard boundary contract and its reporting home', () => {
    const flatText = flat(SUBAGENT);
    expect(flatText).toContain('TASK BOUNDARY');
    expect(flatText).toMatch(/hard contract/);
    expect(flatText).toMatch(/report it back instead of doing it/);
    // Noticed-but-untouched issues need a designated place in the result, or
    // they silently evaporate between the worker and the Director.
    expect(flatText).toMatch(/out-of-scope observations/);
  });

  it('director-preamble.md still teaches boundary decomposition at assignment time', () => {
    expect(flat(DIRECTOR)).toMatch(/reject any call without an explicit `scope`/);
    expect(flat(DIRECTOR)).toMatch(/not decomposed enough/);
  });
});
