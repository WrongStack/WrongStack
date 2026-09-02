import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHqPublisherFromEnv,
  deriveHqProjectId,
  HQ_AUTH_FILE_VERSION,
  resolveHqConfig,
  resolveHqConfigFromEnv,
  writeHqAuthFile,
  writeHqRuntimeFile,
} from '../../src/hq/index.js';
import { ensureProjectIdentity } from '../../src/utils/project-identity.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-factory-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('HQ publisher factory env config', () => {
  it('gives separate publishers in the same process distinct client ids', () => {
    const common = {
      clientKind: 'cli' as const,
      projectRoot: process.cwd(),
      config: { url: 'http://127.0.0.1:3499', enabled: true },
    };

    const first = createHqPublisherFromEnv(common);
    const second = createHqPublisherFromEnv(common);

    expect(first?.identity.clientId).toBeTruthy();
    expect(second?.identity.clientId).toBeTruthy();
    expect(first?.identity.clientId).not.toBe(second?.identity.clientId);
    expect(first?.identity.clientId).toContain(`:cli:${process.pid}:`);
    first?.close();
    second?.close();
  });

  it('uses WRONGSTACK_HQ_TOKEN when explicitly provided', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'auth-file-token', createdAt: new Date().toISOString() },
        ],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://127.0.0.1:3499',
        WRONGSTACK_HQ_TOKEN: 'explicit-token',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toMatchObject({ url: 'http://127.0.0.1:3499', token: 'explicit-token' });
    });
  });

  it('auto-loads the first client token from auth.json when HQ is enabled', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() },
        ],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_ENABLED: '1',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toMatchObject({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        discover: true,
        dataDir: dir,
        token: 'client-token-from-auth',
      });
    });
  });

  it('auto-loads the first client token from auth.json when only URL is provided', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        browserTokens: [
          { id: 'bt-1', token: 'browser-token-ignored', createdAt: new Date().toISOString() },
        ],
        clientTokens: [
          { id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() },
        ],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://127.0.0.1:3499',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toMatchObject({
        url: 'http://127.0.0.1:3499',
        token: 'client-token-from-auth',
      });
    });
  });

  it('does NOT fall back to the local auth.json token for a remote URL', async () => {
    // A remote HQ has its own auth.json — sending the LOCAL client token
    // would put the publisher into a silent 401 reconnect loop. Without an
    // explicit token the config must carry none, so the operator sees an
    // honest auth failure instead of a wrong-token mystery.
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'local-only-token', createdAt: new Date().toISOString() },
        ],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://192.168.1.50:3499',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config?.url).toBe('http://192.168.1.50:3499');
      expect(config?.token).toBeUndefined();
    });
  });

  it('uses the explicit WRONGSTACK_HQ_TOKEN for a remote URL', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'local-only-token', createdAt: new Date().toISOString() },
        ],
      });

      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://hq.example.com:3499',
        WRONGSTACK_HQ_TOKEN: 'remote-token',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });

      expect(config).toMatchObject({ url: 'http://hq.example.com:3499', token: 'remote-token' });
    });
  });

  it('auto-enables same-machine HQ when auth.json has a client token', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() },
        ],
      });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toMatchObject({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        discover: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('auto-enables open-mode same-machine HQ when only a runtime URL exists', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        browserTokens: [],
        clientTokens: [],
      });
      await writeHqRuntimeFile(dir, { url: 'http://127.0.0.1:45123', pid: process.pid });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toMatchObject({
        url: 'http://127.0.0.1:45123',
        enabled: true,
        discover: true,
      });
    });
  });

  it('prefers the runtime HQ URL when the server bound a non-default port', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() },
        ],
      });
      await writeHqRuntimeFile(dir, { url: 'http://127.0.0.1:45123', pid: process.pid });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toMatchObject({
        url: 'http://127.0.0.1:45123',
        enabled: true,
        discover: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('ignores a runtime HQ URL whose recorded process is no longer alive', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() },
        ],
      });
      await writeHqRuntimeFile(dir, { url: 'http://127.0.0.1:45123', pid: 999_999_999 });

      expect(resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir })).toMatchObject({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        discover: true,
        token: 'client-token-from-auth',
      });
    });
  });

  it('enters discovery mode even when nothing is configured yet (HQ may start later)', async () => {
    await withTempDir(async (dir) => {
      // No auth.json, no runtime.json — a client booted before `wstack --hq`
      // ever ran. It must still get a (dormant) discovery config so it can
      // attach the moment an HQ starts on this machine.
      const config = resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir });
      expect(config).toMatchObject({
        url: 'http://127.0.0.1:3499',
        enabled: true,
        discover: true,
        dataDir: dir,
      });
      expect(config?.token).toBeUndefined();
    });
  });

  it('defaults rawContent to true for same-machine discovery mode', async () => {
    // Same-machine HQ: data never leaves the machine — full chat history by
    // default. (Placeholder-only history made the HQ Console useless.)
    await withTempDir(async (dir) => {
      const config = resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir });
      expect(config).toMatchObject({ discover: true, rawContent: true });
    });
  });

  it('defaults rawContent to true for an explicit loopback URL', async () => {
    await withTempDir(async (dir) => {
      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://127.0.0.1:3499',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });
      expect(config?.rawContent).toBe(true);
    });
  });

  it('defaults rawContent to true for a remote URL', async () => {
    await withTempDir(async (dir) => {
      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_URL: 'http://hq.example.com:3499',
        WRONGSTACK_HQ_DATA_DIR: dir,
      });
      expect(config?.rawContent).toBe(true);
    });
  });

  it('honors WRONGSTACK_HQ_RAW_CONTENT in same-machine discovery mode', async () => {
    // Regression: the discovery branch used to return early WITHOUT reading
    // the rawContent opt-in, so a local `wstack --hq` chat history was
    // permanently [REDACTED:hq_raw_content] with no way to enable it.
    await withTempDir(async (dir) => {
      const config = resolveHqConfigFromEnv({
        WRONGSTACK_HQ_DATA_DIR: dir,
        WRONGSTACK_HQ_RAW_CONTENT: '1',
      });
      expect(config).toMatchObject({ discover: true, rawContent: true });
    });
  });

  it('uses projectAlias as a stable project identity across independent roots', () => {
    expect(deriveHqProjectId('/copy/a', 'shared-project')).toBe(
      deriveHqProjectId('/copy/b', 'shared-project'),
    );
    expect(deriveHqProjectId('/copy/a')).not.toBe(deriveHqProjectId('/copy/b'));
    expect(() => deriveHqProjectId('alias:shared-project')).toThrow(
      'projectRoot must not use the reserved "alias:" HQ identity prefix',
    );

    const publisher = createHqPublisherFromEnv({
      clientKind: 'cli',
      projectRoot: '/copy/a',
      projectName: 'copy-a',
      config: {
        enabled: true,
        url: 'http://127.0.0.1:3499',
        projectAlias: 'shared-project',
      },
    });
    expect(publisher?.project.projectName).toBe('shared-project');
    publisher?.close();
  });

  it('prefers the committed project id across clones and keeps alias as display metadata', async () => {
    await withTempDir(async (dir) => {
      const first = path.join(dir, 'first');
      const second = path.join(dir, 'second');
      await fs.mkdir(first, { recursive: true });
      await fs.mkdir(second, { recursive: true });
      const created = await ensureProjectIdentity(first, () => 'proj_01J00000000000000000000000');
      await fs.mkdir(path.join(second, '.wrongstack'), { recursive: true });
      await fs.copyFile(
        path.join(first, '.wrongstack', 'project.json'),
        path.join(second, '.wrongstack', 'project.json'),
      );

      expect(deriveHqProjectId(first, 'display-a')).toBe(created.identity.projectId);
      expect(deriveHqProjectId(second, 'display-b')).toBe(created.identity.projectId);

      const publisher = createHqPublisherFromEnv({
        clientKind: 'cli',
        projectRoot: second,
        config: {
          enabled: true,
          url: 'http://127.0.0.1:3499',
          projectAlias: 'Readable project name',
        },
      });
      expect(publisher?.project.projectId).toBe(created.identity.projectId);
      expect(publisher?.project.projectName).toBe('Readable project name');
      publisher?.close();
    });
  });

  it('honors config hq.rawContent + hq.projectAlias in discovery mode', async () => {
    await withTempDir(async (dir) => {
      const config = resolveHqConfig({
        env: { WRONGSTACK_HQ_DATA_DIR: dir },
        config: { rawContent: true, projectAlias: 'my-project' },
      });
      expect(config).toMatchObject({
        discover: true,
        rawContent: true,
        projectAlias: 'my-project',
      });
    });
  });

  it('lets WRONGSTACK_HQ_RAW_CONTENT=0 override config hq.rawContent=true', async () => {
    await withTempDir(async (dir) => {
      const config = resolveHqConfig({
        env: { WRONGSTACK_HQ_DATA_DIR: dir, WRONGSTACK_HQ_RAW_CONTENT: '0' },
        config: { rawContent: true },
      });
      expect(config?.rawContent).toBe(false);
    });
  });

  it('does not auto-enable local HQ when explicitly disabled', async () => {
    await withTempDir(async (dir) => {
      await writeHqAuthFile(dir, {
        version: HQ_AUTH_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        clientTokens: [
          { id: 'ct-1', token: 'client-token-from-auth', createdAt: new Date().toISOString() },
        ],
      });

      expect(
        resolveHqConfigFromEnv({ WRONGSTACK_HQ_DATA_DIR: dir, WRONGSTACK_HQ_ENABLED: '0' }),
      ).toBeUndefined();
    });
  });
});
