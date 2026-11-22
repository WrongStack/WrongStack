import { describe, expect, it } from 'vitest';
import { mergeIntoChangelog } from '../src/changelog-writer/changelog-format.js';

const FOOTER = [
  '[Unreleased]: https://github.com/o/r/compare/v0.0.0...HEAD',
  '[0.0.0]: https://github.com/o/r/releases/tag/v0.0.0',
].join('\n');

// F1119: with no released version below `## [Unreleased]`, the Keep a
// Changelog link-reference footer was parsed as part of the Unreleased body:
// glued onto the last bullet as a continuation line and moved mid-list.
describe('mergeIntoChangelog link-reference footer', () => {
  it('keeps the footer as the final paragraph of an unreleased-only changelog', () => {
    const existing = `# Changelog\n\n## [Unreleased]\n\n### Added\n- foo\n\n${FOOTER}\n`;
    const out = mergeIntoChangelog(existing, '### Fixed\n- bar');
    expect(out).toBe(
      `# Changelog\n\n## [Unreleased]\n\n### Added\n- foo\n\n### Fixed\n- bar\n\n${FOOTER}\n`,
    );
  });

  it('stays stable across repeated merges', () => {
    let out = `# Changelog\n\n## [Unreleased]\n\n${FOOTER}\n`;
    out = mergeIntoChangelog(out, '### Added\n- one');
    out = mergeIntoChangelog(out, '### Added\n- two');
    expect(out).toBe(`# Changelog\n\n## [Unreleased]\n\n### Added\n- two\n- one\n\n${FOOTER}\n`);
  });

  it('leaves a footer below a released version untouched', () => {
    const existing = `# Changelog\n\n## [Unreleased]\n\n## [0.0.0]\n- first\n\n${FOOTER}\n`;
    expect(mergeIntoChangelog(existing, '### Added\n- x')).toBe(
      `# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n## [0.0.0]\n- first\n\n${FOOTER}\n`,
    );
  });
});
