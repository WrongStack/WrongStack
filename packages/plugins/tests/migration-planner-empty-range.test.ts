import { describe, expect, it } from 'vitest';
import {
  extractBreakingChanges,
  extractVersionSections,
} from '../src/migration-planner/changelog-parsing.js';

const CHANGELOG = [
  '# Changelog',
  '## [2.0.0] - 2024-01-01',
  '### BREAKING CHANGES',
  '- Removed legacy API `foo()`',
  '## [1.0.0] - 2023-01-01',
  '### BREAKING CHANGES',
  '- Initial stable release',
].join('\n');

function breaking(from: string, to: string): string[] {
  return extractBreakingChanges(extractVersionSections(CHANGELOG, from, to).join('\n\n'));
}

// F1116: when both versions parse but no listed release lies in (from, to],
// the whole changelog came back and every historical breaking change was
// attributed to an upgrade that crosses none of them.
describe('migration-planner version range with no listed release', () => {
  it('attributes nothing to an upgrade past the newest listed release', () => {
    expect(extractVersionSections(CHANGELOG, '2.0.0', '2.1.0')).toEqual([]);
    expect(breaking('^2.0.0', '2.1.0')).toEqual([]);
  });

  it('attributes nothing when from equals to', () => {
    expect(breaking('2.0.0', '2.0.0')).toEqual([]);
  });

  it('still selects the releases inside a populated range', () => {
    expect(breaking('1.0.0', '2.1.0')).toEqual(['Removed legacy API `foo()`']);
  });

  it('keeps the whole text for a changelog without version headings', () => {
    expect(extractVersionSections('free-form notes', '1.0.0', '2.0.0')).toEqual([
      'free-form notes',
    ]);
  });
});
