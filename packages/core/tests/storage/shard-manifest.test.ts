import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readOrBuildShardManifestEntry } from '../../src/storage/session-store/shard-manifest.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('readOrBuildShardManifestEntry (F505)', () => {
  it('parses UTF-8 BOM manifest files without triggering a full shard rebuild', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f505-'));
    temps.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      `\uFEFF${JSON.stringify({ summaries: [], ids: ['s1'] })}`,
      'utf8',
    );

    let rebuilt = false;
    const entry = await readOrBuildShardManifestEntry({
      shardKey: '2026-11',
      manifestPath,
      concurrency: 2,
      async collectSessionFilesInShard() {
        rebuilt = true;
        return [];
      },
      async readSummaryManifest() {
        return null;
      },
      async summaryHeaderFor() {
        return null;
      },
      async summaryFor(id: string) {
        throw new Error(`unexpected ${id}`);
      },
    });

    expect(entry.ids).toEqual(['s1']);
    expect(rebuilt).toBe(false);
  });
});
