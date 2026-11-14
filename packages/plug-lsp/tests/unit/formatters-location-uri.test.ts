import { describe, expect, it } from 'vitest';
import { formatLocations } from '../../src/formatters/location.js';

const cwd = process.cwd();

const range = (line: number, character: number) => ({
  start: { line, character },
  end: { line, character: character + 1 },
});

// Regression: formatLocations called fileURLToPath unconditionally, so a
// custom-scheme target (`jdt:`, `vscode-remote:`) threw and discarded the whole
// definition/reference result.
describe('formatLocations with non-file URIs', () => {
  it('reports custom-scheme locations instead of throwing', () => {
    const jdt = formatLocations(
      [{ uri: 'jdt://contents/java.base/java.lang/String.class', range: range(4, 2) }] as never,
      cwd,
    );
    expect(jdt).toBe('jdt://contents/java.base/java.lang/String.class:5:3');

    const remote = formatLocations(
      [
        {
          targetUri: 'vscode-remote://ssh-remote%2Bhost/home/u/x.ts',
          targetRange: range(0, 0),
          targetSelectionRange: range(1, 0),
        },
      ] as never,
      cwd,
    );
    expect(remote).toBe('vscode-remote://ssh-remote%2Bhost/home/u/x.ts:2:1');
  });

  it('still formats file: URIs and the empty case', () => {
    const file = formatLocations(
      [{ uri: 'file:///C:/tmp/demo.ts', range: range(4, 2) }] as never,
      cwd,
    );
    expect(file).toContain('demo.ts:5:3');
    expect(formatLocations(null, cwd)).toBe('No locations found.');
  });

  it('clamps negative and NaN limits instead of reporting inflated truncation (F246)', () => {
    const locs = [
      { uri: 'file:///tmp/a.ts', range: range(0, 0) },
      { uri: 'file:///tmp/b.ts', range: range(1, 0) },
      { uri: 'file:///tmp/c.ts', range: range(2, 0) },
    ] as never;
    expect(formatLocations(locs, '/tmp', -1)).toBe('... truncated 3 more');
    const nanOut = formatLocations(locs, '/tmp', Number.NaN);
    expect(nanOut).toContain('a.ts:1:1');
    expect(nanOut).toContain('c.ts:3:1');
  });
});
