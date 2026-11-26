import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from '../src/project-server-endpoint.js';

/**
 * A JSON `null` line is not a client message. The invalid-JSON path destroys
 * that socket and keeps the daemon up. `null` used to throw on
 * `message.authToken` and take the process down before any auth check.
 */
describe('chronicle project server null frame', () => {
  const children = new Set<ReturnType<typeof spawn>>();

  afterEach(() => {
    for (const child of children) child.kill();
    children.clear();
  });

  it('rejects a null JSON frame without exiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chronicle-null-frame-'));
    const endpoint = chronicleProjectServerEndpoint(root);
    const metadataPath = chronicleProjectServerMetadataPath(root);
    const server = fileURLToPath(new URL('../src/project-server.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        server,
        '--project-root',
        root,
        '--global-root',
        `${root}-global`,
        '--project-id',
        'null-frame',
        '--project-dir',
        root,
        '--workspace-id',
        'null-frame-ws',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WRONGSTACK_CHRONICLE_SERVER_IDLE_MS: '60000',
          WRONGSTACK_CHRONICLE_SERVER_SILENT_CLIENT_MS: '60000',
        },
      },
    );
    children.add(child);
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });

    const started = Date.now();
    while (true) {
      try {
        readFileSync(metadataPath, 'utf8');
        break;
      } catch (error) {
        if (child.exitCode !== null || Date.now() - started > 20_000) {
          throw new Error(`daemon did not start: ${output || (error as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }

    const socket = await new Promise<Socket>((resolve, reject) => {
      const client = connect(endpoint);
      client.once('connect', () => resolve(client));
      client.once('error', reject);
    });
    const read = () =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response')), 5_000);
        socket.once('data', (chunk) => {
          clearTimeout(timer);
          resolve(String(chunk));
        });
      });
    await read();
    socket.write(
      `${JSON.stringify({ id: 1, type: 'request', authToken: 'not-the-token', op: 'ping', args: {} })}\n`,
    );
    await expect(read()).resolves.toContain('UnauthorizedChronicleRequest');

    socket.write('null\n');
    const exit = await Promise.race([
      new Promise<number | null>((resolve) => child.once('exit', resolve)),
      new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);
    socket.destroy();
    expect(exit, output).toBeNull();
  }, 30_000);
});
