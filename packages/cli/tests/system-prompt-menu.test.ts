/**
 * Tests for `boot/system-prompt-menu.ts` — the startup Lite/Standard/Pro
 * system-prompt selection.
 *
 * Concerns covered:
 *   1. shouldSkipSystemPromptMenu / isSystemPromptPinned — pure predicates.
 *   2. countSystemPromptTokens — resolves the same bundled instruction
 *      files the SystemPromptBuilder uses; counts are ordered and > 0.
 *   3. runSystemPromptMenu — readLine mock: first-run menu, summary gate,
 *      cancel via LaunchAbortedError, default fallbacks.
 *   4. persistSystemPromptVariant — config write shape, preservation of
 *      unrelated keys, corrupt-file refusal.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { estimateTextTokens } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countSystemPromptTokens,
  isSystemPromptPinned,
  maybeRunSystemPromptMenu,
  persistSystemPromptVariant,
  readSavedSystemPromptVariant,
  runSystemPromptMenu,
  SYSTEM_PROMPT_OPTIONS,
  SYSTEM_PROMPT_VARIANTS,
  type SystemPromptMenuOutcome,
  type SystemPromptMenuPaths,
  shouldSkipSystemPromptMenu,
} from '../src/boot/system-prompt-menu.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import { LaunchAbortedError } from '../src/pre-launch.js';
import type { TerminalRenderer } from '../src/renderer.js';

// ── Renderer / reader mocks ─────────────────────────────────────────────

function makeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
}

function makeReader(answers: string[]): ReadlineInputReader {
  let i = 0;
  return {
    readLine: vi.fn(async () => {
      if (i >= answers.length) throw new Error('EOF');
      return answers[i++] ?? '';
    }),
    close: vi.fn(async () => {}),
  } as never as ReadlineInputReader;
}

// ── Predicates ──────────────────────────────────────────────────────────

describe('isSystemPromptPinned', () => {
  it('is false when no --system-* flag is present', () => {
    expect(isSystemPromptPinned({})).toBe(false);
    expect(isSystemPromptPinned({ tui: true })).toBe(false);
  });

  it('is true when --system-pro / --system-lite are set', () => {
    expect(isSystemPromptPinned({ 'system-pro': true })).toBe(true);
    expect(isSystemPromptPinned({ 'system-lite': true })).toBe(true);
  });

  it('is true for string truthy spellings', () => {
    expect(isSystemPromptPinned({ 'system-pro': 'true' })).toBe(true);
    expect(isSystemPromptPinned({ 'system-lite': '1' })).toBe(true);
  });

  it('is true when --system-prompt <variant> is supplied', () => {
    expect(isSystemPromptPinned({ 'system-prompt': 'pro' })).toBe(true);
    expect(isSystemPromptPinned({ 'system-prompt': 'lite' })).toBe(true);
    expect(isSystemPromptPinned({ 'system-prompt': 'default' })).toBe(true);
  });
});

describe('shouldSkipSystemPromptMenu', () => {
  it('skips when a --system-* flag pins the variant', () => {
    expect(shouldSkipSystemPromptMenu({ 'system-pro': true })).toBe(true);
    expect(shouldSkipSystemPromptMenu({ 'system-lite': true })).toBe(true);
    expect(shouldSkipSystemPromptMenu({ 'system-prompt': 'lite' })).toBe(true);
  });

  it('skips when --no-menu / --no-interactive / --skip are set', () => {
    expect(shouldSkipSystemPromptMenu({ 'no-menu': true })).toBe(true);
    expect(shouldSkipSystemPromptMenu({ 'no-interactive': true })).toBe(true);
    expect(shouldSkipSystemPromptMenu({ skip: true })).toBe(true);
  });

  it('skips when --webui is set', () => {
    expect(shouldSkipSystemPromptMenu({ webui: true })).toBe(true);
  });

  it('does not skip a plain interactive launch', () => {
    expect(shouldSkipSystemPromptMenu({})).toBe(false);
  });
});

// ── Token counts ────────────────────────────────────────────────────────

describe('countSystemPromptTokens', () => {
  it('returns a positive, ordered estimate per variant (lite < standard < pro)', async () => {
    const counts = await countSystemPromptTokens({});
    expect(counts.lite).toBeGreaterThan(0);
    expect(counts.default).toBeGreaterThan(counts.lite);
    expect(counts.pro).toBeGreaterThan(counts.default);
  });

  /**
   * Regression: the first implementation counted `bundle.system.identity`
   * directly, which for a PROJECT-supplied file is only the project text.
   *
   * What actually ships (WS-016) is `LAYER_1_IDENTITY` — a hardcoded constant,
   * NOT the resolved variant markdown — followed by a
   * `<project-supplied-instructions>` delimiter and then the project text. Two
   * consequences this test pins:
   *
   *   - a tiny project override must still report thousands of tokens, because
   *     the constant identity leads (the old code reported ~3);
   *   - the count legitimately drops BELOW bundled Pro, because the bundled
   *     `system-pro.md` is replaced during the merge and never reaches the
   *     prompt. Lower here is correct, not a regression.
   */
  it('counts a project override as constant identity + delimiter + project text', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sysprompt-proj-'));
    try {
      const instructions = path.join(dir, 'instructions');
      await fs.mkdir(instructions, { recursive: true });
      const baseline = await countSystemPromptTokens({});

      const projectText = 'Be terse.\n';
      await fs.writeFile(path.join(instructions, 'system-pro.md'), projectText, 'utf8');
      const withOverride = await countSystemPromptTokens({ projectDir: instructions });

      // The old bug: counting the project text alone. Must be far above that.
      expect(withOverride.pro).toBeGreaterThan(estimateTextTokens(projectText) * 100);
      expect(withOverride.pro).toBeGreaterThan(1000);
      // Bundled system-pro.md is replaced by the override, so Pro drops.
      expect(withOverride.pro).toBeLessThan(baseline.pro);
      // Variants without an override file must not move.
      expect(withOverride.lite).toBe(baseline.lite);
      expect(withOverride.default).toBe(baseline.default);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── runSystemPromptMenu ─────────────────────────────────────────────────

describe('runSystemPromptMenu', () => {
  it('shows the numbered menu on first run and returns the picked variant', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['3']);
    const variant = await runSystemPromptMenu({ renderer, reader, paths: {} });

    expect(variant).toBe('pro');
    // Menu header + one row per option, each with its token count.
    const written = vi
      .mocked(renderer.write)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(written).toContain('System prompt:');
    expect(written).toContain('1.');
    expect(written).toContain('Lite');
    expect(written).toContain('Standard');
    expect(written).toContain('Pro');
    expect(written).toMatch(/~[\d.]+[kM]? tokens/);
  });

  it('accepts an empty answer as the default variant', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']);
    const variant = await runSystemPromptMenu({ renderer, reader, paths: {} });
    expect(variant).toBe('default');
  });

  it('honors lastVariant as the Enter default', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['']);
    const variant = await runSystemPromptMenu({
      renderer,
      reader,
      paths: {},
      lastVariant: 'lite',
    });
    expect(variant).toBe('lite');
  });

  it('accepts a label instead of a number', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['pro']);
    const variant = await runSystemPromptMenu({ renderer, reader, paths: {} });
    expect(variant).toBe('pro');
  });

  it('falls back to the default on an unrecognized answer', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['banana']);
    const variant = await runSystemPromptMenu({ renderer, reader, paths: {} });
    expect(variant).toBe('default');
  });

  it('throws LaunchAbortedError when the user quits the menu', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    await expect(runSystemPromptMenu({ renderer, reader, paths: {} })).rejects.toBeInstanceOf(
      LaunchAbortedError,
    );
  });

  it('summary gate: accepts the saved variant with y without re-opening the menu', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['y']);
    const variant = await runSystemPromptMenu({
      renderer,
      reader,
      paths: {},
      lastVariant: 'pro',
    });
    expect(variant).toBe('pro');
    // The gate is the prompt itself (readLine), not a renderer.write line.
    const prompt = String(vi.mocked(reader.readLine).mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('Continue with Pro system prompt');
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });

  it('summary gate: n re-opens the full menu', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['n', '1']);
    const variant = await runSystemPromptMenu({
      renderer,
      reader,
      paths: {},
      lastVariant: 'pro',
    });
    expect(variant).toBe('lite');
  });

  it('summary gate: q aborts the launch', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['q']);
    await expect(
      runSystemPromptMenu({ renderer, reader, paths: {}, lastVariant: 'pro' }),
    ).rejects.toBeInstanceOf(LaunchAbortedError);
  });
});

// ── readSavedSystemPromptVariant ────────────────────────────────────────

describe('readSavedSystemPromptVariant', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sysprompt-read-'));
    configPath = path.join(dir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when the config file does not exist', async () => {
    expect(await readSavedSystemPromptVariant(configPath)).toBeUndefined();
  });

  it('returns undefined when the file has no explicit systemPrompt.variant', async () => {
    // The loader materializes `variant: 'default'` in memory only; a file
    // without the key means the user never made a selection.
    await fs.writeFile(configPath, JSON.stringify({ provider: 'anthropic' }), 'utf8');
    expect(await readSavedSystemPromptVariant(configPath)).toBeUndefined();
  });

  it('returns the saved variant when present on disk', async () => {
    await fs.writeFile(configPath, JSON.stringify({ systemPrompt: { variant: 'pro' } }), 'utf8');
    expect(await readSavedSystemPromptVariant(configPath)).toBe('pro');
  });

  it('returns undefined for an invalid variant value', async () => {
    await fs.writeFile(configPath, JSON.stringify({ systemPrompt: { variant: 'ultra' } }), 'utf8');
    expect(await readSavedSystemPromptVariant(configPath)).toBeUndefined();
  });

  it('returns undefined for a corrupt file', async () => {
    await fs.writeFile(configPath, '{ nope', 'utf8');
    expect(await readSavedSystemPromptVariant(configPath)).toBeUndefined();
  });
});

// ── persistSystemPromptVariant ──────────────────────────────────────────

describe('persistSystemPromptVariant', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sysprompt-menu-'));
    configPath = path.join(dir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes systemPrompt.variant into a fresh config file', async () => {
    await persistSystemPromptVariant(configPath, 'pro');
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('preserves unrelated keys and merges an existing systemPrompt block', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ provider: 'anthropic', systemPrompt: { variant: 'lite' } }),
      'utf8',
    );
    await persistSystemPromptVariant(configPath, 'pro');
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.provider).toBe('anthropic');
    expect(raw.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('refuses to overwrite a corrupt config file', async () => {
    await fs.writeFile(configPath, '{ not json', 'utf8');
    await expect(persistSystemPromptVariant(configPath, 'lite')).rejects.toThrow(
      /Refusing to overwrite corrupt config/,
    );
  });
});

// ── Option table sanity ─────────────────────────────────────────────────

describe('SYSTEM_PROMPT_OPTIONS', () => {
  it('covers exactly the selectable variants in menu order', () => {
    expect(SYSTEM_PROMPT_VARIANTS).toEqual(['lite', 'default', 'pro']);
    expect(SYSTEM_PROMPT_OPTIONS.map((o) => o.variant)).toEqual(SYSTEM_PROMPT_VARIANTS);
    expect(SYSTEM_PROMPT_OPTIONS.map((o) => o.label)).toEqual(['Lite', 'Standard', 'Pro']);
  });
});

// ── maybeRunSystemPromptMenu: the real enforcement point ────────────────
//
// The function exists because the bare `if (isInteractiveTTY)` in boot.ts
// was unreachable from any test. The five cases below map 1:1 to the
// contracts in its doc comment.

function makeGateHarness(answers: string[]): {
  readLine: ReturnType<typeof vi.fn>;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
} {
  let i = 0;
  const readLine = vi.fn(async () => {
    if (i >= answers.length) throw new Error('EOF');
    return answers[i++] ?? '';
  });
  const renderer = {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
  const reader = { readLine, close: vi.fn(async () => {}) } as never as ReadlineInputReader;
  return { readLine, renderer, reader };
}

const tmpProfileConfig = (): string =>
  path.join(os.tmpdir(), `ws-spm-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

const gatePaths = (): SystemPromptMenuPaths => ({
  globalDir: '/nonexistent/global',
  projectDir: '/nonexistent/project',
});

describe('maybeRunSystemPromptMenu', () => {
  it('skips the menu entirely when isInteractiveTTY is false', async () => {
    const { renderer, reader } = makeGateHarness([]);
    const res: SystemPromptMenuOutcome = await maybeRunSystemPromptMenu({
      isInteractiveTTY: false,
      flags: {},
      renderer,
      reader,
      profileConfigPath: tmpProfileConfig(),
      paths: gatePaths(),
    });
    expect(reader.readLine).not.toHaveBeenCalled();
    expect(renderer.write).not.toHaveBeenCalled();
    expect(res).toEqual({ aborted: false, changed: false });
  });

  it('skips when a flag-level predicate says so, even on a TTY', async () => {
    const { renderer, reader } = makeGateHarness([]);
    const res = await maybeRunSystemPromptMenu({
      isInteractiveTTY: true,
      flags: { 'no-menu': true },
      renderer,
      reader,
      profileConfigPath: tmpProfileConfig(),
      paths: gatePaths(),
    });
    expect(reader.readLine).not.toHaveBeenCalled();
    expect(res).toEqual({ aborted: false, changed: false });
  });

  it('returns aborted: true when the user presses q at the prompt', async () => {
    const { renderer, reader } = makeGateHarness(['q']);
    const res = await maybeRunSystemPromptMenu({
      isInteractiveTTY: true,
      flags: {},
      renderer,
      reader,
      profileConfigPath: tmpProfileConfig(),
      paths: gatePaths(),
    });
    expect(res.aborted).toBe(true);
    expect(res.changed).toBe(false);
  });

  it('reports changed: false and does not write config when the user re-selects the saved variant', async () => {
    const configPath = tmpProfileConfig();
    await fs.writeFile(configPath, JSON.stringify({ systemPrompt: { variant: 'pro' } }), 'utf8');
    const { renderer, reader } = makeGateHarness(['3']); // Pro is the third option
    const res = await maybeRunSystemPromptMenu({
      isInteractiveTTY: true,
      flags: {},
      renderer,
      reader,
      profileConfigPath: configPath,
      paths: gatePaths(),
    });
    const after = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(res).toEqual({ variant: 'pro', aborted: false, changed: false });
    // The file content must be byte-identical to what was on disk before.
    expect(after.systemPrompt).toEqual({ variant: 'pro' });
  });

  it('captures a persistence failure in persistError instead of throwing', async () => {
    // Failure is injected at the persistence seam instead of relying on
    // chmod semantics: Windows only partially honors the read-only attribute
    // for directory renames, so atomicWrite could succeed, persistError
    // stayed undefined, and this test failed on win32.
    const configPath = tmpProfileConfig();
    // A parseable config keeps the read path real: the loader sees no saved
    // variant, so the menu opens and the selection differs → the persist seam runs.
    await fs.writeFile(configPath, JSON.stringify({}), 'utf8');
    const { renderer, reader } = makeGateHarness(['2']); // pick 'default'
    const persistCalls: Array<Parameters<typeof persistSystemPromptVariant>> = [];
    const res: SystemPromptMenuOutcome = await maybeRunSystemPromptMenu({
      isInteractiveTTY: true,
      flags: {},
      renderer,
      reader,
      profileConfigPath: configPath,
      paths: gatePaths(),
      persist: async (p, variant) => {
        persistCalls.push([p, variant]);
        throw new Error('injected persist failure');
      },
    });
    expect(res.aborted).toBe(false);
    expect(res.variant).toBe('default');
    expect(res.changed).toBe(true);
    // The captured error is the injected one — not a platform accident.
    expect((res.persistError as Error | undefined)?.message).toBe('injected persist failure');
    // The seam is only consulted for real writes, with the caller's args.
    expect(persistCalls).toEqual([[configPath, 'default']]);
  });
});
