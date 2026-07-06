import type { Config, ModelsRegistry, ResolvedProvider } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { runPicker } from '../src/picker.js';

function makeRenderer() {
  const output: string[] = [];
  return {
    renderer: {
      write: vi.fn((s: unknown) => output.push(String(s))),
      writeLine: vi.fn(),
      writeBlock: vi.fn(),
      writeToolCall: vi.fn(),
      writeToolResult: vi.fn(),
      writeDiff: vi.fn(),
      writeWarning: vi.fn(),
      writeError: vi.fn((s: unknown) => output.push(String(s))),
      writeInfo: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
    },
    output,
  };
}

function makeReader(lines: string[]) {
  let i = 0;
  return {
    readLine: vi.fn(async () => lines[i++] ?? 'q'),
    readSecret: vi.fn(async () => ''),
    close: vi.fn(async () => {}),
  };
}

describe('runPicker respects visible model allowlists', () => {
  it('shows only visible models for a configured provider', async () => {
    const provider: ResolvedProvider = {
      id: 'anthropic',
      name: 'Anthropic',
      family: 'anthropic',
      apiBase: 'https://api.anthropic.com',
      envVars: [],
      models: [
        { id: 'anthropic-test-model', name: 'Anthropic Test Model' },
        { id: 'claude-opus-4', name: 'Claude Opus 4' },
      ],
    } as never;
    const modelsRegistry: ModelsRegistry = {
      listProviders: vi.fn(async () => [provider]),
      getProvider: vi.fn(async () => provider),
      getModel: vi.fn(async () => undefined),
      suggestModel: vi.fn(async () => undefined),
      refresh: vi.fn(async () => ({})),
      ageSeconds: vi.fn(async () => 0),
    } as never;
    const { renderer, output } = makeRenderer();
    const reader = makeReader(['1', 'q']);
    const config = {
      provider: 'anthropic',
      model: 'anthropic-test-model',
      providers: {
        anthropic: {
          type: 'anthropic',
          apiKey: 'x',
          models: ['anthropic-test-model'],
        },
      },
    } as never as Config;

    await runPicker({ modelsRegistry, renderer: renderer as never, reader: reader as never, config });

    const text = output.join('\n');
    expect(text).toContain('anthropic-test-model');
    expect(text).not.toContain('claude-opus-4');
  });
});
