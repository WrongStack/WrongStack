/**
 * `/prompts add` took the slug from the ASCII-only title slug, and the loader
 * lists one prompt per slug: two titles without Latin letters (both `prompt`)
 * left the second saved prompt invisible to /prompt and the WebUI picker.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPromptLoader } from '@wrongstack/core/execution';
import { DefaultPromptStore } from '@wrongstack/core/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPromptsCommand } from '../src/prompts-command.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'prompts-slug-'));
  dirs.push(dir);
  const store = new DefaultPromptStore(dir);
  const loader = new DefaultPromptLoader({ paths: { globalPrompts: dir } as never });
  const cmd = buildPromptsCommand(
    () => store,
    () => loader,
    () => undefined,
  );
  const add = async (title: string, content: string) => {
    const out = await cmd.run(`add "${title}" "${content}"`, {} as never);
    loader.invalidateCache();
    return (out as { message: string }).message;
  };
  return { add, loader };
}

describe('/prompts add: unique slug within the layer', () => {
  it('colliding titles get -2, -3 … and every prompt is findable by its slug', async () => {
    const { add, loader } = setup();
    expect(await add('要約', 'S')).toContain('(prompt)');
    expect(await add('翻訳', 'T')).toContain('(prompt-2)');
    expect(await add('Übersicht', 'U')).toContain('(bersicht)');
    expect(await add('Prompt', 'P')).toContain('(prompt-3)');
    expect((await loader.find('prompt'))?.content).toBe('S');
    expect((await loader.find('prompt-2'))?.content).toBe('T');
    expect((await loader.find('prompt-3'))?.content).toBe('P');
    expect(await loader.list()).toHaveLength(4);
  });

  it('a free slug is unchanged, and a title whose slug already ends in -2 still gets a fresh one', async () => {
    const { add, loader } = setup();
    expect(await add('Review', 'a')).toContain('(review)');
    expect(await add('Review 2', 'b')).toContain('(review-2)');
    expect(await add('review', 'c')).toContain('(review-3)');
    expect((await loader.list()).map((e) => e.slug).sort()).toEqual([
      'review',
      'review-2',
      'review-3',
    ]);
  });

  it('strips UTF-8 BOM and rejects null JSON cleanly in /prompts import (F485)', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { buildPromptsCommand } = await import('../src/prompts-command.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'prompts-bom-'));
    try {
      const cmd = buildPromptsCommand(
        () => ({ save: async () => undefined, list: async () => [] }) as never,
        () => ({ reload: async () => undefined }) as never,
        () => undefined,
      );
      const file = path.join(dir, 'prompts.json');
      writeFileSync(file, `\uFEFF${JSON.stringify([{ name: 'p1', content: 'hello' }])}`, 'utf8');
      const bom = await cmd.run(`import ${file}`, { cwd: dir } as never);
      expect((bom as { message?: string }).message).toMatch(/^Imported /);

      writeFileSync(file, 'null', 'utf8');
      const nullRes = await cmd.run(`import ${file}`, { cwd: dir } as never);
      expect((nullRes as { message?: string }).message).toContain('expected a JSON array');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
