import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { launchGovernanceProjectDaemonWithRuntime } from '../src/daemon-launcher.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('governance daemon launcher timeout clamping (F1244)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of timing out in 1ms', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'f1244-gov-'));
    roots.push(root);
    // A daemon that answers the bootstrap channel at once with a message the
    // launcher refuses: the refusal must win over the startup timer.
    const stub = path.join(root, 'stub-daemon.mjs');
    await fs.writeFile(
      stub,
      "process.send?.({ type: 'not-a-handshake' });\n" +
        'setTimeout(() => process.exit(0), 5000).unref();\n' +
        "process.on('disconnect', () => process.exit(0));\n",
      'utf8',
    );
    const launch = launchGovernanceProjectDaemonWithRuntime(
      {
        projectRoot: root,
        projectId: 'f1244',
        clientId: 'f1244-admin',
        capabilities: ['capability_admin'],
        ttlMs: 60_000,
        timeoutMs: 3_000_000_000,
      },
      { entrypoint: pathToFileURL(stub), cwd: os.tmpdir(), detached: false },
    );
    await expect(launch).rejects.toMatchObject({ code: 'invalid_handshake' });
  });
});
