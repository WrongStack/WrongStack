import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandBraceAlternation } from '../src/_glob-braces.js';
import { globTool } from '../src/glob.js';
import { mkSandbox, type Sandbox } from './fixtures.js';

// Only 34 leaves: nested expansion must not repeat `shared` 33 times and
// spend the 64-pattern budget before reaching v32.
const inner = Array.from({ length: 33 }, (_, i) => `v${i}`).join(',');

describe('nested brace alternation', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('finds the final nested alternative through the glob tool', async () => {
    for (const name of ['file.shared', 'file.v32', 'file.unmatched']) {
      await fs.writeFile(path.join(sb.dir, name), '');
    }
    const names = async (pattern: string) =>
      (await globTool.execute({ pattern }, sb.ctx)).files.map((f) => path.basename(f)).sort();
    expect(await names('*.{shared,v32}')).toEqual(['file.shared', 'file.v32']);
    expect(await names(`*.{shared,{${inner}}}`)).toEqual(['file.shared', 'file.v32']);
  });

  it('expands nested alternatives once in branch order', () => {
    expect(expandBraceAlternation('{a,{b,c}}')).toEqual(['a', 'b', 'c']);
    expect(expandBraceAlternation('{{a,b},c}')).toEqual(['a', 'b', 'c']);
    expect(expandBraceAlternation('{a,{b,c}}.{ts,tsx}')).toEqual([
      'a.ts',
      'a.tsx',
      'b.ts',
      'b.tsx',
      'c.ts',
      'c.tsx',
    ]);
  });

  it('preserves literal comma-less braces and empty alternatives', () => {
    expect(expandBraceAlternation('{id}.ts')).toEqual(['{id}.ts']);
    expect(expandBraceAlternation('{{a,b}}')).toEqual(['{a}', '{b}']);
    expect(expandBraceAlternation('{,{a,b}}')).toEqual(['', 'a', 'b']);
  });

  it('keeps the exact expansion limit across nested branches', () => {
    const leaves = Array.from({ length: 63 }, (_, i) => `v${i}`);
    expect(expandBraceAlternation(`{shared,{${leaves.join(',')}}}`)).toEqual(['shared', ...leaves]);
    expect(expandBraceAlternation(`{shared,{${[...leaves, 'overflow'].join(',')}}}`)).toEqual([
      'shared',
      ...leaves,
    ]);
    expect(expandBraceAlternation('{a,{b,c}}', 2)).toEqual(['a', 'b']);
  });
});
