import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureProjectDataDir,
  loadManifest,
  projectsJsonPath,
  saveManifest,
} from '../../src/server/projects-manifest.js';

describe('projects-manifest', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-manifest-'));
    configPath = path.join(tmp, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('projectsJsonPath sits next to the config file', () => {
    expect(projectsJsonPath(configPath)).toBe(path.join(tmp, 'projects.json'));
  });

  it('loadManifest returns an empty manifest when the file is absent', async () => {
    expect(await loadManifest(configPath)).toEqual({ projects: [] });
  });

  it('saveManifest then loadManifest round-trips the projects', async () => {
    const manifest = {
      projects: [{ name: 'proj', root: '/x/proj', slug: 'proj-abc', lastSeen: '2026-06-21T00:00:00Z' }],
    };
    await saveManifest(manifest, configPath);
    expect(await loadManifest(configPath)).toEqual(manifest);
  });

  it('loadManifest tolerates a corrupt file', async () => {
    await fs.writeFile(projectsJsonPath(configPath), '{ not json', 'utf8');
    expect(await loadManifest(configPath)).toEqual({ projects: [] });
  });

  it('ensureProjectDataDir creates projects/<slug> and returns it', async () => {
    const dir = await ensureProjectDataDir('my-slug', configPath);
    expect(dir).toBe(path.join(tmp, 'projects', 'my-slug'));
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});
