/**
 * Focused coverage for pre-launch/project-check.ts — project kind detection
 * and the AGENTS.md scaffold / git-init prompt flow.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import { detectProjectKind, runProjectCheck } from '../src/pre-launch/project-check.js';
import type { TerminalRenderer } from '../src/renderer.js';

let dir: string;

function fakeIo(answers: string[]) {
  let i = 0;
  const reader = {
    readLine: vi.fn(async () => answers[i++] ?? ''),
  } as unknown as ReadlineInputReader;
  const renderer = {
    write: vi.fn(),
    writeError: vi.fn(),
  } as unknown as TerminalRenderer;
  return { reader, renderer };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-project-check-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('detectProjectKind', () => {
  it('returns initialized when .wrongstack/AGENTS.md exists', async () => {
    await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(dir, '.wrongstack', 'AGENTS.md'), '# agent', 'utf8');
    await expect(detectProjectKind(dir)).resolves.toBe('initialized');
  });

  it('returns project for any recognized manifest', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf8');
    await expect(detectProjectKind(dir)).resolves.toBe('project');
  });

  it('returns empty for a bare directory', async () => {
    await expect(detectProjectKind(dir)).resolves.toBe('empty');
  });
});

describe('runProjectCheck', () => {
  it('short-circuits for an initialized project', async () => {
    await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(dir, '.wrongstack', 'AGENTS.md'), '# agent', 'utf8');
    const { reader, renderer } = fakeIo([]);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(true);
    expect(renderer.write).toHaveBeenCalledWith(expect.stringContaining('Project initialized'));
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it('scaffolds AGENTS.md when the user answers y', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf8');
    const { reader, renderer } = fakeIo(['y']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(true);
    const md = await fs.readFile(path.join(dir, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(md).toContain('Auto-detected');
    expect(renderer.write).toHaveBeenCalledWith(expect.stringContaining('Wrote'));
  });

  it('cancels when the user answers q', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf8');
    const { reader, renderer } = fakeIo(['q']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(false);
    expect(renderer.write).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
  });

  it('proceeds without scaffolding when the user answers n', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf8');
    const { reader, renderer } = fakeIo(['n']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(true);
    await expect(fs.stat(path.join(dir, '.wrongstack'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a scaffold failure to the renderer', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), '{}', 'utf8');
    // Make .wrongstack uncreatable by placing a file there.
    await fs.writeFile(path.join(dir, '.wrongstack'), 'in the way', 'utf8');
    const { reader, renderer } = fakeIo(['y']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(true);
    expect(renderer.writeError).toHaveBeenCalled();
  });

  it('initializes git in a scratch dir when the user answers y to both prompts', async () => {
    const { reader, renderer } = fakeIo(['y', 'y']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(true);
    expect(renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('Git repository initialized'),
    );
  });

  it('cancels in a scratch dir when the user answers q to git init', async () => {
    const { reader, renderer } = fakeIo(['q']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(false);
  });

  it('continues in a scratch dir with an existing git repo', async () => {
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    const { reader, renderer } = fakeIo(['y']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(true);
    expect(renderer.write).not.toHaveBeenCalledWith(expect.stringContaining('Initialize git'));
  });

  it('cancels on the continue-anyway prompt', async () => {
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    const { reader, renderer } = fakeIo(['n']);
    const result = await runProjectCheck({ projectRoot: dir, cwd: dir, renderer, reader });
    expect(result).toBe(false);
  });
});
