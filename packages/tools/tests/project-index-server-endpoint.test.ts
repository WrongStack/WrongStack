import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  projectIndexServerBuildId,
  projectIndexServerEndpoint,
  projectIndexServerKey,
  projectIndexServerMetadataPath,
} from '../src/codebase-index/project-server-endpoint.js';

describe('project index server endpoint', () => {
  it('is deterministic for one project index and distinct across projects', () => {
    const first = projectIndexServerEndpoint('/workspace/project-a');
    expect(projectIndexServerEndpoint('/workspace/project-a')).toBe(first);
    expect(projectIndexServerEndpoint('/workspace/project-b')).not.toBe(first);
  });

  it('uses an explicit index directory as the local server identity', () => {
    const root = '/workspace/project';
    expect(projectIndexServerKey(root, '/indexes/one')).not.toBe(
      projectIndexServerKey(root, '/indexes/two'),
    );
  });

  it('stores discovery metadata beside the project index database', () => {
    const metadata = projectIndexServerMetadataPath('/workspace/project', '/indexes/custom');
    expect(metadata).toBe(path.join(path.resolve('/indexes/custom'), 'server.json'));
  });

  it('changes the build identity when the server artifact changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-build-id-'));
    const artifact = path.join(dir, 'project-server.js');
    try {
      await fs.writeFile(artifact, 'first');
      const first = projectIndexServerBuildId(artifact);
      expect(projectIndexServerBuildId(pathToFileURL(artifact).href)).toBe(first);
      await fs.writeFile(artifact, 'second-build');

      expect(projectIndexServerBuildId(artifact)).not.toBe(first);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
