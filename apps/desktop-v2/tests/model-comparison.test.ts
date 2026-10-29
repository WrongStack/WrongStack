import { describe, expect, it } from 'vitest';
import { comparisonRows, MAX_COMPARED_MODELS, toggleCompared } from '../src/model-comparison';
import { pickerModel } from '../src/model-picker-details';

const a = pickerModel({
  id: 'a',
  name: 'A',
  contextWindow: 200_000,
  maxOutput: 64_000,
  inputCost: 3,
  outputCost: 15,
  capabilities: ['tools', 'vision'],
});
const b = pickerModel({
  id: 'b',
  name: 'B',
  contextWindow: 1_000_000,
  inputCost: 1,
  outputCost: 15,
  capabilities: ['tools'],
  status: 'deprecated',
});

describe('model comparison', () => {
  it('lines up known facts and marks the best differing value', () => {
    const rows = Object.fromEntries(comparisonRows([a, b]).map((row) => [row.label, row.cells]));
    expect(rows['Context']).toEqual([
      { text: '200K', best: false },
      { text: '1M', best: true },
    ]);
    // One known value has nothing to beat; unknown is never estimated.
    expect(rows['Output']).toEqual([
      { text: '64K', best: false },
      { text: 'Unknown', best: false },
    ]);
    expect(rows['Input / 1M']).toEqual([
      { text: '$3', best: false },
      { text: '$1', best: true },
    ]);
    // Equal values are not ranked.
    expect(rows['Output / 1M']!.every((cell) => !cell.best)).toBe(true);
    expect(rows['Images']!.map((cell) => cell.text)).toEqual(['Yes', 'Not reported']);
    expect(rows['Status']!.map((cell) => cell.text)).toEqual(['Unknown', 'deprecated']);
  });
  it('omits the status row when every model is active or unreported', () => {
    expect(comparisonRows([a, a]).some((row) => row.label === 'Status')).toBe(false);
  });
  it('toggles membership and refuses past the limit', () => {
    let ids: string[] = [];
    for (let i = 0; i < MAX_COMPARED_MODELS; i++) ids = toggleCompared(ids, `m${i}`);
    expect(() => toggleCompared(ids, 'extra')).toThrow('at most');
    expect(toggleCompared(ids, 'm0')).toEqual(['m1', 'm2', 'm3']);
  });
});
