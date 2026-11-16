import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetNotifier } from '../src/fleet-notifier.js';

describe('FleetNotifier', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('strips UTF-8 BOM and ignores non-object JSON in webui-instances.json (F471)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-notifier-bom-'));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      stdio: 'ignore',
    });
    cleanups.push(async () => {
      child.kill();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    await fs.writeFile(
      path.join(tmp, 'webui-instances.json'),
      `\uFEFF${JSON.stringify({
        instances: [
          {
            pid: child.pid,
            httpPort: 4567,
            host: '127.0.0.1',
            projectRoot: tmp,
            authToken: 'tok-1',
          },
        ],
      })}`,
      'utf8',
    );
    const notifier = new FleetNotifier({
      baseDir: tmp,
      projectRoot: tmp,
    });
    expect(await notifier.endpoints()).toHaveLength(1);

    await fs.writeFile(path.join(tmp, 'webui-instances.json'), 'null', 'utf8');
    const notifierNull = new FleetNotifier({
      baseDir: tmp,
      projectRoot: tmp,
    });
    expect(await notifierNull.endpoints()).toEqual([]);
  });
});
