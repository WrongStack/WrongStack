import { describe, expect, it, vi } from 'vitest';
import prDrafterPlugin from '../src/pr-drafter/index.js';
import smartRenamePlugin from '../src/smart-rename/index.js';
import testGeneratorPlugin from '../src/test-generator/index.js';

function collectTools(plugin: { setup: (api: never) => void }) {
  const registered: Array<Record<string, unknown>> = [];
  const api = {
    tools: { register: (tool: Record<string, unknown>) => registered.push(tool) },
    registerHook: () => () => {},
    onEvent: () => () => {},
    registerSystemPromptContributor: () => () => {},
    config: { extensions: {} },
    metrics: { counter: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    llm: { complete: vi.fn() },
    session: { append: vi.fn() },
  };
  plugin.setup(api as never);
  return registered;
}

/**
 * `readonly-permission-policy` decides "may this run in read-only mode?" from
 * `capabilities`, NOT from `mutating` — so a tool that writes files while
 * declaring neither a capability nor a confirmation prompt was invisible to
 * every gate: no prompt, no read-only block, and (because plugin tools reach
 * the executor through `plugin_manager action:'use'`) no PreToolUse hook.
 */
describe('file-writing plugin tools declare what they do', () => {
  it.each([
    ['smart_rename', smartRenamePlugin],
    ['pr_draft', prDrafterPlugin],
  ])('%s declares fs.write and asks for confirmation', (name, plugin) => {
    const tool = collectTools(plugin as never).find((t) => t['name'] === name);
    expect(tool, `${name} should be registered`).toBeDefined();
    expect(tool?.['mutating']).toBe(true);
    expect(tool?.['capabilities']).toContain('fs.write');
    expect(tool?.['permission']).toBe('confirm');
  });
});

describe('generate_unit_tests only reads source files', () => {
  it.each(['.env', 'secrets.json', '.npmrc', 'config.local.json'])(
    'refuses %s even though it is inside the project',
    async (target) => {
      const tool = collectTools(testGeneratorPlugin as never).find(
        (t) => t['name'] === 'generate_unit_tests',
      );
      const execute = tool?.['execute'] as (i: unknown) => Promise<{ ok: boolean; error?: string }>;
      // `use_llm` is a model-controlled input that overrides config, and the
      // prompt embeds the file contents — so containment alone let `.env` be
      // shipped to the provider.
      const res = await execute({ path: target, use_llm: true });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('source files');
    },
  );
});
