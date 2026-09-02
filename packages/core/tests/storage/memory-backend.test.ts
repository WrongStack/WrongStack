import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileMemoryBackend, parseEntries } from '../../src/storage/memory-backend.js';
import type { MemoryEntry } from '../../src/types/memory.js';

let dir: string;
let file: string;
let backend: FileMemoryBackend;
const scope = 'project-memory' as const;

const entry = (text: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  scope,
  text,
  ts: over.ts ?? '2026-01-01T00:00:00Z',
  ...over,
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-backend-'));
  file = path.join(dir, 'memory.md');
  backend = new FileMemoryBackend({ paths: {} as never });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('FileMemoryBackend remember/readAll/list', () => {
  it('creates a new file with a header and serializes metadata', async () => {
    await backend.remember(
      scope,
      entry('uses pnpm', { type: 'convention', priority: 'high', tags: ['build', 'pnpm'] }),
      file,
    );
    const raw = await backend.readAll(scope, file);
    expect(raw).toContain('# Agent Memory');
    expect(raw).toContain('[convention|high]');
    expect(raw).toContain('#build');
  });

  it('appends to an existing file and flattens newlines in the text', async () => {
    await backend.remember(scope, entry('first'), file);
    await backend.remember(scope, entry('second\nline'), file);
    const list = await backend.list(scope, file);
    expect(list.map((e) => e.text)).toContain('second line');
    expect(list.length).toBe(2);
  });

  it('preserves a line boundary when appending to a hand-edited file', async () => {
    await fs.writeFile(file, '# Agent Memory\n\nmanual text without newline');
    await backend.remember(scope, entry('appended safely'), file);
    const raw = await backend.readAll(scope, file);
    expect(raw).toContain('manual text without newline\n- [');
    expect((await backend.list(scope, file)).map((item) => item.text)).toContain('appended safely');
  });

  it('does not lose concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        backend.remember(scope, entry(`concurrent ${index}`), file),
      ),
    );
    expect(await backend.list(scope, file)).toHaveLength(20);
  });

  it('serializes type-only and priority-only metadata', async () => {
    await backend.remember(scope, entry('type only', { type: 'fact' }), file);
    await backend.remember(scope, entry('prio only', { priority: 'low' }), file);
    const raw = await backend.readAll(scope, file);
    expect(raw).toContain('[fact]');
    expect(raw).toContain('[low]');
  });

  it('readAll returns empty for a missing file', async () => {
    expect(await backend.readAll(scope, path.join(dir, 'nope.md'))).toBe('');
  });

  it('list returns [] for an empty file and respects a limit', async () => {
    expect(await backend.list(scope, path.join(dir, 'nope.md'))).toEqual([]);
    await backend.remember(scope, entry('a'), file);
    await backend.remember(scope, entry('b'), file);
    expect((await backend.list(scope, file, 1)).length).toBe(1);
  });
});

describe('FileMemoryBackend search', () => {
  beforeEach(async () => {
    await backend.remember(scope, entry('the pnpm build pipeline', { tags: ['build'] }), file);
    await backend.remember(scope, entry('unrelated note about cats'), file);
  });

  it('scores word and tag matches, filtering out non-matches', async () => {
    const res = await backend.search(scope, 'build', file);
    expect(res.map((e) => e.text)).toContain('the pnpm build pipeline');
    expect(res.map((e) => e.text)).not.toContain('unrelated note about cats');
  });

  it('respects a search limit', async () => {
    await backend.remember(scope, entry('another build thing'), file);
    expect((await backend.search(scope, 'build', file, 1)).length).toBe(1);
  });

  it('matches an exact whole word via the O(1) fast path', async () => {
    await backend.remember(scope, entry('go module resolver'), file);
    const res = await backend.search(scope, 'module', file);
    expect(res.map((e) => e.text)).toContain('go module resolver');
  });

  it('matches a short (2-char) needle by exact word lookup', async () => {
    // "go" is below MIN_SUBSTRING_NEEDLE_LEN, so it only resolves via the
    // exact Map.get path — the substring fallback is skipped for short needles.
    await backend.remember(scope, entry('go module resolver'), file);
    const res = await backend.search(scope, 'go', file);
    expect(res.map((e) => e.text)).toContain('go module resolver');
  });

  it('falls back to substring matching when there is no exact word hit', async () => {
    await backend.remember(scope, entry('the performance audit pass'), file);
    // "perf" is not a stored whole word; the bounded substring fallback should
    // still match it against "performance".
    const res = await backend.search(scope, 'perf', file);
    expect(res.map((e) => e.text)).toContain('the performance audit pass');
  });

  it('does not substring-match on a sub-3-char needle (selectivity guard)', async () => {
    await backend.remember(scope, entry('cattle ranch notes'), file);
    // "ca" would substring-match "cattle"/"cats" under the old full-scan, but
    // it is below the fallback length gate and has no exact word hit, so it
    // returns nothing.
    const res = await backend.search(scope, 'ca', file);
    expect(res.map((e) => e.text)).not.toContain('cattle ranch notes');
    expect(res.map((e) => e.text)).not.toContain('unrelated note about cats');
  });

  it('weights tag matches above plain word matches', async () => {
    // Two entries both contain the word "deploy"; only one carries it as a tag.
    await backend.remember(scope, entry('deploy via script', { tags: ['ci'] }), file);
    await backend.remember(scope, entry('notes', { tags: ['deploy'] }), file);
    const res = await backend.search(scope, 'deploy', file);
    // Tag match (+2) outranks the word match (+1), so the tagged entry is first.
    expect(res[0]?.text).toBe('notes');
  });
});

describe('FileMemoryBackend forget/clear/consolidate', () => {
  it('forgets by text needle and reports the count', async () => {
    await backend.remember(scope, entry('keep me'), file);
    await backend.remember(scope, entry('drop me'), file);
    expect(await backend.forget(scope, 'drop', file)).toBe(1);
    expect((await backend.list(scope, file)).map((e) => e.text)).toEqual(['keep me']);
  });

  it('forgets by exact entry id', async () => {
    await backend.remember(scope, entry('find my id'), file);
    const raw = await backend.readAll(scope, file);
    const id = /mem_\d+_\w+/.exec(raw)?.[0] as string;
    expect(await backend.forget(scope, id, file)).toBe(1);
  });

  it('returns 0 when forgetting from a missing file', async () => {
    expect(await backend.forget(scope, 'x', path.join(dir, 'nope.md'))).toBe(0);
  });

  it('empties the file when the last entry is forgotten', async () => {
    await backend.remember(scope, entry('only one'), file);
    await backend.forget(scope, 'only one', file);
    expect((await backend.list(scope, file)).length).toBe(0);
  });

  it('writes an empty file when every line is removed by forget', async () => {
    // A bullet-only file (no header) reduces to zero lines after the match.
    await fs.writeFile(file, '- [2026-01-01T00:00:00Z] mem_9_zzzz removeme');
    expect(await backend.forget(scope, 'removeme', file)).toBe(1);
    expect(await backend.readAll(scope, file)).toBe('');
  });

  it('clear truncates the file', async () => {
    await backend.remember(scope, entry('to clear'), file);
    await backend.clear(scope, file);
    expect(await backend.readAll(scope, file)).toBe('');
  });

  it('consolidate dedupes normalized duplicate entries and writes a backup', async () => {
    await backend.remember(scope, entry('prefer pnpm', { ts: '2026-01-01T00:00:00Z' }), file);
    await backend.remember(scope, entry('prefer pnpm', { ts: '2026-02-02T00:00:00Z' }), file);
    const removed = await backend.consolidate(scope, file);
    expect(removed).toBe(1);
    const bak = (await fs.readdir(dir)).find((f) => f.includes('.bak.'));
    expect(bak).toBeTruthy();
  });

  it('keeps only the five newest consolidate backups', async () => {
    await backend.remember(scope, entry('prefer pnpm', { ts: '2026-01-01T00:00:00Z' }), file);
    await backend.remember(scope, entry('prefer pnpm', { ts: '2026-02-02T00:00:00Z' }), file);

    for (let i = 0; i < 8; i++) {
      await fs.writeFile(path.join(dir, `memory.md.bak.${1700000000000 + i}`), 'old');
    }

    await backend.consolidate(scope, file);

    const backups = (await fs.readdir(dir)).filter((fileName) =>
      fileName.startsWith('memory.md.bak.'),
    );
    expect(backups).toHaveLength(5);
  });

  it('consolidate returns 0 for a missing file', async () => {
    expect(await backend.consolidate(scope, path.join(dir, 'nope.md'))).toBe(0);
  });
});

describe('parseEntries / lineToEntry branches', () => {
  it('parses every metadata form and skips malformed lines', () => {
    // Parser order: `- [ts] [type|priority] mem_id text #tags`
    const raw = [
      '# Agent Memory',
      '- [2026-01-01] [convention|high] mem_1_aaaa use pnpm #build #pnpm', // type+priority+id+tags
      '- [2026-01-02] [high|extra] priority via first slot', // isMemoryType false → isPriority true
      '- [2026-01-03] [fact|bogus] valid type, bogus priority', // type set, priority undefined
      '- [2026-01-04] [bogus|nope] neither valid', // both invalid
      '- [2026-01-05] old format no id here', // no mem_ id
      '- [2026-01-06] mem_2_bbbb #onlytags', // empty after tag strip → skipped
      '- [unclosed bracket text', // no closing ] → skipped
      '- not a bracketed line', // does not start with "- [" → skipped
      'plain text line', // not a bullet → skipped
    ].join('\n');
    const entries = parseEntries(raw, scope);
    const byText = Object.fromEntries(entries.map((e) => [e.text, e]));

    expect(byText['use pnpm']).toMatchObject({ type: 'convention', priority: 'high' });
    expect(byText['use pnpm']?.tags).toEqual(['build', 'pnpm']);
    expect(byText['priority via first slot']).toMatchObject({ priority: 'high' });
    expect(byText['priority via first slot']?.type).toBeUndefined();
    expect(byText['valid type, bogus priority']).toMatchObject({ type: 'fact' });
    expect(byText['valid type, bogus priority']?.priority).toBeUndefined();
    expect(byText['neither valid']).toBeDefined();
    expect(byText['old format no id here']).toBeDefined();
    // malformed / empty lines produce no entries
    expect(entries.some((e) => e.text.includes('onlytags'))).toBe(false);
    expect(entries.some((e) => e.text.includes('unclosed'))).toBe(false);
  });

  it('returns newest-first order', () => {
    const raw = ['- [2026-01-01] mem_1_a first', '- [2026-01-02] mem_2_b second'].join('\n');
    const entries = parseEntries(raw, scope);
    expect(entries.map((e) => e.text)).toEqual(['second', 'first']);
  });
});
