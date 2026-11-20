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

  it('migrates the broad ignore while keeping local state ignored', async () => {
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.wrongstack/\n');
    await ensureProjectGitignore(root);
    await ensureProjectGitignore(root);

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(content).toContain('.temp_files/\n');
    expect(content).toContain('acp-sessions/\n');
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
    expect(content).toContain('.temp_files/\r\n');
    expect(content).toContain('acp-sessions/\r\n');
    expect(content).toContain('!/.wrongstack/project.json\r\n');
  });

  it('gives a Mercurial repository the same rules in its .hgignore, once', async () => {
    // A project in a subdirectory of the repository: the rules go to the root.
    await fs.mkdir(path.join(root, '.hg'));
    const project = path.join(root, 'app');
    await fs.mkdir(project);
    await fs.writeFile(path.join(root, '.hgignore'), 'syntax: glob\n*.log', 'utf8');
    await ensureProjectGitignore(project);
    await ensureProjectGitignore(project);

    const content = await fs.readFile(path.join(root, '.hgignore'), 'utf8');
    // Per-line `re:` keeps the user's glob section intact.
    expect(content).toBe(
      'syntax: glob\n*.log\n\n# WrongStack local state\n' +
        're:(^|/)\\.temp_files/\nre:(^|/)acp-sessions/\nre:(^|/)\\.wrongstack/(?!project\\.json$)\n',
    );
    const [temp, acpSessions, state] = content
      .split('\n')
      .slice(-4, -1)
      .map((line) => new RegExp(line.slice(3)));
    expect(temp?.test('app/.temp_files/x')).toBe(true);
    expect(acpSessions?.test('app/acp-sessions/sess_1.json')).toBe(true);
    expect(state?.test('app/.wrongstack/sage.db')).toBe(true);
    expect(state?.test('app/.wrongstack/project.json')).toBe(false);
  });

  it('leaves .hgignore alone outside a Mercurial repository', async () => {
    await ensureProjectGitignore(root);
    await expect(fs.access(path.join(root, '.hgignore'))).rejects.toThrow();
  });
});
