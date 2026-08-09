import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { LegacySessionRegistry as SessionRegistry } from '@wrongstack/core/storage';
import type { Logger } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStandaloneSessionIdentityLifecycle } from '../src/server/standalone-session-identity.js';

const logger: Logger = {
  level: 'error',
  debug() {},
  info() {},
  warn() {},
  error() {},
  trace() {},
  child() {
    return logger;
  },
};

describe('standalone session identity lifecycle', () => {
  let root: string;
  let globalRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-webui-identity-'));
    globalRoot = path.join(root, 'global');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('re-points registry ownership on session swap, then cleans it', async () => {
    const lifecycle = await createStandaloneSessionIdentityLifecycle({
      config: {} as never,
      events: new EventBus(),
      logger,
      paths: {
        globalRoot,
        projectRoot: root,
        projectSlug: 'project-under-test',
      },
      workingDir: root,
      initialSessionId: '2026-07-12/sess_initial',
      sessionRegistry: new SessionRegistry(globalRoot),
      enableHqTelemetry: false,
    });

    await expect(registrySessionIds(globalRoot)).resolves.toEqual(['2026-07-12/sess_initial']);

    await lifecycle.activate('2026-07-12/sess_resumed', {
      projectSlug: 'second-project',
      projectRoot: path.join(root, 'second-project'),
      projectName: 'Second Project',
      workingDir: path.join(root, 'second-project', 'src'),
    });

    await expect(registrySessionIds(globalRoot)).resolves.toEqual(['2026-07-12/sess_resumed']);
    const registry = JSON.parse(
      await fs.readFile(path.join(globalRoot, 'session-registry.json'), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    expect(registry['2026-07-12/sess_resumed']).toMatchObject({
      projectSlug: 'second-project',
      projectName: 'Second Project',
      workingDir: path.join(root, 'second-project', 'src'),
    });

    await lifecycle.stop();
    await expect(registrySessionIds(globalRoot)).resolves.toEqual([]);
  });

  it('serializes rapid swaps and leaves only the last identity live', async () => {
    const lifecycle = await createStandaloneSessionIdentityLifecycle({
      config: {} as never,
      events: new EventBus(),
      logger,
      paths: {
        globalRoot,
        projectRoot: root,
        projectSlug: 'project-under-test',
      },
      workingDir: root,
      initialSessionId: '2026-07-12/sess_initial',
      sessionRegistry: new SessionRegistry(globalRoot),
      enableHqTelemetry: false,
    });

    await Promise.all([
      lifecycle.activate('2026-07-12/sess_second'),
      lifecycle.activate('2026-07-12/sess_final'),
    ]);

    await expect(registrySessionIds(globalRoot)).resolves.toEqual(['2026-07-12/sess_final']);
    await lifecycle.stop();
  });

  it('commits and rolls back explicit session claims without exposing two owners', async () => {
    const lifecycle = await createStandaloneSessionIdentityLifecycle({
      config: {} as never,
      events: new EventBus(),
      logger,
      paths: {
        globalRoot,
        projectRoot: root,
        projectSlug: 'project-under-test',
      },
      workingDir: root,
      initialSessionId: '2026-07-12/sess_initial',
      sessionRegistry: new SessionRegistry(globalRoot),
      enableHqTelemetry: false,
    });

    const rollback = await lifecycle.claim('2026-07-12/sess_candidate');
    await expect(registrySessionIds(globalRoot)).resolves.toEqual(['2026-07-12/sess_candidate']);
    await rollback();
    await expect(registrySessionIds(globalRoot)).resolves.toEqual(['2026-07-12/sess_initial']);

    await lifecycle.claim('2026-07-12/sess_committed');
    await lifecycle.activate('2026-07-12/sess_committed');
    await expect(registrySessionIds(globalRoot)).resolves.toEqual(['2026-07-12/sess_committed']);
    await lifecycle.stop();
  });

  it('rejects overlapping ownership claims', async () => {
    const lifecycle = await createStandaloneSessionIdentityLifecycle({
      config: {} as never,
      events: new EventBus(),
      logger,
      paths: {
        globalRoot,
        projectRoot: root,
        projectSlug: 'project-under-test',
      },
      workingDir: root,
      initialSessionId: '2026-07-12/sess_initial',
      sessionRegistry: new SessionRegistry(globalRoot),
      enableHqTelemetry: false,
    });

    const rollback = await lifecycle.claim('2026-07-12/sess_candidate');
    await expect(lifecycle.claim('2026-07-12/sess_other')).rejects.toThrow(
      /transition .* already in progress/i,
    );
    await rollback();
    await lifecycle.stop();
  });

  it('fails startup when initial ownership cannot be persisted', async () => {
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.writeFile(path.join(globalRoot, 'session-registry.json.lock'), String(process.pid));

    await expect(
      createStandaloneSessionIdentityLifecycle({
        config: {} as never,
        events: new EventBus(),
        logger,
        paths: {
          globalRoot,
          projectRoot: root,
          projectSlug: 'project-under-test',
        },
        workingDir: root,
        initialSessionId: '2026-07-12/sess_initial',
        sessionRegistry: new SessionRegistry(globalRoot),
        enableHqTelemetry: false,
      }),
    ).rejects.toThrow(/ownership update failed/i);
  });
});

async function registrySessionIds(globalRoot: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(globalRoot, 'session-registry.json'), 'utf8');
  return Object.keys(JSON.parse(raw) as Record<string, unknown>).sort();
}
