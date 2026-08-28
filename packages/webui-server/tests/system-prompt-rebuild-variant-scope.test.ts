/**
 * The identity variant belongs to the tab whose prompt is being rebuilt.
 *
 * `rebuildSystemPrompt` used to read `config.systemPrompt.variant`, which is
 * the variant whichever tab picked LAST. Any rebuild in another tab — a mode
 * switch, a skill reload, an identity pick — then recomposed that tab's prompt
 * from a sibling's identity, which is precisely the context mixing four
 * independent tabs must not have. The context's own meta answers first now;
 * the config stays the fallback for a tab that never chose and for the
 * single-session surfaces (CLI, TUI) that keep no per-context meta.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context } from '@wrongstack/core/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildSystemPrompt } from '../src/server/system-prompt-rebuild.js';

/** A line that appears in system-pro.md and in neither other variant. */
const PRO_MARKER = 'Assumption ledger';
/** Likewise for system-lite.md. */
const LITE_MARKER = 'Use only tools that appear in the live tool list';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-variant-scope-'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function tabContext(variant?: string): Context {
  const ctx = new Context({
    systemPrompt: [],
    provider: { id: 'mock', capabilities: { streaming: false, tools: false, maxContext: 8000 } },
    signal: new AbortController().signal,
    session: { id: 'sess', append: async () => undefined, flush: async () => undefined },
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
    tools: [],
    catalogTools: [],
  } as never);
  if (variant) ctx.meta['systemPromptVariant'] = variant;
  return ctx;
}

async function rebuild(context: Context, projectVariant: string): Promise<string> {
  await rebuildSystemPrompt(
    {
      modeStore: undefined,
      memoryStore: undefined,
      skillLoader: undefined,
      modelCapabilities: undefined as never,
      context,
      toolRegistry: { list: () => [], listForProvider: () => [] } as never,
      getConfig: () => ({
        provider: 'mock',
        model: 'test-model',
        features: { mcp: false, plugins: false, memory: false, modelsRegistry: false, skills: false },
        systemPrompt: { variant: projectVariant as never },
      }),
      projectRoot: tmp,
      globalRoot: path.join(tmp, 'global'),
    },
    'default',
  );
  return context.systemPrompt.map((block) => block.text).join(SEPARATOR);
}

const SEPARATOR = String.fromCharCode(10);

describe('rebuildSystemPrompt identity-variant scope', () => {
  it('rebuilds a tab with ITS variant, not the one the project last saved', async () => {
    const prompt = await rebuild(tabContext('lite'), 'pro');

    expect(prompt).toContain(LITE_MARKER);
    expect(prompt).not.toContain(PRO_MARKER);
  });

  it('falls back to the project variant for a tab that never chose', async () => {
    const prompt = await rebuild(tabContext(), 'pro');

    expect(prompt).toContain(PRO_MARKER);
  });

  it('keeps two tabs apart across back-to-back rebuilds', async () => {
    // Tab A picked pro, tab B picked lite; the project config says pro
    // because A picked last. B's rebuild must not inherit it.
    const a = await rebuild(tabContext('pro'), 'pro');
    const b = await rebuild(tabContext('lite'), 'pro');

    expect(a).toContain(PRO_MARKER);
    expect(b).toContain(LITE_MARKER);
    expect(b).not.toContain(PRO_MARKER);
  });

  it('ignores a meta value that names no known variant', async () => {
    const prompt = await rebuild(tabContext('nonsense'), 'pro');

    expect(prompt).toContain(PRO_MARKER);
  });
});
