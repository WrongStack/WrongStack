/**
 * Focused coverage for services/project-facts.ts — manifest + Makefile + CI +
 * source-scan project detection and the AGENTS.md template renderer.
 *
 * Uses real temp directories; the @wrongstack/tools/languages integration is
 * exercised as-is (it detects the fixture's TypeScript files from source).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectProjectFacts,
  type ProjectFacts,
  renderAgentsTemplate,
} from '../src/services/project-facts.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-project-facts-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('detectProjectFacts', () => {
  it('detects package.json scripts and lockfile package manager', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', dev: 'vite' },
      }),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '', 'utf8');
    const facts = await detectProjectFacts(dir);
    expect(facts.build).toBe('pnpm run build');
    expect(facts.test).toBe('pnpm test');
    expect(facts.lint).toBe('pnpm run lint');
    expect(facts.run).toBe('pnpm run dev');
    expect(facts.hints).toContain('package.json scripts');
  });

  it('honors the declared packageManager for usable scripts', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        packageManager: 'yarn@4.0.0',
        scripts: { build: 'yarn build:app' },
      }),
      'utf8',
    );
    const facts = await detectProjectFacts(dir);
    expect(facts.build).toBe('yarn run build');
    expect(facts.hints).toContain('package.json scripts');
  });

  it('fills gaps from a Makefile with build/test/run targets', async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .' } }),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'Makefile'),
      ['build:', '\tgo build ./...', 'test:', '\tgo test ./...', 'run:', '\tgo run .'].join('\n'),
      'utf8',
    );
    const facts = await detectProjectFacts(dir);
    expect(facts.build).toBe('make build');
    expect(facts.test).toBe('make test');
    expect(facts.lint).toBe('npm run lint'); // package.json takes priority
    expect(facts.run).toBe('make run');
    expect(facts.hints).toContain('Makefile');
  });

  it('fills gaps from GitHub Actions workflow run steps', async () => {
    // No package.json at all — CI is the only command source, so nothing
    // pre-fills build/test/lint before applyCiCommands runs.
    await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: npm ci',
        '      - run: |',
        '          npm test',
        '          npm run lint',
        '      - run: npm run build',
      ].join('\n'),
      'utf8',
    );
    const facts = await detectProjectFacts(dir);
    expect(facts.test).toBe('npm test');
    expect(facts.lint).toBe('npm run lint');
    expect(facts.build).toBe('npm run build');
    expect(facts.hints).toContain('.github/workflows');
  });

  it('falls back to a source scan when no manifest produces commands', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'main.ts'), 'export {}', 'utf8');
    const facts = await detectProjectFacts(dir);
    expect(facts.languages?.length ?? 0).toBeGreaterThan(0);
    expect(facts.entryPoints?.length ?? 0).toBeGreaterThan(0);
    expect(facts.hints.some((h) => h.startsWith('source scan:'))).toBe(true);
  });

  it('runs the source scan but leaves facts empty for unrecognized files', async () => {
    // Files whose extensions are not in the language registry: the scan walks
    // them but the counts stay empty (line 223) and no scan hint is added.
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets', 'logo.svg'), '<svg/>', 'utf8');
    await fs.writeFile(path.join(dir, 'README.md'), '# hi', 'utf8');
    const facts = await detectProjectFacts(dir);
    expect(facts.languages).toBeUndefined();
    expect(facts.entryPoints).toBeUndefined();
    expect(facts.hints.some((h) => h.startsWith('source scan:'))).toBe(false);
  });

  it('returns minimal facts for an empty directory', async () => {
    const facts = await detectProjectFacts(dir);
    expect(facts.hints).toEqual([]);
    expect(facts.build).toBeUndefined();
  });
});

describe('renderAgentsTemplate', () => {
  it('renders TODO placeholders for missing commands and detected languages', () => {
    const out = renderAgentsTemplate({ hints: ['package.json'] });
    expect(out).toContain('_TODO_');
    expect(out).toContain('_CLI, server, browser, worker, library, package?_');
    expect(out).toContain('Auto-detected: package.json');
    expect(out).toContain('| _src/_ |');
    expect(out).toContain('| _tests/_ |');
  });

  it('renders detected commands, languages, entry points, and directories', () => {
    const facts: ProjectFacts = {
      build: 'npm run build',
      test: 'npm test',
      lint: 'npm run lint',
      run: 'npm run dev',
      hints: ['package.json scripts'],
      languages: ['TypeScript (5)', 'JavaScript (2)'],
      entryPoints: ['src/main.ts'],
      topDirs: ['src', 'tests'],
    };
    const out = renderAgentsTemplate(facts);
    expect(out).toContain('`npm run build`');
    expect(out).toContain('`npm test`');
    expect(out).toContain('detected: TypeScript (5), JavaScript (2)');
    expect(out).toContain('| `src/main.ts` | _Likely entry point (detected)_ |');
    expect(out).toContain('| `src/` | _Top-level directory (detected)_ |');
    expect(out).not.toContain('| _src/_ |'); // real rows replace placeholders
  });

  it('omits the auto-detected hint line when there are no hints', () => {
    const out = renderAgentsTemplate({ hints: [] });
    expect(out).not.toContain('Auto-detected:');
  });
});
