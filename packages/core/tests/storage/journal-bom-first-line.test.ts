import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSessionDataFromFile } from '../../src/storage/session-store/load-session-data.js';
import { searchSessionEvents } from '../../src/storage/session-store/search-events.js';
import { summarizeSessionFile } from '../../src/storage/session-store/summary-builder.js';

const passthroughScrubber: SecretScrubber = { scrub: (text) => text, scrubObject: (obj) => obj };
const JOURNAL = `${[
  JSON.stringify({
    type: 'session_start',
    ts: '2026-11-26T10:00:00.000Z',
    model: 'model-x',
    provider: 'prov-x',
  }),
  JSON.stringify({ type: 'user_input', ts: '2026-11-26T10:01:00.000Z', content: 'fix the build' }),
].join('\n')}\n`;

/**
 * F2356: every other persisted-JSON reader in core strips a leading BOM before
 * `JSON.parse` (config-json.ts, goal-store.ts, task-store.ts, plan-store.ts,
 * annotations-store.ts, ...). A BOM on a journal's first line therefore used to
 * silently drop `session_start`: the session reported 1970 / unknown model and
 * the event disappeared from load, summary and search.
 */
describe('journal readers tolerate a leading BOM (F2356)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-bom-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function write(name: string, body: string): Promise<string> {
    const file = path.join(dir, `${name}.jsonl`);
    await fsp.writeFile(file, body, 'utf8');
    return file;
  }

  it('keeps the session metadata that lives on the first line', async () => {
    const file = await write('bom', `\uFEFF${JOURNAL}`);
    const loaded = await loadSessionDataFromFile({
      id: 'bom',
      file,
      full: true,
      secretScrubber: passthroughScrubber,
    });

    expect(loaded.metadata.startedAt).toBe('2026-11-26T10:00:00.000Z');
    expect(loaded.metadata.model).toBe('model-x');
    expect(loaded.events.map((event) => event.type)).toEqual(['session_start', 'user_input']);
  });

  it('keeps the summary counters the same as the BOM-less journal', async () => {
    const summary = await summarizeSessionFile({
      id: 'bom',
      file: await write('bom', `\uFEFF${JOURNAL}`),
      mtime: '2026-11-26T12:00:00.000Z',
      secretScrubber: passthroughScrubber,
    });

    expect(summary.startedAt).toBe('2026-11-26T10:00:00.000Z');
    expect(summary.model).toBe('model-x');
    expect(summary.title).toBe('fix the build');
  });

  it('keeps event indices aligned with the BOM-less journal in search', async () => {
    const hits = await searchSessionEvents({
      file: await write('bom', `\uFEFF${JOURNAL}`),
      secretScrubber: passthroughScrubber,
      predicate: () => true,
    });

    expect(hits.map((hit) => `${hit.event.type}@${hit.eventIndex}`)).toEqual([
      'session_start@0',
      'user_input@1',
    ]);
  });
});
