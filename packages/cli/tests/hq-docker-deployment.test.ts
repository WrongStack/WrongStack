import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isReusedContainerPid } from '../src/boot/short-circuit-hq.js';

const root = path.resolve(import.meta.dirname, '../../..');
const deploy = path.join(root, 'deploy', 'hq');

async function read(relative: string): Promise<string> {
  return await fs.readFile(path.join(deploy, relative), 'utf8');
}

describe('HQ Docker deployment contract', () => {
  it('ignores a stale marker when a replacement container reuses PID 1', () => {
    expect(isReusedContainerPid(1, '1', 1)).toBe(true);
    expect(isReusedContainerPid(2, '1', 1)).toBe(false);
    expect(isReusedContainerPid(1, undefined, 1)).toBe(false);
  });

  it('builds the current workspace closure and runs as an unprivileged immutable image', async () => {
    const dockerfile = await read('Dockerfile');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(dockerfile).toContain('pnpm rebuild esbuild');
    expect(dockerfile).toContain(
      'pnpm --filter wrongstack deploy --prod --no-optional --ignore-scripts /opt/wrongstack',
    );
    expect(dockerfile).not.toContain('npm install -g wrongstack');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('WRONGSTACK_HQ_CONTAINER=1');
    expect(dockerfile).toContain('WRONGSTACK_HQ_BOOTSTRAP_PASSWORD_ONLY=1');
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(dockerfile).toContain('http://127.0.0.1:3499/healthz');
    expect(dockerfile).toContain('"--host", "0.0.0.0"');
  });

  it('keeps secrets out of environment values and hardens the Compose runtime', async () => {
    const compose = await read('compose.yaml');
    expect(compose).toContain('WRONGSTACK_HQ_PASSWORD_FILE: /run/secrets/hq_password');
    expect(compose).toContain('WRONGSTACK_HQ_BOOTSTRAP_PASSWORD_ONLY: "1"');
    expect(compose).toContain('file: ./secrets/hq_password.txt');
    expect(compose).toContain('wrongstack_hq_data:/var/lib/wrongstack-hq');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('- ALL');
    expect(compose).not.toContain('WRONGSTACK_HQ_PASSWORD:');
  });

  it('provides health-gated image replacement and prior-image rollback', async () => {
    const updater = await read('update.sh');
    expect(updater).toContain('compose pull "$SERVICE"');
    expect(updater).toContain("old_image=$(docker inspect --format '{{.Image}}'");
    expect(updater).toContain('wait_healthy');
    expect(updater).toContain('docker image tag "$old_image" "$image_ref"');
    expect(updater).toContain('wrongstack-hq:local');
    const syntax = spawnSync('sh', ['-n'], { input: updater, encoding: 'utf8' });
    if (syntax.error && 'code' in syntax.error && syntax.error.code === 'ENOENT') return;
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it('ships a persistent host-side update timer and excludes deployment secrets', async () => {
    const timer = await read('systemd/wrongstack-hq-container-update.timer');
    const service = await read('systemd/wrongstack-hq-container-update.service');
    const dockerignore = await fs.readFile(path.join(root, '.dockerignore'), 'utf8');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('RandomizedDelaySec=1h');
    expect(service).toContain('ExecStart=/bin/sh /opt/wrongstack-hq/update.sh');
    expect(dockerignore).toContain('deploy/hq/secrets/*');
  });
});
