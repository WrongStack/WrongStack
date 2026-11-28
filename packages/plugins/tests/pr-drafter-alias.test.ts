/**
 * FIX22 — PR-draft output path is checked lexically; an in-project symlink can
 * alias a protected destination (.git/hooks/pre-commit) and be overwritten.
 * Contract: pr-drafter/index.ts:498-501 ("outputPath resolves outside project")
 * + core file tools canonicalize before writing (SA3 pattern).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import plugin from '../src/pr-drafter/index.js';

interface Tool { name: string; execute: (i: Record<string, unknown>) => Promise<Record<string, unknown>> }

function setup(): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  const api = {
    tools: { register: (t: Tool) => void (tools[t.name] = t) },
    config: { extensions: {}, cwd: process.cwd() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), gauge: vi.fn(), histogram: vi.fn() },
    onEvent: vi.fn(),
    onConfigChange: vi.fn(),
    registerHook: vi.fn(() => () => {}),
    registerSystemPromptContributor: () => () => {},
    slashCommands: { register: vi.fn(), unregister: vi.fn() },
  };
  plugin.setup(api as never);
  return tools;
}

describe('FIX22 — pr_draft alias write', () => {
  it('control: an ordinary output path is written', async () => {
    const prev = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'fix22-'));
    try {
      process.chdir(dir);
      const tools = setup();
      const r = await tools.pr_draft!.execute({ outputPath: 'draft.md' });
      expect(r.ok).toBe(true);
      console.log('FIX22 CONTROL OK');
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('symlink alias to a git hook must be refused', async () => {
    const prev = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'fix22-'));
    try {
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
      symlinkSync(join(dir, '.git', 'hooks', 'pre-commit'), join(dir, 'draft.md'));
      process.chdir(dir);
      const tools = setup();
      let refused = false;
      try { await tools.pr_draft!.execute({ outputPath: 'draft.md' }); } catch { refused = true; }
      const hookPath = join(dir, '.git', 'hooks', 'pre-commit');
      const landed = existsSync(hookPath) && readFileSync(hookPath, 'utf8').includes('PR Draft');
      console.log('EXPECTED: refusal; git hook untouched');
      console.log('ACTUAL:', JSON.stringify({ refused, hookExists: existsSync(hookPath) }));
      console.log(refused && !landed ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
      expect(refused).toBe(true);
      expect(landed).toBe(false);
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
