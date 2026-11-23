import { flagsToConfigPatch } from '@wrongstack/core/boot';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';
import { providerToolNames } from '../src/boot/dispatch-singleshot.js';
import { applyHeadlessHarnessDefaults } from '../src/boot/headless-harness-defaults.js';

function launch(
  argv: string[],
  tty: { stdin: boolean; stdout: boolean } = { stdin: true, stdout: true },
) {
  const { flags, positional } = parseArgs(argv);
  const applied = applyHeadlessHarnessDefaults({
    flags,
    positional,
    isSubcommand: (name) => name === 'bench',
    stdinIsTTY: tty.stdin,
    stdoutIsTTY: tty.stdout,
  });
  const patch = flagsToConfigPatch(flags);
  return {
    applied,
    variant: patch.systemPrompt?.variant,
    toolCoach: patch.features?.toolCoach,
  };
}

const harness = ['--provider', 'benchmark', '--model', 'm', '--yolo-plus', '--no-models-refresh'];

describe('applyHeadlessHarnessDefaults', () => {
  it('pins Quick and drops the tool coach for a harness-driven single-shot run', () => {
    expect(launch(['do the task', ...harness, '--output-format', 'stream-json'])).toEqual({
      applied: true,
      variant: 'quick',
      toolCoach: false,
    });
    expect(launch(['--prompt', 'x', '--output-json']).variant).toBe('quick');
    // Spawned without a terminal on either side, text output still counts.
    expect(launch(['do the task', ...harness], { stdin: false, stdout: false }).variant).toBe(
      'quick',
    );
  });

  it('keeps an explicit identity but still drops the coach', () => {
    expect(launch(['x', '--output-json', '--system-pro'])).toEqual({
      applied: true,
      variant: 'pro',
      toolCoach: false,
    });
    expect(launch(['x', '--output-json', '--system-prompt', 'default']).variant).toBe('default');
  });

  it('keeps the profile at a terminal, for subcommands and with --host-profile', () => {
    const untouched = { applied: false, variant: undefined, toolCoach: undefined };
    expect(launch(['do the task', ...harness])).toEqual(untouched);
    // `git diff | wstack "review"` typed at a terminal: stdout is still a TTY.
    expect(launch(['review this'], { stdin: false, stdout: true })).toEqual(untouched);
    expect(launch(['bench', 'run', '--output-json'], { stdin: false, stdout: false })).toEqual(
      untouched,
    );
    expect(launch(['x', '--output-json', '--host-profile'])).toEqual(untouched);
  });

  it('parses its switches as booleans, so they never swallow the prompt', () => {
    for (const flag of ['--host-profile', '--no-tool-coach']) {
      const { flags, positional } = parseArgs([flag, 'the task']);
      expect(flags[flag.slice(2)]).toBe(true);
      expect(positional).toEqual(['the task']);
    }
  });
});

describe('providerToolNames', () => {
  const tool = (name: string) => ({ name }) as never;
  const catalog = ['read', 'bash', 'pwsh', 'tool_search', 'tool_use', 'codebase-search'];
  const registry = {
    list: () => catalog.map(tool),
    listForProvider: () => catalog.map(tool),
    listWithin: (names: ReadonlySet<string>) => catalog.filter((name) => names.has(name)).map(tool),
  };

  it('reports what a Quick session sends, not the whole registry', () => {
    const agent = {
      tools: registry,
      ctx: {
        meta: { systemPromptVariant: 'quick' },
        session: { quickToolSchemaVersion: 2, quickShellTool: 'pwsh' },
      },
    } as never;
    expect(providerToolNames(agent)).toEqual(['read', 'pwsh', 'tool_search', 'tool_use']);
  });

  it('applies the provider filter the agent loop applies', () => {
    const agent = {
      tools: registry,
      ctx: {
        meta: { systemPromptVariant: 'default' },
        provider: { selectToolsForRequest: (tools: Array<{ name: string }>) => tools.slice(0, 2) },
      },
    } as never;
    expect(providerToolNames(agent)).toEqual(['read', 'bash']);
  });
});
