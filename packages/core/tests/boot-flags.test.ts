/**
 * Additional coverage for boot.ts — flagsToConfigPatch flag mappings
 * and assertProjectRootOutsideStateDir validation.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProjectRootOutsideStateDir, flagsToConfigPatch } from '../src/boot.js';

describe('flagsToConfigPatch', () => {
  it('returns empty patch for empty flags', () => {
    expect(flagsToConfigPatch({})).toEqual({});
  });

  it('maps provider flag', () => {
    const patch = flagsToConfigPatch({ provider: 'anthropic' });
    expect(patch.provider).toBe('anthropic');
  });

  it('maps model flag', () => {
    const patch = flagsToConfigPatch({ model: 'claude-3' });
    expect(patch.model).toBe('claude-3');
  });

  it('maps fallback-model as comma-separated list', () => {
    const patch = flagsToConfigPatch({ 'fallback-model': 'openai/gpt-4o, anthropic/claude-3' });
    expect(patch.fallbackModels).toEqual(['openai/gpt-4o', 'anthropic/claude-3']);
  });

  it('ignores empty fallback-model', () => {
    const patch = flagsToConfigPatch({ 'fallback-model': '' });
    expect(patch.fallbackModels).toBeUndefined();
  });

  it('maps cwd flag', () => {
    const patch = flagsToConfigPatch({ cwd: '/my/project' });
    expect(patch.cwd).toBe('/my/project');
  });

  it('maps log-level flag', () => {
    const patch = flagsToConfigPatch({ 'log-level': 'warn' });
    expect(patch.log).toEqual({ level: 'warn' });
  });

  it('maps verbose to debug log level', () => {
    const patch = flagsToConfigPatch({ verbose: true });
    expect(patch.log).toEqual({ level: 'debug' });
  });

  it('maps trace to trace log level', () => {
    const patch = flagsToConfigPatch({ trace: true });
    expect(patch.log).toEqual({ level: 'trace' });
  });

  it('log-level takes precedence over verbose', () => {
    const patch = flagsToConfigPatch({ 'log-level': 'error', verbose: true });
    expect(patch.log).toEqual({ level: 'error' });
  });

  it('maps yolo flag', () => {
    expect(flagsToConfigPatch({ yolo: true }).yolo).toBe(true);
  });

  it('maps no-yolo flag', () => {
    expect(flagsToConfigPatch({ 'no-yolo': true }).yolo).toBe(false);
  });

  it('no-yolo takes precedence over yolo', () => {
    expect(flagsToConfigPatch({ 'no-yolo': true, yolo: true }).yolo).toBe(false);
  });

  it('maps no-features flag', () => {
    const patch = flagsToConfigPatch({ 'no-features': true });
    expect(patch.features).toEqual({
      mcp: false,
      plugins: false,
      memory: false,
      modelsRegistry: false,
      skills: false,
    });
  });

  it('maps token-saving-mode flag', () => {
    const patch = flagsToConfigPatch({ 'token-saving-mode': true });
    expect(patch.features?.tokenSavingMode).toBe(true);
  });

  it('maps system-pro flag', () => {
    const patch = flagsToConfigPatch({ 'system-pro': true });
    expect(patch.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('maps system-pro string flag', () => {
    const patch = flagsToConfigPatch({ 'system-pro': 'true' });
    expect(patch.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('maps system-lite flag', () => {
    const patch = flagsToConfigPatch({ 'system-lite': true });
    expect(patch.systemPrompt).toEqual({ variant: 'lite' });
  });

  it('maps system-prompt=pro', () => {
    const patch = flagsToConfigPatch({ 'system-prompt': 'pro' });
    expect(patch.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('maps system-prompt=lite', () => {
    const patch = flagsToConfigPatch({ 'system-prompt': 'lite' });
    expect(patch.systemPrompt).toEqual({ variant: 'lite' });
  });

  it('maps system-prompt=default', () => {
    const patch = flagsToConfigPatch({ 'system-prompt': 'default' });
    expect(patch.systemPrompt).toEqual({ variant: 'default' });
  });

  it('system-pro takes precedence over system-lite', () => {
    const patch = flagsToConfigPatch({ 'system-pro': true, 'system-lite': true });
    expect(patch.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('maps token-saving-tier flag', () => {
    const patch = flagsToConfigPatch({ 'token-saving-tier': 'aggressive' });
    expect(patch.features?.tokenSavingMode).toBeDefined();
  });

  it('token-saving-tier takes precedence over token-saving-mode', () => {
    const patch = flagsToConfigPatch({ 'token-saving-mode': true, 'token-saving-tier': 'off' });
    // 'off' normalizes to false/undefined
    expect(patch.features?.tokenSavingMode).not.toBe(true);
  });

  it('maps multiple flags together', () => {
    const patch = flagsToConfigPatch({
      provider: 'openai',
      model: 'gpt-4o',
      yolo: true,
      verbose: true,
    });
    expect(patch.provider).toBe('openai');
    expect(patch.model).toBe('gpt-4o');
    expect(patch.yolo).toBe(true);
    expect(patch.log).toEqual({ level: 'debug' });
  });
});

describe('assertProjectRootOutsideStateDir', () => {
  it('does not throw for project outside state dir', () => {
    expect(() =>
      assertProjectRootOutsideStateDir('/home/user/my-project', '/home/user/.wrongstack'),
    ).not.toThrow();
  });

  it('throws for project inside state dir projects/', () => {
    expect(() =>
      assertProjectRootOutsideStateDir(
        path.join('/home/user/.wrongstack', 'projects', 'my-project'),
        '/home/user/.wrongstack',
      ),
    ).toThrow('Refusing to start');
  });

  it('throws for project nested deep inside state dir', () => {
    expect(() =>
      assertProjectRootOutsideStateDir(
        path.join('/home/user/.wrongstack', 'projects', 'abc', 'sub', 'deep'),
        '/home/user/.wrongstack',
      ),
    ).toThrow('Refusing to start');
  });

  it('does not throw for sibling directory', () => {
    expect(() =>
      assertProjectRootOutsideStateDir('/home/user/other-project', '/home/user/.wrongstack'),
    ).not.toThrow();
  });

  it('does not throw for parent directory', () => {
    expect(() =>
      assertProjectRootOutsideStateDir('/home/user', '/home/user/.wrongstack'),
    ).not.toThrow();
  });
});
