import { describe, expect, it } from 'vitest';
import { commitGraph } from '../src/git-graph';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe('commit graph lanes', () => {
  it('keeps a linear history in one lane', () => {
    const rows = commitGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => [row.fromAbove, row.toBelow])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
    expect(rows.every((row) => row.width === 1 && !row.through.length)).toBe(true);
  });
  it('opens a lane for a merged branch and closes it where the branch forked', () => {
    //  m merges f into main; f and b both come from a.
    const rows = commitGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
    expect(rows[0]).toMatchObject({ lane: 0, merges: [1], width: 2 });
    expect(rows[1]).toMatchObject({ lane: 1, fromAbove: true, through: [0] });
    expect(rows[2]).toMatchObject({ lane: 0, fromAbove: true, through: [1] });
    // Both lanes wait for a: it takes the first and the second converges into it.
    expect(rows[3]).toMatchObject({ lane: 0, converges: [1], toBelow: false, width: 2 });
  });
  it('places an unrelated tip in a free lane and continues parents outside the page', () => {
    const rows = commitGraph([c('x', 'outside'), c('y', 'also-outside')]);
    expect(rows[0]).toMatchObject({ lane: 0, fromAbove: false, toBelow: true });
    expect(rows[1]).toMatchObject({ lane: 1, through: [0], toBelow: true, width: 2 });
  });
  it('merges into a parent lane that is already waiting', () => {
    // Two merges of the same branch tip f: the second reuses the waiting lane.
    const rows = commitGraph([c('m2', 'm1', 'f'), c('m1', 'b', 'f'), c('f', 'a'), c('b', 'a')]);
    expect(rows[0]!.merges).toEqual([1]);
    expect(rows[1]!.merges).toEqual([1]);
    expect(rows[1]!.through).toEqual([1]);
  });
});
