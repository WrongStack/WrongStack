import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { handleFileContentSearch } from '../src/server/file-content-search.js';

/**
 * F1390: a case-insensitive `files.search` located the match in
 * `line.toLowerCase()` and reported that index as the column in the original
 * line. `İ` (U+0130) lowercases to two code units, so each one before the match
 * pushed the column (and the preview window) to the right.
 */

const owned: string[] = [];
afterEach(async () => {
  for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true });
});

type Hit = { path: string; line: number; column: number; preview: string };
async function search(root: string, payload: Record<string, unknown>): Promise<Hit[]> {
  const frames: Array<{ payload: { hits: Hit[] } }> = [];
  const ws = { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)) };
  await handleFileContentSearch(ws as unknown as WebSocket, { payload }, root);
  return frames[0]!.payload.hits;
}

it('reports the column of the match in the original line after dotted capital I', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-search-casefold-'));
  owned.push(root);
  const line = 'İzmir İstanbul parser';
  await writeFile(join(root, 'a.txt'), `${line}\n`);
  const [hit] = await search(root, { query: 'parser' });
  expect(hit).toMatchObject({ path: 'a.txt', line: 1, column: 16 });
  expect(line.slice(hit!.column - 1, hit!.column - 1 + 'parser'.length)).toBe('parser');
  // Folding keeps İ on its base letter, so a lowercase query finds it.
  const [city] = await search(root, { query: 'istanbul' });
  expect(city).toMatchObject({ column: 7 });
  // Case-sensitive search was already exact.
  expect((await search(root, { query: 'parser', matchCase: true }))[0]).toMatchObject({
    column: 16,
  });
});

it('keeps the match inside the preview of a long line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-search-casefold-'));
  owned.push(root);
  const line = `${'İ'.repeat(400)} needle tail`;
  await writeFile(join(root, 'long.txt'), `${line}\n`);
  const [hit] = await search(root, { query: 'needle' });
  expect(hit?.column).toBe(402);
  expect(hit?.preview).toContain('needle');
});
