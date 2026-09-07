/**
 * H-8 (AT-01) — project-committed sections and leader-after-task get the
 * same `<project-supplied-instructions>` fence the identity layer has.
 *
 * `<project>/.wrongstack/instructions/sections/*.md` and
 * `<project>/.wrongstack/instructions/leader-after-task.md` are
 * repo-committed and therefore untrusted. The identity channel (WS-016)
 * was hardened for this exact threat; the sections and leader-after-task
 * channels were missed and rendered raw. Filename → key mapping is
 * mechanical (`instruction-bundle.ts:176-178`), so a single
 * `sections/<key>.md` in a cloned repo takes over a slot the genuine
 * bundled section would occupy.
 */
import { describe, expect, it } from 'vitest';
import { instructionSection } from '../../src/core/system-prompt-blocks.js';
import type { InstructionBundle } from '../../src/core/instruction-bundle.js';

const BUNDLED_BUNDLE: InstructionBundle = {
  sections: { 'commit-hygiene': 'bundled commit hygiene' },
  sectionsSource: 'bundled',
};
const PROJECT_BUNDLE: InstructionBundle = {
  sections: { 'commit-hygiene': 'PROJECT commit hygiene override' },
  sectionsSource: 'project',
};
const FILE_BUNDLE: InstructionBundle = {
  sections: { 'commit-hygiene': 'file-based commit hygiene' },
  sectionsSource: 'file',
};

describe('instructionSection — provenance fence (H-8)', () => {
  it('returns the section body unchanged when source is bundled', () => {
    expect(instructionSection(BUNDLED_BUNDLE, 'commit-hygiene')).toBe('bundled commit hygiene');
  });

  it('returns the section body unchanged when source is global', () => {
    const globalBundle: InstructionBundle = {
      sections: { 'commit-hygiene': 'global commit hygiene' },
      sectionsSource: 'global',
    };
    expect(instructionSection(globalBundle, 'commit-hygiene')).toBe('global commit hygiene');
  });

  it('fences the section body when source is project (H-8)', () => {
    const out = instructionSection(PROJECT_BUNDLE, 'commit-hygiene');
    expect(out).toContain('<project-supplied-instructions');
    expect(out).toContain('commit-hygiene');
    expect(out).toContain('PROJECT commit hygiene override');
    expect(out).toContain('</project-supplied-instructions>');
  });

  it('fences the section body when source is file (H-8)', () => {
    const out = instructionSection(FILE_BUNDLE, 'commit-hygiene');
    expect(out).toContain('<project-supplied-instructions');
    expect(out).toContain('file-based commit hygiene');
  });

  it('returns empty string when the section key is not in the bundle', () => {
    expect(instructionSection(PROJECT_BUNDLE, 'not-a-real-key')).toBe('');
  });
});
