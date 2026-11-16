import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDiscovery } from '../src/discovery.js';

describe('loadDiscovery', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('strips UTF-8 BOM from endpoint.json and rejects non-object JSON (F477)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongmem-discovery-'));
    dirs.push(tmp);
    await fs.mkdir(path.join(tmp, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'runtime', 'token'), 'secret-tok\n', 'utf8');
    await fs.writeFile(
      path.join(tmp, 'runtime', 'endpoint.json'),
      `\uFEFF${JSON.stringify({ pid: process.pid, port: 4444, host: '127.0.0.1' })}`,
      'utf8',
    );
    expect(loadDiscovery(tmp).token).toBe('secret-tok');

    await fs.writeFile(path.join(tmp, 'runtime', 'endpoint.json'), 'null', 'utf8');
    expect(() => loadDiscovery(tmp)).toThrow(/not a JSON object/);
  });
});
