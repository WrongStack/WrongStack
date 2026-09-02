import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveProjectSageStorageRoot,
  sageProjectServerEndpoint,
  sageProjectServerKey,
} from '../src/project-server-endpoint.js';

describe('SAGE project server identity', () => {
  it('uses one endpoint for equivalent project paths', () => {
    const absolute = path.resolve('fixtures', 'project-server');
    const equivalent = path.join(absolute, '..', 'project-server', '.');

    expect(sageProjectServerKey(absolute)).toBe(sageProjectServerKey(equivalent));
    expect(sageProjectServerEndpoint(absolute)).toBe(sageProjectServerEndpoint(equivalent));
  });

  it('includes an explicit storage directory in server identity', () => {
    const projectRoot = path.resolve('fixtures', 'project-server');

    expect(sageProjectServerKey(projectRoot, '.memory-a')).not.toBe(
      sageProjectServerKey(projectRoot, '.memory-b'),
    );
    expect(resolveProjectSageStorageRoot(projectRoot, '.memory-a')).toContain(
      `${path.sep}.memory-a`,
    );
  });

  it('shares the main checkout endpoint with a linked worktree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-worktree-identity-'));
    try {
      const main = path.join(root, 'main');
      const linked = path.join(root, 'linked');
      const linkedGitDir = path.join(main, '.git', 'worktrees', 'linked');
      await fs.mkdir(linkedGitDir, { recursive: true });
      await fs.mkdir(linked, { recursive: true });
      await fs.writeFile(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
      await fs.writeFile(path.join(linkedGitDir, 'commondir'), '../..\n');

      expect(sageProjectServerEndpoint(linked)).toBe(sageProjectServerEndpoint(main));
      expect(resolveProjectSageStorageRoot(linked)).toBe(resolveProjectSageStorageRoot(main));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
