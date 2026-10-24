import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PromptEntry } from '@wrongstack/contracts/types/prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPromptLoader, renderPrompt } from '../../src/execution/prompt-loader.js';
import { DefaultPromptStore } from '../../src/storage/prompt-store.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

function entry(slug: string, over: Partial<PromptEntry> = {}): PromptEntry {
  const now = new Date(0).toISOString();
  return {
    id: over.id ?? `id-${slug}`,
    slug,
    title: over.title ?? slug,
    description: over.description ?? '',
    content: over.content ?? `content of ${slug}`,
    category: over.category ?? 'coding',
    tags: over.tags ?? [],
    source: over.source ?? 'builtin',
    favorite: over.favorite ?? false,
    variables: over.variables,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('DefaultPromptLoader', () => {
  let tmp: string;
  let projectRoot: string;
  let globalRoot: string;
  let bundledDir: string;
  let paths: ReturnType<typeof resolveWstackPaths>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-loader-'));
    projectRoot = path.join(tmp, 'proj');
    globalRoot = path.join(tmp, 'global');
    bundledDir = path.join(tmp, 'bundled');
    await fs.mkdir(projectRoot, { recursive: true });
    paths = resolveWstackPaths({ projectRoot, globalRoot });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeBuiltin(e: PromptEntry): Promise<void> {
    const dir = path.join(bundledDir, 'prompts', e.category);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${e.slug}.json`), JSON.stringify(e, null, 2));
  }

  it('returns builtin prompts when only the bundled layer exists', async () => {
    await writeBuiltin(entry('hello'));
    await writeBuiltin(entry('world', { category: 'writing' }));
    const loader = new DefaultPromptLoader({ paths, bundledDir });
    const all = await loader.list();
    expect(all.map((e) => e.slug).sort()).toEqual(['hello', 'world']);
    expect(all.every((e) => e.source === 'builtin')).toBe(true);
  });

  it('shadows a builtin with a same-slug user prompt (user wins)', async () => {
    await writeBuiltin(entry('greet', { content: 'builtin greet' }));
    const userStore = new DefaultPromptStore(paths.globalPrompts);
    await userStore.save(entry('greet', { id: 'u1', source: 'user', content: 'user greet' }));

    const loader = new DefaultPromptLoader({ paths, bundledDir });
    const all = await loader.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.content).toBe('user greet');
    expect(all[0]?.source).toBe('user');
  });

  it('project layer shadows both user and builtin', async () => {
    await writeBuiltin(entry('x', { content: 'builtin' }));
    await new DefaultPromptStore(paths.globalPrompts).save(
      entry('x', { id: 'u', source: 'user', content: 'user' }),
    );
    await new DefaultPromptStore(paths.inProjectPrompts).save(
      entry('x', { id: 'p', content: 'project' }),
    );

    const loader = new DefaultPromptLoader({ paths, bundledDir });
    const all = await loader.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.content).toBe('project');
    expect(all[0]?.source).toBe('project');
  });

  it('search ranks title matches above content matches and filters by category', async () => {
    await writeBuiltin(
      entry('deploy-script', { title: 'Deploy Script', category: 'devops', content: 'ship it' }),
    );
    await writeBuiltin(
      entry('review', {
        title: 'Code Review',
        category: 'code-review',
        content: 'deploy mentions',
      }),
    );
    const loader = new DefaultPromptLoader({ paths, bundledDir });

    const ranked = await loader.search('deploy');
    expect(ranked[0]?.slug).toBe('deploy-script'); // title hit outranks content hit

    const filtered = await loader.search('', { category: 'devops' });
    expect(filtered.map((e) => e.slug)).toEqual(['deploy-script']);
  });

  it('fuzzy-matches abbreviations/typos when no substring matches', async () => {
    await writeBuiltin(entry('deploy-script', { title: 'Deploy Script', category: 'devops' }));
    await writeBuiltin(entry('review', { title: 'Code Review', category: 'code-review' }));
    const loader = new DefaultPromptLoader({ paths, bundledDir });

    // "dpl" is a subsequence of "deploy" but not a substring of anything.
    const fuzzy = await loader.search('dpl');
    expect(fuzzy.map((e) => e.slug)).toContain('deploy-script');
    // A non-subsequence query still returns nothing.
    expect(await loader.search('zzzq')).toEqual([]);
  });

  it('categories() returns counts with labels', async () => {
    await writeBuiltin(entry('a', { category: 'coding' }));
    await writeBuiltin(entry('b', { category: 'coding' }));
    await writeBuiltin(entry('c', { category: 'testing' }));
    const loader = new DefaultPromptLoader({ paths, bundledDir });
    const cats = await loader.categories();
    expect(cats[0]).toMatchObject({ id: 'coding', label: 'Coding', count: 2 });
    expect(cats.find((c) => c.id === 'testing')).toMatchObject({ count: 1 });
  });

  it('favoriting a builtin copies it down into the user layer (copy-on-write)', async () => {
    await writeBuiltin(entry('fav-me', { content: 'original' }));
    const loader = new DefaultPromptLoader({ paths, bundledDir });

    const updated = await loader.setFavorite('fav-me', true);
    expect(updated?.favorite).toBe(true);
    expect(updated?.source).toBe('user');
    expect(updated?.forkedFrom).toBe('fav-me');

    // The bundled file is untouched; the user layer now holds the favorite.
    const userFiles = await fs.readdir(paths.globalPrompts);
    expect(userFiles.length).toBe(1);

    // list() now shows the user copy (shadows builtin), still one slug.
    const all = await loader.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.favorite).toBe(true);
    expect(all[0]?.source).toBe('user');
  });

  it('delete() refuses builtin prompts but removes user prompts', async () => {
    await writeBuiltin(entry('builtin-one'));
    await new DefaultPromptStore(paths.globalPrompts).save(
      entry('user-one', { id: 'u', source: 'user' }),
    );
    const loader = new DefaultPromptLoader({ paths, bundledDir });

    expect(await loader.delete('builtin-one')).toBe(false);
    expect(await loader.delete('user-one')).toBe(true);
    expect((await loader.list()).map((e) => e.slug)).toEqual(['builtin-one']);
  });

  it('save() never persists source:builtin into a writable layer', async () => {
    const loader = new DefaultPromptLoader({ paths, bundledDir });
    await loader.save(entry('imported', { source: 'builtin' }));
    const all = await loader.list();
    expect(all[0]?.source).toBe('user');
    expect(all[0]?.forkedFrom).toBe('imported');
  });
});

describe('renderPrompt', () => {
  it('fills provided values and reports missing required variables', () => {
    const e = entry('tmpl', {
      content: 'Refactor {{file}} to use {{pattern}}.',
      variables: [
        { name: 'file', required: true },
        { name: 'pattern', required: true },
      ],
    });
    const r1 = renderPrompt(e, { file: 'a.ts', pattern: 'strategy' });
    expect(r1.text).toBe('Refactor a.ts to use strategy.');
    expect(r1.missing).toEqual([]);

    const r2 = renderPrompt(e, { file: 'a.ts' });
    expect(r2.missing).toEqual(['pattern']);
    expect(r2.text).toContain('{{pattern}}'); // left intact
  });

  it('uses declared defaults when no value is supplied', () => {
    const e = entry('def', {
      content: 'Hello {{name}}',
      variables: [{ name: 'name', default: 'world' }],
    });
    expect(renderPrompt(e).text).toBe('Hello world');
  });

  it('leaves unknown placeholders untouched', () => {
    const e = entry('plain', { content: 'no {{unknown}} here' });
    const r = renderPrompt(e, {});
    expect(r.text).toBe('no {{unknown}} here');
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it('reports an enum value outside the declared set as invalid', () => {
    const e = entry('enm', {
      content: 'Use {{flavor}} syntax',
      variables: [{ name: 'flavor', required: true, enum: ['PCRE', 'JavaScript'] }],
    });
    // A value inside the set renders cleanly.
    const ok = renderPrompt(e, { flavor: 'PCRE' });
    expect(ok.text).toBe('Use PCRE syntax');
    expect(ok.invalid).toEqual([]);
    expect(ok.missing).toEqual([]);
    // A value outside the set is flagged (and still substituted into text).
    const bad = renderPrompt(e, { flavor: 'Perl6' });
    expect(bad.invalid).toEqual(['flavor']);
    // An empty value is "not chosen yet" — never flagged invalid.
    const empty = renderPrompt(e, { flavor: '' });
    expect(empty.invalid).toEqual([]);
  });

  it('treats empty string as unsupplied for defaults/required and deduplicates repeated missing placeholders (F149)', () => {
    const e = entry('empty-and-dup', {
      content: 'Deploy {{target}} and verify {{target}} using {{flavor}}.',
      variables: [
        { name: 'target', required: true },
        { name: 'flavor', default: 'standard', enum: ['standard', 'fast'] },
      ],
    });
    const rEmpty = renderPrompt(e, { target: '', flavor: '' });
    expect(rEmpty.text).toBe('Deploy {{target}} and verify {{target}} using standard.');
    expect(rEmpty.missing).toEqual(['target']);

    const rDup = renderPrompt(e, {});
    expect(rDup.missing).toEqual(['target']);
  });
});
