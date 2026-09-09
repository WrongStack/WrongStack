import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInsideProject, safePath } from '../src/runtime/sandbox.js';

/**
 * `safePath` is the containment boundary third-party plugins are told to use.
 * It shipped as part of the published SDK surface with no test of its own:
 * every case below is a way a plugin could have reached outside the project
 * while believing it had asked permission.
 */
describe('safePath', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    // realpath: on macOS the temp dir is itself a symlink, and comparing an
    // uncanonicalized root against a canonicalized target rejects everything.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-sandbox-')));
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-outside-')));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export {};');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('resolves a relative path against the project root', () => {
    expect(safePath('src/app.ts', { projectRoot: root })).toBe(path.join(root, 'src', 'app.ts'));
  });

  it('accepts a path that does not exist yet', () => {
    // A plugin writing a new file must not be rejected merely because the
    // target has no inode yet.
    expect(safePath('src/generated/new.ts', { projectRoot: root })).toBe(
      path.join(root, 'src', 'generated', 'new.ts'),
    );
  });

  it('rejects traversal out of the project', () => {
    expect(safePath('../secret.txt', { projectRoot: root })).toBeNull();
    expect(safePath('src/../../secret.txt', { projectRoot: root })).toBeNull();
    expect(safePath(outside, { projectRoot: root })).toBeNull();
  });

  it('rejects a symlink that lives inside but points outside', async () => {
    // The whole reason canonicalization exists: the lexical check passes and
    // the read still lands on another user's file.
    const link = path.join(root, 'escape.txt');
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), link);
    } catch {
      return; // Windows without developer mode: nothing to assert.
    }
    expect(safePath('escape.txt', { projectRoot: root })).toBeNull();
  });

  it('can be asked to keep the literal path instead of following the link', async () => {
    const link = path.join(root, 'escape.txt');
    try {
      await fs.symlink(path.join(outside, 'secret.txt'), link);
    } catch {
      return;
    }
    // Documented opt-out for callers that must record what the user wrote
    // (checkpoint capture, git diff) rather than where it lands.
    expect(safePath('escape.txt', { projectRoot: root, followSymlinks: false })).toBe(link);
  });

  it('rejects an argument that a shell would read as a flag', () => {
    // A plugin that passes user input straight to a spawned binary turns
    // `--output=/etc/passwd` into an option, not a path.
    expect(safePath('-rf', { projectRoot: root })).toBeNull();
    expect(safePath('--output=/etc/passwd', { projectRoot: root })).toBeNull();
  });

  it('rejects empty, oversized, and non-string input', () => {
    expect(safePath('', { projectRoot: root })).toBeNull();
    expect(safePath('a'.repeat(4097), { projectRoot: root })).toBeNull();
    expect(safePath(undefined as unknown as string, { projectRoot: root })).toBeNull();
    expect(safePath(42 as unknown as string, { projectRoot: root })).toBeNull();
  });

  it('treats the project root itself as inside', () => {
    expect(isInsideProject('.', { projectRoot: root })).toBe(true);
    expect(isInsideProject(root, { projectRoot: root })).toBe(true);
  });

  it('does not accept a sibling directory that merely shares a name prefix', async () => {
    // `/tmp/proj-evil` starts with `/tmp/proj`, so a plain string-prefix check
    // would let it through.
    const sibling = `${root}-evil`;
    await fs.mkdir(sibling, { recursive: true });
    try {
      expect(isInsideProject(path.join(sibling, 'f.txt'), { projectRoot: root })).toBe(false);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });
});
