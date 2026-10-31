import { resolveModelRuntime } from '@wrongstack/core/execution';
import { WRONGFORGE_REASONING, wrongForgeRuntime } from '@wrongstack/fleet';
import { describe, expect, it } from 'vitest';

describe('WrongForge runtime contract', () => {
  it('preserves extended effort levels advertised by the running server', () => {
    const info = {
      models: ['a'],
      features: [],
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'off'],
    };
    expect(wrongForgeRuntime({ effort: 'max' }, undefined, info)).toEqual({ effort: 'max' });
    expect(wrongForgeRuntime({ effort: 'xhigh' }, undefined, info)).toEqual({ effort: 'xhigh' });
  });
  it.each([
    ['none', 'off'],
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'high'],
  ] as const)('maps %s to the accepted Task API effort %s', (effort, expected) => {
    expect(wrongForgeRuntime({ effort })).toEqual({ effort: expected });
  });
  it('leaves unset controls to server defaults and respects explicit off', () => {
    expect(wrongForgeRuntime()).toEqual({});
    expect(wrongForgeRuntime({ enabled: false, effort: 'high' }, { ttl: '1h' })).toEqual({
      effort: 'off',
      cache: '1h',
    });
  });
  it('keeps configured effort through request middleware resolution', () => {
    const resolved = resolveModelRuntime(
      { reasoning: { effort: 'low' }, cache: { ttl: '5m' } },
      WRONGFORGE_REASONING,
    );
    expect(wrongForgeRuntime(resolved.reasoning, resolved.cache)).toEqual({
      effort: 'low',
      cache: '5m',
    });
  });
});
