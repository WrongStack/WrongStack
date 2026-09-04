import { describe, expect, it } from 'vitest';
import {
  computeContextWindowBudget,
  defaultContextOutputReserve,
} from '../../src/execution/context-budget.js';

describe('defaultContextOutputReserve', () => {
  it.each([
    [10000, undefined, 800],
    [1000000, undefined, 8192],
    [1000000, 65536, 8192],
    [1000000, 2048.9, 2048],
    [101, undefined, 8],
    [10, 0.5, 0],
  ])('reserves for window %s and output ceiling %s', (maxContext, maxOutput, expected) => {
    expect(defaultContextOutputReserve(maxContext, maxOutput)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'ignores invalid output ceiling %s',
    (maxOutput) => {
      expect(defaultContextOutputReserve(10000, maxOutput)).toBe(800);
    },
  );
});

describe('computeContextWindowBudget', () => {
  it('preserves percentage defaults and returns the complete budget snapshot', () => {
    expect(computeContextWindowBudget({ maxContext: 10000, inputTokens: 4500 })).toEqual({
      maxContext: 10000,
      inputTokens: 4500,
      reservedOutputTokens: 800,
      reservedSafetyTokens: 200,
      availableInputTokens: 9000,
      remainingInputTokens: 4500,
      load: 0.5,
      overflowTokens: 0,
    });
  });

  it('caps default reserves for large context windows', () => {
    expect(computeContextWindowBudget({ maxContext: 1000000, inputTokens: 0 })).toMatchObject({
      reservedOutputTokens: 8192,
      reservedSafetyTokens: 4096,
      availableInputTokens: 987712,
      remainingInputTokens: 987712,
      load: 0,
      overflowTokens: 0,
    });
  });

  it('floors the percentage safety reserve', () => {
    expect(computeContextWindowBudget({ maxContext: 101, inputTokens: 0 })).toMatchObject({
      reservedOutputTokens: 8,
      reservedSafetyTokens: 2,
      availableInputTokens: 91,
    });
  });

  it('uses a smaller output ceiling but lets explicit reserves override defaults', () => {
    expect(
      computeContextWindowBudget({ maxContext: 10000, inputTokens: 0, maxOutput: 100 }),
    ).toMatchObject({ reservedOutputTokens: 100, availableInputTokens: 9700 });
    expect(
      computeContextWindowBudget({
        maxContext: 10000,
        inputTokens: 0,
        maxOutput: 100,
        outputReserveTokens: 2000,
        safetyBufferTokens: 300,
      }),
    ).toMatchObject({
      reservedOutputTokens: 2000,
      reservedSafetyTokens: 300,
      availableInputTokens: 7700,
    });
  });

  it('accepts zero reserve overrides', () => {
    expect(
      computeContextWindowBudget({
        maxContext: 10000,
        inputTokens: 10000,
        outputReserveTokens: 0,
        safetyBufferTokens: 0,
      }),
    ).toMatchObject({
      reservedOutputTokens: 0,
      reservedSafetyTokens: 0,
      availableInputTokens: 10000,
      remainingInputTokens: 0,
      load: 1,
      overflowTokens: 0,
    });
  });

  it('reports overflow without clamping the load or remaining input', () => {
    expect(computeContextWindowBudget({ maxContext: 10000, inputTokens: 9900 })).toMatchObject({
      remainingInputTokens: -900,
      overflowTokens: 900,
      load: 1.1,
    });
  });

  it('keeps a one-token input budget when reserves exhaust the window', () => {
    expect(
      computeContextWindowBudget({
        maxContext: 100,
        inputTokens: 5,
        outputReserveTokens: 100,
        safetyBufferTokens: 100,
      }),
    ).toMatchObject({
      availableInputTokens: 1,
      remainingInputTokens: -4,
      overflowTokens: 4,
      load: 5,
    });
  });
});
