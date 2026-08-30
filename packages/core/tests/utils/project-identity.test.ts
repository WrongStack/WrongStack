import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureProjectGitignore,
  ensureProjectIdentity,
  isProjectId,
  projectIdentityPath,
  readProjectIdentity,
  rekeyProjectIdentity,
} from '../../src/utils/project-identity.js';

describe('committed project identity', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-project-identity-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates one stable ULID-backed identity and reuses it', async () => {
    const first = await ensureProjectIdentity(root, () => 'proj_01J00000000000000000000000');
    const second = await ensureProjectIdentity(root, () => 'proj_01J11111111111111111111111');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.identity).toEqual(first.identity);
    expect(isProjectId(first.identity.projectId)).toBe(true);
    expect(JSON.parse(await fs.readFile(projectIdentityPath(root), 'utf8'))).toEqual(
      first.identity,
    );
  });

  it('rekeys an independent fork without mutating the previous result', async () => {
    await ensureProjectIdentity(root, () => 'proj_01J00000000000000000000000');
    const result = await rekeyProjectIdentity(root, () => 'proj_01J11111111111111111111111');

    expect(result.previous?.projectId).toBe('proj_01J00000000000000000000000');
    expect(result.identity.projectId).toBe('proj_01J11111111111111111111111');
    expect((await readProjectIdentity(root))?.projectId).toBe(result.identity.projectId);
  });

  it('rejects malformed committed identity instead of silently splitting HQ state', async () => {
    await fs.mkdir(path.dirname(projectIdentityPath(root)), { recursive: true });
    await fs.writeFile(projectIdentityPath(root), '{"version":1,"projectId":"not-valid"}\n');

    await expect(readProjectIdentity(root)).rejects.toThrow('Invalid projectId');
  });

  it('migrates the broad ignore while keeping runtime state ignored', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.wrongstack/\n');
    await ensureProjectGitignore(root);
    await ensureProjectGitignore(root);

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(content).toContain('.wrongstack/\n');
    expect(content).toContain('!/.wrongstack/\n');
    expect(content).toContain('/.wrongstack/*\n');
    expect(content).toContain('!/.wrongstack/project.json\n');
    expect(content.match(/!\/\.wrongstack\/project\.json/g)).toHaveLength(1);
  });

  it('preserves CRLF line endings when present in .gitignore', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\r\n', 'utf8');
    await ensureProjectGitignore(root);

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(content).toContain('\r\n');
    expect(content).toContain('!/.wrongstack/project.json\r\n');
  });
});
