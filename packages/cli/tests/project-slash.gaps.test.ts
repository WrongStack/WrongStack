import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readProjectIdentity, stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The switch path spawns a detached interactive session. Replace the real
// spawn with a stub so the test covers the kill/stop orchestration without
// leaking a stray process.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((..._args: unknown[]) => ({
      on: vi.fn(),
      unref: vi.fn(),
    })),
  };
});
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildProjectCommand } from '../src/slash-commands/project.js';
import { saveManifest } from '../src/services/project-manifest.js';

let home: string;
let projectRoot: string;
let globalConfig: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-project-home-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-project-root-'));
  globalConfig = path.join(home, 'config.json');
});

afterEach(async () => {
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
  await fs.rm(home, rmOpts);
  await fs.rm(projectRoot, rmOpts);
});

interface CtxOverrides {
  confirm?: (question: string, def: boolean) => Promise<boolean>;
  onFleetStatus?: () => { subagents: Array<{ status: string }> };
  onFleetKill?: () => Promise<number>;
  getEternalEngine?: () => { currentState: string; stop: () => void } | null;
  getParallelEngine?: () => { currentState: string; stop: () => void } | null;
}

function makeCtx(overrides: CtxOverrides = {}): SlashCommandContext {
  const writes: string[] = [];
  return {
    projectRoot,
    cwd: projectRoot,
    paths: { globalConfig },
    renderer: { write: (text: string) => writes.push(text) },
    ...overrides,
  } as never as SlashCommandContext;
}

function command(overrides: CtxOverrides = {}) {
  const ctx = makeCtx(overrides);
  return {
    ctx,
    writes: (ctx as unknown as { renderer: { write: (t: string) => void } }).renderer
      ? undefined
      : undefined,
    run: async (args: string) =>
      (await buildProjectCommand(makeCtx(overrides)).run!(args, ctx as never)) as {
        message: string;
      },
  };
}

async function seedManifest(
  projects: Array<{ name: string; root?: string; slug?: string; lastSeen?: string | undefined }>,
) {
  await saveManifest(
    {
      projects: projects.map((p, i) => ({
        name: p.name,
        root: p.root ?? path.join(home, 'roots', p.name),
        slug: p.slug ?? `slug-${i}`,
        ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}),
        createdAt: p.lastSeen ?? '2026-01-01T00:00:00.000Z',
      })),
    },
    globalConfig,
  );
}

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('/project list', () => {
  it('falls back to the list for a bare invocation without a TTY', async () => {
    const out = await command().run('');
    expect(stripAnsi(out.message)).toContain('No projects registered');
  });

  it('lists projects with the active-session marker and friendly recency labels', async () => {
    await seedManifest([
      { name: 'Old', slug: 's-old', lastSeen: minutesAgo(60 * 24 * 400) },
      { name: 'Current', root: projectRoot, slug: 's-cur', lastSeen: minutesAgo(0.2) },
      { name: 'Recent', slug: 's-rec', lastSeen: minutesAgo(5) },
      { name: 'Ages', slug: 's-ages', lastSeen: minutesAgo(60 * 26) },
      { name: 'Never', slug: 's-never', lastSeen: undefined },
    ]);
    const out = await command().run('list');
    const text = stripAnsi(out.message);
    expect(text).toContain('Projects (5) registered');
    expect(text).toContain('● Current');
    expect(text).toContain('← active session');
    expect(text).toContain('○ Old');
    expect(text).toContain('just now');
    expect(text).toContain('5m ago');
    expect(text).toContain('yesterday');
    expect(text).toContain('1y ago');
    expect(text).toContain('never');
  });

  it('sorts by name when both lastSeen values are missing', async () => {
    await seedManifest([
      { name: 'Zeta', slug: 's-z', lastSeen: undefined },
      { name: 'Alpha', slug: 's-a', lastSeen: undefined },
    ]);
    const out = await command().run('ls');
    const text = stripAnsi(out.message);
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Zeta'));
  });
});

describe('/project identity', () => {
  it('suggests init when no identity exists', async () => {
    const out = await command().run('id');
    expect(stripAnsi(out.message)).toContain('No committed project identity');
  });

  it('init creates the identity and gitignore, and is idempotent', async () => {
    const created = await command().run('init');
    expect(stripAnsi(created.message)).toContain('Created');

    const identity = await readProjectIdentity(projectRoot);
    expect(identity).not.toBeNull();

    const again = await command().run('init');
    expect(stripAnsi(again.message)).toContain('already exists');

    const shown = await command().run('id');
    expect(stripAnsi(shown.message)).toContain(identity!.projectId);
  });

  it('rekey requires explicit confirmation', async () => {
    const bare = await command().run('rekey');
    expect(stripAnsi(bare.message)).toContain('Rekey requires confirmation');

    const declined = await command({ confirm: async () => false }).run('rekey');
    expect(stripAnsi(declined.message)).toContain('Rekey cancelled');

    const before = await readProjectIdentity(projectRoot);
    const rekeyed = await command().run('rekey --yes');
    const text = stripAnsi(rekeyed.message);
    expect(text).toContain('New project ID:');
    const after = await readProjectIdentity(projectRoot);
    expect(after!.projectId).not.toBe(before?.projectId);
  });
});

describe('/project add', () => {
  it('prints usage without a path', async () => {
    const out = await command().run('add');
    expect(stripAnsi(out.message)).toContain('Usage: /project add <path> [name]');
  });

  it('rejects missing paths and plain files', async () => {
    const missing = await command().run('add does-not-exist');
    expect(stripAnsi(missing.message)).toContain('Directory not found');

    const filePath = path.join(projectRoot, 'file.txt');
    await fs.writeFile(filePath, 'x', 'utf8');
    const notDir = await command().run(`add ${filePath}`);
    expect(stripAnsi(notDir.message)).toContain('Not a directory');
  });

  it('registers a project with an explicit or derived name', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-addme-'));
    const out = await command().run(`add ${target} My Custom Name`);
    const text = stripAnsi(out.message);
    expect(text).toContain('Added project: My Custom Name');
    expect(text).toContain(target);

    const dupe = await command().run(`add ${target}`);
    expect(stripAnsi(dupe.message)).toContain('already registered');

    const derived = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-derived-'));
    const out2 = await command().run(`add ${derived}`);
    expect(stripAnsi(out2.message)).toContain(
      `Added project: ${path.basename(derived)}`,
    );
  });
});

describe('/project rename and remove', () => {
  beforeEach(async () => {
    await seedManifest([{ name: 'Alpha', slug: 'alpha-1' }, { name: 'Beta', slug: 'beta-1' }]);
  });

  it('prints rename usage and reports unknown projects', async () => {
    const usage = await command().run('rename only-slug');
    expect(stripAnsi(usage.message)).toContain('Usage: /project rename <slug> <new-name>');

    const missing = await command().run('rename ghost NewName');
    expect(stripAnsi(missing.message)).toContain('Project not found: "ghost"');
  });

  it('renames by slug and by (case-insensitive) name', async () => {
    const bySlug = await command().run('rename alpha-1 Prime');
    expect(stripAnsi(bySlug.message)).toContain('Renamed: "Alpha" → "Prime" (alpha-1)');

    const byName = await command().run('rename BETA Second');
    expect(stripAnsi(byName.message)).toContain('Renamed: "Beta" → "Second"');
  });

  it('prints remove usage, reports unknown projects, and removes by name', async () => {
    const usage = await command().run('remove');
    expect(stripAnsi(usage.message)).toContain('Usage: /project remove <slug>');

    const missing = await command().run('remove ghost');
    expect(stripAnsi(missing.message)).toContain('Project not found: "ghost"');

    const removed = await command().run('remove ALPHA');
    expect(stripAnsi(removed.message)).toContain('Removed: "Alpha"');
  });
});

describe('/project switch', () => {
  it('explains TTY requirements for the interactive variants', async () => {
    const noArgs = await command().run('switch');
    expect(stripAnsi(noArgs.message)).toContain('interactive picker requires a TTY');

    const flag = await command().run('switch --interactive');
    expect(stripAnsi(flag.message)).toContain(
      'Usage: /project switch --interactive (interactive picker requires a TTY)',
    );

    const shortFlag = await command().run('switch -i');
    expect(stripAnsi(shortFlag.message)).toContain('interactive picker requires a TTY');
  });

  it('validates the target directory before switching', async () => {
    const missing = await command().run('switch missing-dir');
    expect(stripAnsi(missing.message)).toContain('Directory not found');

    const filePath = path.join(projectRoot, 'f.txt');
    await fs.writeFile(filePath, 'x', 'utf8');
    const notDir = await command().run(`switch ${filePath}`);
    expect(stripAnsi(notDir.message)).toContain('Not a directory');
  });

  it('cancels the switch when the user declines the running-agents warning', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-switchto-'));
    const out = await command({
      onFleetStatus: () => ({ subagents: [{ status: 'running' }, { status: 'idle' }] }),
      confirm: async () => false,
    }).run(`switch ${target} --name Custom`);
    expect(out.message).toBe('');
  });

  it('kills running agents and stops engines when the user confirms', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-switchyes-'));
    const onFleetKill = vi.fn(async () => 2);
    const eternalStop = vi.fn();
    const parallelStop = vi.fn();
    const out = await command({
      onFleetStatus: () => ({ subagents: [{ status: 'running' }] }),
      onFleetKill,
      getEternalEngine: () => ({ currentState: 'running', stop: eternalStop }),
      getParallelEngine: () => ({ currentState: 'running', stop: parallelStop }),
      confirm: async () => true,
    }).run(`switch ${target}`);
    // The spawn itself happens fire-and-forget; the command still reports it.
    expect(stripAnsi(out.message)).toContain('Spawning wstack in');
    // Give the spawned child a moment, then make sure it cannot linger.
    await new Promise((r) => setTimeout(r, 200));
    expect(onFleetKill).toHaveBeenCalled();
    expect(eternalStop).toHaveBeenCalled();
    expect(parallelStop).toHaveBeenCalled();
  }, 30_000);
});

describe('/project unknown subcommands', () => {
  it('prints the usage summary', async () => {
    const out = await command().run('teleport');
    expect(stripAnsi(out.message)).toContain('Unknown: "teleport"');
    expect(stripAnsi(out.message)).toContain('Usage: /project [ls|list|id|init|rekey|add|rename|remove|switch]');
  });
});
