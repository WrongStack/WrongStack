/**
 * The cost ladder is a directive, not prose — it survives prompt rewrites.
 *
 * `instructions/*.md` gets re-optimized for tokens periodically (the July 2026
 * sweep cut ~40%). Prose is fair game; these anchors are not. Each variant must
 * still tell the agent to exhaust reuse before writing new code, and — the half
 * that is easy to lose in a trim — that the ladder trims what the agent
 * invented rather than what the user asked for. A ladder without that clause
 * reads as a licence to under-deliver.
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

describe('cost ladder anchors', () => {
  it.each([
    ['system.md', SYSTEM],
    ['system-pro.md', PRO],
  ])('%s carries the full ladder section', (_name, text) => {
    expect(text).toContain('## The cost ladder');
    // Every rung, in order — a trim may reword them but must not drop one.
    for (const rung of [
      'Delete instead?',
      'Does it need to exist?',
      'Does this repo already do it?',
      'Does the language or runtime do it?',
      'Does the platform do it?',
      'Does an installed dependency do it?',
      'Is it one line?',
      'write the minimum that works',
    ]) {
      expect(text, rung).toContain(rung);
    }
  });

  it.each([
    ['system.md', SYSTEM],
    ['system-pro.md', PRO],
    ['system-lite.md', LITE],
    ['subagent-baseline.md', SUBAGENT],
  ])('%s keeps the scope guardrail', (_name, text) => {
    // Line wrapping differs per file; compare on flattened whitespace.
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toMatch(/trims (what \*\*you\*\* invented|code you invented)/);
    expect(flat).toMatch(/never (shrinks|the user's request)/);
  });

  it('lite carries a compressed ladder rather than the full section', () => {
    expect(LITE).toContain('The cost ladder');
    expect(LITE).not.toContain('## The cost ladder');
    expect(LITE).toContain('is it one line?');
  });

  it('subagents get the ladder without being handed the full section', () => {
    expect(SUBAGENT).toContain('the cost ladder');
    expect(SUBAGENT).toContain('smallest version');
  });

  it('gated tool mentions inside the ladder stay conditional', () => {
    // The phantom-tool guard scrapes `ws:if tool=` conditions; a backticked
    // tool name in the ladder that is not gated would leak into prompts built
    // without that tool registered.
    for (const [name, text] of [
      ['system.md', SYSTEM],
      ['system-pro.md', PRO],
    ] as const) {
      const ladder = text.slice(text.indexOf('## The cost ladder'));
      const section = ladder.slice(0, ladder.indexOf('\n## ', 1));
      for (const tool of ['codebase-search', 'detect_duplicate_code']) {
        if (!section.includes(`\`${tool}\``)) continue;
        expect(section, `${name}: ${tool}`).toContain(`<!--ws:if tool=${tool}-->`);
      }
    }
  });
});
