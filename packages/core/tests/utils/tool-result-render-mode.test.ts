import { describe, expect, it } from 'vitest';
import {
  applyToolResultRenderModes,
  DEFAULT_TOOL_RESULT_RENDER_MODE,
  getToolResultRenderMode,
  normalizeToolResultRenderMode,
  resolveToolResultRenderMode,
  setToolResultRenderMode,
  type ToolResultRenderModeRegistryLike,
} from '../../src/utils/tool-result-render-mode.js';

function makeRegistry(): ToolResultRenderModeRegistryLike & {
  last: Map<string, 'simple' | 'extend'>;
} {
  const last = new Map<string, 'simple' | 'extend'>();
  return {
    last,
    get() {
      return undefined;
    },
    setResultRenderMode(name, mode) {
      last.set(name, mode);
      return true;
    },
    getResultRenderMode(name) {
      return last.get(name) ?? DEFAULT_TOOL_RESULT_RENDER_MODE;
    },
  };
}

describe('normalizeToolResultRenderMode', () => {
  it('accepts canonical strings', () => {
    expect(normalizeToolResultRenderMode('simple')).toBe('simple');
    expect(normalizeToolResultRenderMode('extend')).toBe('extend');
  });

  it('accepts synonyms', () => {
    expect(normalizeToolResultRenderMode('short')).toBe('simple');
    expect(normalizeToolResultRenderMode('brief')).toBe('simple');
    expect(normalizeToolResultRenderMode('full')).toBe('extend');
    expect(normalizeToolResultRenderMode('extended')).toBe('extend');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeToolResultRenderMode('  SIMPLE  ')).toBe('simple');
  });

  it('rejects unknown values', () => {
    expect(normalizeToolResultRenderMode('nope')).toBeUndefined();
    expect(normalizeToolResultRenderMode('')).toBeUndefined();
    expect(normalizeToolResultRenderMode(undefined)).toBeUndefined();
    expect(normalizeToolResultRenderMode(null)).toBeUndefined();
    expect(normalizeToolResultRenderMode(42)).toBeUndefined();
  });
});

describe('resolveToolResultRenderMode', () => {
  it('defaults to "extend" when the map has no entry', () => {
    expect(resolveToolResultRenderMode(undefined, 'read')).toBe('extend');
    expect(resolveToolResultRenderMode({}, 'read')).toBe('extend');
  });

  it('returns the entry when present', () => {
    expect(resolveToolResultRenderMode({ read: 'simple' }, 'read')).toBe('simple');
    expect(resolveToolResultRenderMode({ read: 'extend' }, 'read')).toBe('extend');
  });

  it('ignores unknown entries (treats as default)', () => {
    expect(resolveToolResultRenderMode({ read: 'garbage' as never }, 'read')).toBe('extend');
  });
});

describe('setToolResultRenderMode / getToolResultRenderMode', () => {
  it('round-trips a mode through the registry', () => {
    const reg = makeRegistry();
    expect(setToolResultRenderMode(reg, 'read', 'simple')).toBe(true);
    expect(getToolResultRenderMode(reg, 'read')).toBe('simple');
  });

  it('returns default when registry has no entry', () => {
    const reg = makeRegistry();
    expect(getToolResultRenderMode(reg, 'read')).toBe('extend');
  });

  it('returns false (no-op) when registry has no setter', () => {
    const reg: ToolResultRenderModeRegistryLike = { get: () => undefined };
    expect(setToolResultRenderMode(reg, 'read', 'simple')).toBe(false);
  });
});

describe('applyToolResultRenderModes', () => {
  it('applies every entry via the registry', () => {
    const reg = makeRegistry();
    const result = applyToolResultRenderModes(reg, {
      read: 'simple',
      bash: 'simple',
      grep: 'extend',
    });
    expect(result.applied).toBe(3);
    expect(result.missing).toEqual([]);
    expect(reg.last.get('read')).toBe('simple');
    expect(reg.last.get('bash')).toBe('simple');
    expect(reg.last.get('grep')).toBe('extend');
  });

  it('skips unknown values without counting them', () => {
    const reg = makeRegistry();
    const result = applyToolResultRenderModes(reg, {
      read: 'simple',
      bash: 'garbage' as never,
    });
    expect(result.applied).toBe(1);
  });

  it('handles missing maps without throwing', () => {
    const reg = makeRegistry();
    expect(() => applyToolResultRenderModes(reg)).not.toThrow();
    expect(applyToolResultRenderModes(reg).applied).toBe(0);
  });
});
