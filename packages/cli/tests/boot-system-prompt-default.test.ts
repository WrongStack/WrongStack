import { flagsToConfigPatch } from '@wrongstack/core/boot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ bootConfig: vi.fn() }));
vi.mock('../src/boot-config.js', () => ({ bootConfig: mocks.bootConfig }));

import { shouldSkipSystemPromptMenu } from '../src/boot/system-prompt-menu.js';
import { boot } from '../src/boot.js';

let stdinTty: PropertyDescriptor | undefined;

beforeEach(() => {
  // Stop at the config boundary, before filesystem, provider or terminal I/O.
  mocks.bootConfig.mockReset().mockRejectedValue(new Error('stop after launch defaults'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
});

async function launchFlags(argv: string[]): Promise<Record<string, string | boolean>> {
  expect(await boot(argv)).toBe(2);
  expect(mocks.bootConfig).toHaveBeenCalledOnce();
  return mocks.bootConfig.mock.calls[0]![0];
}

describe('CLI system prompt default', () => {
  it.each([
    [],
    ['--tui'],
    ['--no-tui'],
    ['--no-menu'],
    ['--skip'],
    ['--no-interactive'],
    ['quick'],
    ['review this'],
    ['--prompt', 'review this'],
    ['--resume', 'session-1'],
    ['resume', 'session-1'],
  ])('selects Quick without a system-prompt menu for argv %j', async (...argv) => {
    const flags = await launchFlags(argv);
    const patch = flagsToConfigPatch(flags);
    expect(patch.systemPrompt?.variant).toBe('quick');
    expect(shouldSkipSystemPromptMenu(flags)).toBe(true);
    // Ordinary CLI launches keep the configured tool-coach behavior.
    expect(patch.features?.toolCoach).toBeUndefined();
  });

  it.each([
    ['--system-pro', 'pro'],
    ['--system-lite', 'lite'],
    ['--system-scout', 'scout'],
    ['--system-quick', 'quick'],
    ['--system-prompt=default', 'default'],
    ['--system-prompt=pro', 'pro'],
  ])('honors an explicit %s selection', async (flag, variant) => {
    const flags = await launchFlags([flag]);
    expect(flagsToConfigPatch(flags).systemPrompt?.variant).toBe(variant);
  });

  it.each([
    ['--webui'],
    ['webui'],
    ['--vibeui'],
    ['vibeui'],
    ['--hq'],
    ['--host-profile'],
    ['config'],
    ['bench', 'run'],
  ])('keeps the profile prompt for argv %j', async (...argv) => {
    const flags = await launchFlags(argv);
    expect(flagsToConfigPatch(flags).systemPrompt).toBeUndefined();
  });

  it('keeps the lean tool-coach default for a machine-driven task', async () => {
    const flags = await launchFlags(['review this', '--output-json']);
    expect(flagsToConfigPatch(flags)).toMatchObject({
      systemPrompt: { variant: 'quick' },
      features: { toolCoach: false },
    });
  });
});
