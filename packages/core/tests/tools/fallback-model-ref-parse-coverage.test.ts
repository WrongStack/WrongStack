/**
 * Coverage for core/src/tools/fallback-model-ref-parse.ts and
 * core/src/utils/connectivity.ts
 */
import { describe, expect, it } from 'vitest';
import { parseRefInternal } from '../../src/tools/fallback-model-ref-parse.js';

// ─── fallback-model-ref-parse ───────────────────────────────────────────────

describe('parseRefInternal', () => {
  it('parses provider/model format', () => {
    expect(parseRefInternal('anthropic/claude-sonnet-4')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
  });

  it('returns model only when provider part before / is empty', () => {
    expect(parseRefInternal('/model-name')).toEqual({ model: 'model-name' });
  });

  it('handles whitespace-only provider before /', () => {
    expect(parseRefInternal(' /model')).toEqual({ model: 'model' });
  });

  it('parses space-separated provider model', () => {
    expect(parseRefInternal('openai gpt-4o')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('joins multi-word model from space-separated format', () => {
    expect(parseRefInternal('openai gpt 4o mini')).toEqual({
      provider: 'openai',
      model: 'gpt 4o mini',
    });
  });

  it('returns bare model when no separator', () => {
    expect(parseRefInternal('claude-sonnet-4')).toEqual({ model: 'claude-sonnet-4' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseRefInternal('  anthropic/claude-3  ')).toEqual({
      provider: 'anthropic',
      model: 'claude-3',
    });
  });

  it('handles empty string', () => {
    expect(parseRefInternal('')).toEqual({ model: '' });
  });

  it('handles whitespace-only string', () => {
    expect(parseRefInternal('   ')).toEqual({ model: '' });
  });

  it('handles provider/ with trailing whitespace after model', () => {
    expect(parseRefInternal('openai/  gpt-4o  ')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });
});

// ─── connectivity ───────────────────────────────────────────────────────────

describe('connectivity utils', () => {
  it('module exports checkConnectivity', async () => {
    const mod = await import('../../src/utils/connectivity.js');
    expect(mod.checkConnectivity).toBeDefined();
    expect(typeof mod.checkConnectivity).toBe('function');
  });

  it('checkConnectivity returns a boolean', async () => {
    const mod = await import('../../src/utils/connectivity.js');
    const result = await mod.checkConnectivity();
    expect(typeof result).toBe('boolean');
  });
});
