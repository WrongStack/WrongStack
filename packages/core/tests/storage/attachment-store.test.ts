import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultAttachmentStore } from '../../src/storage/attachment-store.js';

describe('DefaultAttachmentStore', () => {
  it('assigns sequential seqs per kind and stable ids', async () => {
    const store = new DefaultAttachmentStore();
    const a = await store.add({ kind: 'text', data: 'hello' });
    const b = await store.add({ kind: 'text', data: 'world' });
    const c = await store.add({ kind: 'image', data: 'aGk=', meta: { mediaType: 'image/png' } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(1);
    expect(a.id).not.toBe(b.id);
  });

  it('expands placeholders for known refs and preserves unknown ones', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'text', data: 'lorem ipsum' });
    const blocks = await store.expand('see [pasted #1] and [pasted #9] for details');
    // All pure-text expansions merge into one text block
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('see ');
    expect(text).toContain('lorem ipsum');
    expect(text).toContain('[pasted #9]'); // unknown preserved literally
    expect(text).toContain('for details');
  });

  it('keeps image blocks separate from surrounding text', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'image', data: 'AAAA', meta: { mediaType: 'image/png' } });
    const blocks = await store.expand('before [image #1] after');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'text', text: 'before ' });
    expect(blocks[1]).toMatchObject({ type: 'image' });
    expect(blocks[2]).toEqual({ type: 'text', text: ' after' });
  });

  it('expands an image placeholder to a base64 image block', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({
      kind: 'image',
      data: 'iVBORw0KGgo=',
      meta: { mediaType: 'image/png' },
    });
    const blocks = await store.expand('look: [image #1]');
    const img = blocks.find((b) => b.type === 'image');
    expect(img).toBeDefined();
    expect(img).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('returns plain text unchanged when no placeholders', async () => {
    const store = new DefaultAttachmentStore();
    const blocks = await store.expand('just text here');
    expect(blocks).toEqual([{ type: 'text', text: 'just text here' }]);
  });

  it('returns empty array for empty input', async () => {
    const store = new DefaultAttachmentStore();
    const blocks = await store.expand('');
    expect(blocks).toEqual([]);
  });

  it('spools large payloads to disk and re-reads them on expand', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-att-'));
    const store = new DefaultAttachmentStore({ spoolDir: dir, spoolThresholdBytes: 16 });
    const big = 'x'.repeat(1024);
    const ref = await store.add({ kind: 'text', data: big });
    const att = await store.get(ref.id);
    expect(att?.path).toBeDefined();
    expect(att?.data).toBeUndefined();
    const blocks = await store.expand('[pasted #1]');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain(big);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('clear() resets state and unlinks spooled files on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-att-clear-'));
    const store = new DefaultAttachmentStore({ spoolDir: dir, spoolThresholdBytes: 8 });
    // Two large entries get spooled to disk
    const ref1 = await store.add({ kind: 'text', data: 'a'.repeat(64) });
    const ref2 = await store.add({ kind: 'text', data: 'b'.repeat(64) });
    const att1 = await store.get(ref1.id);
    const att2 = await store.get(ref2.id);
    expect(att1?.path).toBeDefined();
    expect(att2?.path).toBeDefined();
    // Both files exist before clear
    await expect(fs.stat(att1!.path!)).resolves.toBeDefined();
    // Clear unlinks them
    await store.clear();
    await expect(fs.stat(att1!.path!)).rejects.toThrow();
    await expect(fs.stat(att2!.path!)).rejects.toThrow();
    expect(store.list()).toEqual([]);
    expect(await store.get(ref1.id)).toBeUndefined();
    // Sequence resets — next add starts at seq 1 again
    const ref3 = await store.add({ kind: 'text', data: 'c' });
    expect(ref3.seq).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('clear() handles non-spooled in-memory entries', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'text', data: 'small' });
    await store.add({ kind: 'image', data: 'AAAA' });
    expect(store.list()).toHaveLength(2);
    await store.clear();
    expect(store.list()).toEqual([]);
  });

  it('expands a `file` placeholder into a file-wrapped text block', async () => {
    const store = new DefaultAttachmentStore();
    const ref = await store.add({
      kind: 'file',
      data: 'export const x = 1;',
      meta: { filename: 'a.ts' },
    });
    expect(ref.kind).toBe('file');
    const blocks = await store.expand('see [file #1] please');
    // Adjacent text blocks merge — expect a single text block containing
    // the surrounding prose plus the <file>...</file> wrapping.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('<file path="a.ts">');
    expect(text).toContain('export const x = 1;');
    expect(text).toContain('</file>');
  });

  it('expands a `pasted` placeholder when filename meta is absent', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'text', data: 'just pasted text' });
    const blocks = await store.expand('[pasted #1]');
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('<pasted>');
    expect(text).toContain('just pasted text');
    expect(text).toContain('</pasted>');
  });

  it('resolves a seq-keyed token with a cosmetic suffix (`#N, L lines`)', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'text', data: 'multi\nline\npaste' });
    const blocks = await store.expand('see [pasted #1, 123 lines] here');
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('multi\nline\npaste');
    expect(text).not.toContain('123 lines'); // the suffix is cosmetic, not literal
  });

  it('resolves an image token with a cosmetic suffix', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'image', data: 'AAAA', meta: { mediaType: 'image/png' } });
    const blocks = await store.expand('[image #1, PNG]');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image' });
  });

  it('resolves a path-keyed `[file:<path>]` token by its registered path', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({
      kind: 'file',
      data: 'export const x = 1;',
      meta: { filename: 'src/a.ts', label: 'src/a.ts' },
    });
    const blocks = await store.expand('look at [file:src/a.ts] now');
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('<file path="src/a.ts">');
    expect(text).toContain('export const x = 1;');
  });

  it('keeps an unknown path-keyed token literal', async () => {
    const store = new DefaultAttachmentStore();
    const blocks = await store.expand('missing [file:nope/none.ts] ok');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { text: string }).text).toContain('[file:nope/none.ts]');
  });

  it('resolves a duplicated path to the most recently registered file', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({ kind: 'file', data: 'OLD', meta: { filename: 'dup.ts' } });
    await store.add({ kind: 'file', data: 'NEW', meta: { filename: 'dup.ts' } });
    const blocks = await store.expand('[file:dup.ts]');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('NEW');
    expect(text).not.toContain('OLD');
  });

  it('resolves path-keyed tokens with Windows backslash separators', async () => {
    const store = new DefaultAttachmentStore();
    await store.add({
      kind: 'file',
      data: 'const win = true;',
      meta: { filename: 'src/windows.ts' },
    });
    const blocks = await store.expand('check [file:src\\windows.ts] please');
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('<file path="src/windows.ts">');
    expect(text).toContain('const win = true;');
  });
});
