import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const mockProjectSlug = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/core/utils', () => ({
  projectSlug: mockProjectSlug,
}));

import {
  projectsJsonPath,
  loadManifest,
  saveManifest,
  generateProjectSlug,
  ensureProjectDataDir,
} from '../src/server/projects-manifest.js';

describe('projects-manifest', () => {
  describe('projectsJsonPath', () => {
    it('returns the project.json path derived from globalConfigPath', () => {
      const result = projectsJsonPath('/home/user/.wrongstack/config.json');
      // The path separator depends on the platform; verify the filename and parent
      expect(result).toContain('projects.json');
      expect(path.basename(path.dirname(result))).toBe('.wrongstack');
    });

    it('handles Windows-style paths', () => {
      const result = projectsJsonPath('C:\\Users\\test\\.wrongstack\\config.json');
      // path.dirname extracts the directory, path.join appends 'projects.json'
      expect(result).toContain('projects.json');
    });
  });

  describe('loadManifest', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-manifest-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty projects array when file does not exist', async () => {
      const manifest = await loadManifest(path.join(tmpDir, 'config.json'));
      expect(manifest).toEqual({ projects: [] });
    });

    it('returns empty projects array when JSON is invalid', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      const projPath = projectsJsonPath(configPath);
      await fs.writeFile(projPath, 'not valid json', 'utf8');
      const manifest = await loadManifest(configPath);
      expect(manifest).toEqual({ projects: [] });
    });

    it('returns parsed manifest when file exists and is valid', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      const projPath = projectsJsonPath(configPath);
      await fs.writeFile(
        projPath,
        JSON.stringify({ projects: [{ name: 'test', root: '/test', slug: 'test' }] }),
        'utf8',
      );
      const manifest = await loadManifest(configPath);
      expect(manifest.projects).toHaveLength(1);
      expect(manifest.projects[0].name).toBe('test');
    });

    it('defaults to empty array when projects field is missing', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      const projPath = projectsJsonPath(configPath);
      await fs.writeFile(projPath, JSON.stringify({}), 'utf8');
      const manifest = await loadManifest(configPath);
      expect(manifest).toEqual({ projects: [] });
    });
  });

  describe('saveManifest', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-manifest-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('writes manifest to disk', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      const manifest = { projects: [{ name: 'test', root: '/test', slug: 'test' }] };
      await saveManifest(manifest, configPath);
      const saved = await fs.readFile(projectsJsonPath(configPath), 'utf8');
      expect(JSON.parse(saved)).toEqual(manifest);
    });

    it('creates parent directory if needed', async () => {
      const configPath = path.join(tmpDir, 'sub', 'config.json');
      const manifest = { projects: [] };
      await saveManifest(manifest, configPath);
      const exists = await fs
        .stat(projectsJsonPath(configPath))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe('generateProjectSlug', () => {
    it('delegates to projectSlug from core', () => {
      mockProjectSlug.mockReturnValue('my-project');
      const result = generateProjectSlug('/path/to/project');
      expect(mockProjectSlug).toHaveBeenCalledWith('/path/to/project');
      expect(result).toBe('my-project');
    });
  });

  describe('ensureProjectDataDir', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-manifest-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates the project data directory and returns the path', async () => {
      const configPath = path.join(tmpDir, 'config.json');
      const dir = await ensureProjectDataDir('test-slug', configPath);
      expect(dir).toBe(path.join(tmpDir, 'projects', 'test-slug'));
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });
  });
});

// B-07: migrated from packages/webui/tests/server/projects-manifest.test.ts —
// the saveManifest → loadManifest round-trip. The server suite covers each
// direction in isolation (`writes manifest to disk` proves saveManifest; the
// `returns parsed manifest` test proves loadManifest against a fixture file
// written directly to disk) but never asserts the two compose. A future
// schema change to either side — say, an extra `lastSeen` field saved by
// saveManifest and stripped by loadManifest — would pass both isolated tests
// and only fail the round-trip. This is the regression guard.
describe('projects-manifest — round-trip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-manifest-roundtrip-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saveManifest then loadManifest round-trips the projects', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    const manifest = {
      projects: [
        { name: 'proj', root: '/x/proj', slug: 'proj-abc', lastSeen: '2026-06-21T00:00:00Z' },
      ],
    };
    await saveManifest(manifest, configPath);
    expect(await loadManifest(configPath)).toEqual(manifest);
  });
});
