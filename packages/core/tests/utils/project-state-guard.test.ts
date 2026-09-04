import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startProjectStateGuard } from '../../src/utils/project-state-guard.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-state-guard-'));
  cleanup.push(root);
  return root;
}

async function waitForDirectory(directory: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fs.stat(directory).catch(() => undefined))?.isDirectory()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Directory was not restored: ${directory}`);
}

describe('project state guard', () => {
  it('establishes the .wrongstack directory when activated', async () => {
    const root = await temporaryProject();
    const guard = await startProjectStateGuard(root, { pollIntervalMs: 25 });

    await expect(fs.stat(path.join(root, '.wrongstack'))).resolves.toMatchObject({});
    guard.close();
  });

  it('restores .wrongstack after it is deleted while the project is active', async () => {
    const root = await temporaryProject();
    const directory = path.join(root, '.wrongstack');
    const guard = await startProjectStateGuard(root, { pollIntervalMs: 25 });

    await fs.writeFile(path.join(directory, 'state.json'), '{}');
    await fs.rm(directory, { recursive: true, force: true });
    await waitForDirectory(directory);

    expect((await fs.stat(directory)).isDirectory()).toBe(true);
    guard.close();
  });

  it('restores protected .gitignore rules without removing project rules', async () => {
    const root = await temporaryProject();
    const gitignore = path.join(root, '.gitignore');
    const guard = await startProjectStateGuard(root, { pollIntervalMs: 25 });

    await fs.writeFile(gitignore, 'node_modules/\n');
    await waitForContent(gitignore, '.wrongstack/');

    const content = await fs.readFile(gitignore, 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.temp_files/');
    expect(content).toContain('.wrongstack/');
    expect(content).toContain('!/.wrongstack/project.json');
    guard.close();
  });

  it('stops recreating the directory after close', async () => {
    const root = await temporaryProject();
    const directory = path.join(root, '.wrongstack');
    const guard = await startProjectStateGuard(root, { pollIntervalMs: 25 });
    guard.close();

    await fs.rm(directory, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 75));

    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not resurrect a project root that is itself removed', async () => {
    const root = await temporaryProject();
    const guard = await startProjectStateGuard(root, { pollIntervalMs: 25 });

    await fs.rm(root, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    guard.close();
  });
});

async function waitForContent(file: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fs.readFile(file, 'utf8').catch(() => '')).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Content was not restored in ${file}: ${expected}`);
}
