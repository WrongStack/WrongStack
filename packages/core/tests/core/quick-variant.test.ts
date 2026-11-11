/**
 * Quick: a minimal identity with at most ten basic tools; the rest of the
 * catalog is reached on demand through `tool_search` / `tool_use`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { loadInstructionBundle } from '../../src/core/instruction-bundle.js';
import { renderInstructionLayer } from '../../src/core/instruction-template.js';
import {
  isSystemInstructionVariant,
  SYSTEM_PROMPT_VARIANTS,
} from '../../src/core/system-prompt-variants.js';
import {
  providerToolsForVariant,
  QUICK_BASIC_TOOL_NAMES,
} from '../../src/registry/scout-tool-surface.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';

const tool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return '';
  },
});

const names = (tools: readonly Tool[]) => tools.map((t) => t.name);

describe('Quick variant', () => {
  it('is a selectable variant', () => {
    expect(SYSTEM_PROMPT_VARIANTS).toContain('quick');
    expect(isSystemInstructionVariant('quick')).toBe(true);
  });

  it('caps the basic tools at ten', () => {
    expect(QUICK_BASIC_TOOL_NAMES.size).toBeLessThanOrEqual(10);
  });

  it('sends the basic set plus the catalog gateway, nothing else', () => {
    const r = new ToolRegistry();
    for (const name of [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
      'fetch',
      'kanban',
      'todo',
      'tool_search',
      'tool_use',
      'delegate',
    ]) {
      r.register(tool(name));
    }
    r.setProviderToolNames(['read', 'kanban', 'tool_search', 'tool_use']);
    const surface = providerToolsForVariant(r, 'quick');
    expect(names(surface)).toEqual([
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
      'fetch',
      'tool_search',
      'tool_use',
    ]);
    expect(providerToolsForVariant(r, 'quick')).toBe(surface);
  });

  it('includes skill directly when the session has required skills armed', () => {
    const r = new ToolRegistry();
    for (const name of ['read', 'write', 'skill', 'tool_search', 'tool_use']) {
      r.register(tool(name));
    }
    expect(names(providerToolsForVariant(r, 'quick'))).not.toContain('skill');
    expect(
      names(
        providerToolsForVariant(r, 'quick', {
          requiredSkills: { required: ['bug-hunter'] },
        }),
      ),
    ).toContain('skill');
  });

  it('loads the short system-quick.md identity', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.resolve(here, '..', '..', 'instructions', 'system-quick.md');
    const text = readFileSync(file, 'utf8');
    expect(text.length).toBeLessThan(2_000);
    const bundle = await loadInstructionBundle({ systemVariant: 'quick' });
    expect(bundle.system?.identity).toContain('WrongStack Quick');
  });

  it('preserves all three numbered workflow steps and denial guardrail even without clarify or gateway tools', async () => {
    const bundle = await loadInstructionBundle({ systemVariant: 'quick' });
    const bare = renderInstructionLayer(bundle.system?.identity ?? '', {
      toolNames: new Set(['read', 'edit', 'bash']),
      tier: 'minimal',
      subagent: false,
      strictToolReferences: true,
    });
    expect(bare).toContain('1. **');
    expect(bare).toContain('2. **');
    expect(bare).toContain('3. **');
    expect(bare).toContain('A denial is final');
    expect(bare).not.toContain('`clarify`');
    expect(bare).not.toContain('`tool_search`');

    const withClarify = renderInstructionLayer(bundle.system?.identity ?? '', {
      toolNames: new Set(['read', 'clarify', 'tool_search', 'tool_use']),
      tier: 'minimal',
      subagent: false,
      strictToolReferences: true,
    });
    expect(withClarify).toContain('`clarify`');
    expect(withClarify).toContain('`tool_search`');
    expect(withClarify).toContain('`tool_use`');
  });
});
