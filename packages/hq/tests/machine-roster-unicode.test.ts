import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { HqMachineRoster } from '../src/persistence/machine-roster.js';

it('keeps clipped stored machine fields well-formed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-unicode-'));
  try {
    await fs.writeFile(
      path.join(dir, 'machines.json'),
      JSON.stringify({
        machines: [
          {
            key: 'host:key',
            hostname: `${'a'.repeat(254)}😀tail`,
            machineIds: [],
            projects: [],
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const roster = new HqMachineRoster({ dataDir: dir, retentionMs: 10 ** 12 });
    const now = Date.parse('2026-01-02T00:00:00.000Z');
    await roster.load(now);
    const hostname = roster.offline(now)[0]?.hostname ?? '';
    expect(
      [...hostname].some(
        (character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character),
      ),
    ).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
