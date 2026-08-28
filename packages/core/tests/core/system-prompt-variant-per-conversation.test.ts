/**
 * The identity variant belongs to the CONVERSATION, not the process.
 *
 * `DefaultSystemPromptBuilder` is one instance per process — bound into the
 * container at boot — and it used to take Lite/Standard/Pro once, from the boot
 * config, and memoise the loaded bundle forever. With four WebUI tabs on that
 * one process the consequences were both directions of the same bug:
 *
 *   - choosing a lighter identity in a tab was undone on that tab's very next
 *     turn, because `Agent.run`'s pre-run prompt refresh rebuilt from the
 *     process's variant; and
 *   - whichever variant happened to load first was the one every tab got.
 *
 * The variant is now a per-build input read from `ctx.meta`, and the bundle is
 * cached per variant, so one builder serves three different identities at once.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DefaultSystemPromptBuilder } from '@wrongstack/core/core';
import type { BuildContext } from '@wrongstack/core/types';
import { beforeAll, describe, expect, it } from 'vitest';

let bundledDir: string;

beforeAll(() => {
  bundledDir = mkdtempSync(path.join(tmpdir(), 'ws-variant-'));
  mkdirSync(path.join(bundledDir, 'sections'), { recursive: true });
  writeFileSync(path.join(bundledDir, 'system.md'), 'IDENTITY-DEFAULT');
  writeFileSync(path.join(bundledDir, 'system-lite.md'), 'IDENTITY-LITE');
  writeFileSync(path.join(bundledDir, 'system-pro.md'), 'IDENTITY-PRO');
});

function buildContext(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    cwd: '/repo',
    projectRoot: '/repo',
    tools: [],
    provider: 'mock',
    model: 'test-model',
    ...overrides,
  };
}

function textOf(blocks: Array<{ text?: string }>): string {
  return blocks.map((block) => block.text ?? '').join('\n');
}

describe('system prompt identity variant', () => {
  it('serves a different identity per build from ONE builder', async () => {
    const builder = new DefaultSystemPromptBuilder({
      injectMemory: false,
      instructionPaths: { bundledDir, systemVariant: 'default' },
    });

    // Lite first, so a memoised "first variant wins" would pin Lite and the
    // default build below would come back wrong.
    const lite = textOf(await builder.build(buildContext({ systemVariant: 'lite' })));
    const standard = textOf(await builder.build(buildContext()));
    const pro = textOf(await builder.build(buildContext({ systemVariant: 'pro' })));

    expect(lite).toContain('IDENTITY-LITE');
    expect(lite).not.toContain('IDENTITY-DEFAULT');
    expect(standard).toContain('IDENTITY-DEFAULT');
    expect(standard).not.toContain('IDENTITY-LITE');
    expect(pro).toContain('IDENTITY-PRO');
  });

  it('falls back to the builder’s configured variant when a build names none', async () => {
    // Single-conversation hosts (CLI, TUI) never pass one; they must keep the
    // variant they were constructed with.
    const builder = new DefaultSystemPromptBuilder({
      injectMemory: false,
      instructionPaths: { bundledDir, systemVariant: 'pro' },
    });

    expect(textOf(await builder.build(buildContext()))).toContain('IDENTITY-PRO');
  });

  it('keeps answering the same variant consistently once cached', async () => {
    const builder = new DefaultSystemPromptBuilder({
      injectMemory: false,
      instructionPaths: { bundledDir, systemVariant: 'default' },
    });

    for (const variant of ['lite', 'pro', 'lite', 'default'] as const) {
      const text = textOf(await builder.build(buildContext({ systemVariant: variant })));
      expect(text).toContain(`IDENTITY-${variant.toUpperCase()}`);
    }
  });
});
