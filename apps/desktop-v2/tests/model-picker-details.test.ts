import { describe, expect, it } from 'vitest';
import { compactCount, modelDetailLine, pickerModel } from '../src/model-picker-details';

describe('model picker details', () => {
  it('shows only the catalog facts that are known', () => {
    const model = pickerModel({
      id: 'claude-x',
      name: 'Claude X',
      contextWindow: 200_000,
      maxOutput: 64_000,
      inputCost: 3,
      outputCost: 15,
      capabilities: ['tools', 'reasoning', 'vision'],
      status: 'active',
    });
    expect(modelDetailLine(model)).toBe(
      '200K context · 64K output · $3 / $15 per 1M · tools, reasoning, images',
    );
    // Unknown limits and prices are left out, never shown as zero.
    expect(modelDetailLine(pickerModel({ id: 'local', contextWindow: 0, capabilities: [] }))).toBe(
      '',
    );
    expect(
      modelDetailLine(
        pickerModel({ id: 'old', inputCost: 1, capabilities: [], status: 'deprecated' }),
      ),
    ).toBe('deprecated');
    expect(
      modelDetailLine(pickerModel({ id: 'free', inputCost: 0, outputCost: 0, capabilities: [] })),
    ).toBe('no catalog price');
    // Prices computed upstream carry binary-float noise; the picker shows the price, not the noise.
    expect(
      modelDetailLine(
        pickerModel({
          id: 'noisy',
          inputCost: 0.6000000000000001,
          outputCost: 1.7999999999999998,
          capabilities: [],
        }),
      ),
    ).toBe('$0.6 / $1.8 per 1M');
    expect(pickerModel({ id: 'tiny', inputCost: 0.000075, capabilities: [] }).inputCost).toBe(
      0.000075,
    );
  });
  it('refuses malformed facts from the reply', () => {
    const model = pickerModel({
      id: 'x',
      contextWindow: Number.NaN,
      maxOutput: -1,
      inputCost: '3',
      capabilities: ['tools', 4],
      status: '',
    });
    expect(model).toEqual({ id: 'x', name: 'x', capabilities: ['tools'] });
  });
  it('compacts token counts', () => {
    expect(compactCount(1_000_000)).toBe('1M');
    expect(compactCount(1_048_576)).toBe('1M');
    expect(compactCount(200_000)).toBe('200K');
    expect(compactCount(8_192)).toBe('8.2K');
    expect(compactCount(512)).toBe('512');
  });
});
