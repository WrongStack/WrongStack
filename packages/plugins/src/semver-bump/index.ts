import { expectDefined } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
/**
 * semver-bump plugin — Conventional-commit-driven semver version bumps.
 *
 * Tools registered:
 * - semver_bump: Determine and apply the next version bump
 * - semver_current: Show the current version from package.json
 * - semver_changelog: Generate a changelog between two versions
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
const API_VERSION = '^0.1.10';

function resolveProjectRoot(rawCwd: string | undefined, root = process.cwd()): string | null {
  if (typeof rawCwd !== 'string' || rawCwd.length === 0) return root;
  const base = resolve(root);
  const resolved = isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(base, rawCwd);
  const rel = relative(base, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return resolved;
  return null;
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern: shared between setup, teardown,
// health). semver-bump is a pure git-wrapper — no timers, no handles,
// no caches. The state block tracks per-session invocation counts
// (per-tool and total) so /diag plugins can report "how many bumps
// did this session perform?" Setup is idempotent: re-init zeros
// the counters; teardown leaves them at zero.
// ---------------------------------------------------------------------------
const state = {
  /** Total invocations across all three tools this session. */
  invocationCount: 0,
  /** Per-tool invocation counts so /diag can show "bumps: 2, current: 5". */
  perTool: { semver_bump: 0, semver_current: 0, semver_changelog: 0 } as Record<string, number>,
  /** Most recent bump result, surfaced by health() (null until first call). */
  lastBump: null as null | {
    when: string;
    from: string;
    to: string;
    type: 'major' | 'minor' | 'patch' | 'auto';
    commitCount: number;
    breakingCount: number;
  },
};

type BumpType = 'major' | 'minor' | 'patch' | 'auto';

interface ConventionalCommit {
  hash: string;
  type: string;
  scope?: string | undefined;
  message: string;
  breaking: boolean;
}

function runGit(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    }).trim();
  } catch (err: unknown) {
    const e = err as {
      message?: string | undefined;
      stderr?: string | undefined;
      status?: number | undefined;
    };
    if (e.status === 128) throw new Error('Not a git repository');
    /* v8 ignore next -- execFileSync errors always carry .message; the stderr/String fallbacks are defensive. */
    throw new Error(`git failed: ${e.message ?? e.stderr ?? String(err)}`);
  }
}

function getPackageJson(cwd?: string): { version: string } | null {
  const path = cwd ? `${cwd}/package.json` : 'package.json';
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Every package.json that must share the repo version: the root manifest plus
 * workspace packages under packages/* and apps/* (mirrors
 * scripts/bump-version.mjs). Single-package repos degrade to just the root.
 */
function collectManifests(root: string): string[] {
  const paths: string[] = [];
  const rootPkg = join(root, 'package.json');
  if (existsSync(rootPkg)) paths.push(rootPkg);
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(groupDir, entry.name, 'package.json');
      if (existsSync(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [
    Number.parseInt(expectDefined(m[1]), 10),
    Number.parseInt(expectDefined(m[2]), 10),
    Number.parseInt(expectDefined(m[3]), 10),
  ];
}

function bumpVersion(version: string, part: BumpType): string {
  let [major, minor, patch] = parseVersion(version);

  if (part === 'major') {
    major++;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    minor++;
    patch = 0;
  } else if (part === 'patch') {
    patch++;
  } else {
    /* v8 ignore next -- callers resolve 'auto' to a concrete part before calling bumpVersion; this return is defensive. */
    return version; // auto requires commit analysis
  }

  return `${major}.${minor}.${patch}`;
}

/** Parse a conventional-commit subject line. Accepts the breaking `!` both
 * before and after the scope (`feat!: x`, `feat(api)!: x`). */
export function parseConventional(subject: string): Omit<ConventionalCommit, 'hash'> {
  const m = subject.match(/^(\w+)(!)?(?:\(([^)]+)\))?(!)?:\s+(.+)/);
  return {
    type: m?.[1] ?? 'chore',
    breaking: !!(m?.[2] ?? m?.[4]),
    scope: m?.[3],
    message: m?.[5] ?? subject,
  };
}

function getRecentCommits(sinceTag?: string, cwd?: string): ConventionalCommit[] {
  const range = sinceTag ? `${sinceTag}..HEAD` : '-30';
  const output = runGit(['log', range, '--format=%H %s'], cwd);

  if (!output) return [];

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(' ');
      const hash = line.slice(0, spaceIdx);
      const message = line.slice(spaceIdx + 1);
      return { hash, ...parseConventional(message) };
    });
}

export function determineBump(commits: ConventionalCommit[]): BumpType {
  if (commits.some((c) => c.breaking)) return 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
}

function generateChangelog(commits: ConventionalCommit[]): string {
  const sections = {
    breaking: [] as ConventionalCommit[],
    feat: [] as ConventionalCommit[],
    fix: [] as ConventionalCommit[],
    perf: [] as ConventionalCommit[],
    docs: [] as ConventionalCommit[],
    refactor: [] as ConventionalCommit[],
    test: [] as ConventionalCommit[],
    chore: [] as ConventionalCommit[],
    other: [] as ConventionalCommit[],
  };
  type SectionKey = keyof typeof sections;

  for (const c of commits) {
    if (c.breaking) {
      sections.breaking.push(c);
    } else if (c.type in sections) {
      sections[c.type as SectionKey].push(c);
    } else {
      sections.other.push(c);
    }
  }

  const lines: string[] = ['# Changelog\n'];

  if (sections.breaking.length > 0) {
    lines.push('## ⚠️ BREAKING CHANGES\n');
    for (const c of sections.breaking) {
      lines.push(`- **${c.hash.slice(0, 7)}** ${c.message} (${c.type})`);
    }
    lines.push('');
  }

  const ordered = ['feat', 'fix', 'perf', 'docs', 'refactor', 'test', 'chore', 'other'] as const;
  const labels: Record<SectionKey, string> = {
    breaking: 'Breaking',
    feat: 'Features',
    fix: 'Bug Fixes',
    perf: 'Performance',
    docs: 'Documentation',
    refactor: 'Refactoring',
    test: 'Tests',
    chore: 'Chores',
    other: 'Other Changes',
  };

  for (const key of ordered) {
    const items = sections[key];
    if (items.length === 0) continue;
    lines.push(`## ${labels[key]}\n`);
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}**: ` : '';
      lines.push(`- **${c.hash.slice(0, 7)}** ${scope}${c.message}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'semver-bump',
  version: '0.1.0',
  description: 'Conventional-commit-driven semver version bumps with changelog generation',
  apiVersion: API_VERSION,
  capabilities: { tools: true, slashCommands: true },
  defaultConfig: {
    tagPrefix: 'v',
    changelogFile: 'CHANGELOG.md',
    autoTag: true,
    tagMessage: 'Release {{version}}',
    defaultPart: 'patch',
  },
  configSchema: {
    type: 'object',
    properties: {
      tagPrefix: { type: 'string', default: 'v' },
      changelogFile: { type: 'string', default: 'CHANGELOG.md' },
      autoTag: { type: 'boolean', default: true },
      tagMessage: { type: 'string', default: 'Release {{version}}' },
      defaultPart: { type: 'string', enum: ['major', 'minor', 'patch', 'auto'], default: 'patch' },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern): zero counters on reload.
    state.invocationCount = 0;
    state.perTool = { semver_bump: 0, semver_current: 0, semver_changelog: 0 };
    state.lastBump = null;

    const tagPrefix =
      ((api.config.extensions?.['semver-bump'] as Record<string, unknown>)?.[
        'tagPrefix'
      ] as string) ?? 'v';
    const autoTag =
      ((api.config.extensions?.['semver-bump'] as Record<string, unknown>)?.[
        'autoTag'
      ] as boolean) ?? true;

    const VALID_PARTS: readonly BumpType[] = ['major', 'minor', 'patch', 'auto'];
    function readDefaultPart(cfg: typeof api.config): BumpType {
      const raw = (cfg.extensions?.['semver-bump'] as Record<string, unknown> | undefined)?.[
        'defaultPart'
      ];
      return VALID_PARTS.includes(raw as BumpType) ? (raw as BumpType) : 'patch';
    }
    // Tracked live so `/settings semver-part` applies without a restart.
    let defaultPart: BumpType = readDefaultPart(api.config);
    api.onConfigChange?.((next) => {
      defaultPart = readDefaultPart(next as typeof api.config);
    });

    /** Shared by the semver_bump tool and the /semver slash command. */
    async function performBump(
      part: BumpType,
      dryRun: boolean,
      cwd?: string,
    ): Promise<Record<string, unknown>> {
      const safeCwd = resolveProjectRoot(cwd);
      if (!safeCwd && !dryRun) {
        return { ok: false, error: 'cwd must stay within the current project directory' };
      }
      cwd = safeCwd ?? cwd;
      // Get current version
      const pkg = getPackageJson(cwd);
      if (!pkg) {
        return { ok: false, error: 'No package.json found' };
      }

      const currentVersion = pkg.version;

      // Determine bump
      let bumpPart: BumpType = part;
      let commits: ConventionalCommit[] = [];

      if (part === 'auto') {
        // Find last tag
        let lastTag: string | undefined;
        try {
          const tagsOutput = runGit(['describe', '--tags', '--abbrev=0'], cwd);
          lastTag = tagsOutput || undefined;
        } catch {
          // No tags yet — use empty commit list
        }

        try {
          commits = getRecentCommits(lastTag, cwd);
        } catch (err: unknown) {
          /* v8 ignore next -- getRecentCommits only throws Error; the String(err) branch is defensive. */
          const msg = toErrorMessage(err);
          return { ok: false, error: `Git error: ${msg}`, bumpPart: 'patch' };
        }
        bumpPart = determineBump(commits);
      } else {
        bumpPart = part;
      }

      const newVersion = bumpVersion(currentVersion, bumpPart);

      if (dryRun) {
        return {
          ok: true,
          dry_run: true,
          currentVersion,
          suggestedBump: bumpPart,
          newVersion,
          commitCount: part === 'auto' ? commits.length : undefined,
          message: `Would bump ${currentVersion} → ${newVersion} (${bumpPart})`,
        };
      }

      // Actually apply the bump
      // 1. Update every manifest that shares the repo version. If the repo
      //    has its own lockstep script (the single bump entry point — it
      //    also covers files outside the workspace, e.g. website/), delegate
      //    to it so the plugin can never drift from the repo's convention.
      const root = cwd ?? process.cwd();
      const bumpScript = join(root, 'scripts', 'bump-version.mjs');
      const changed: string[] = collectManifests(root);
      if (existsSync(bumpScript)) {
        try {
          execFileSync(process.execPath, [bumpScript, 'set', newVersion], {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30_000,
            windowsHide: true,
          });
        } catch (err: unknown) {
          /* v8 ignore next -- execFileSync only throws Error; the String(err) branch is defensive. */
          const msg = toErrorMessage(err);
          return { ok: false, error: `bump script failed: ${msg}` };
        }
        for (const rel of ['package.json', 'package-lock.json', 'src/lib/utils.ts', 'index.html']) {
          const p = join(root, 'website', rel);
          if (existsSync(p)) changed.push(p);
        }
      } else {
        for (const manifest of changed) {
          const pkgData = JSON.parse(readFileSync(manifest, 'utf-8'));
          pkgData.version = newVersion;
          writeFileSync(manifest, JSON.stringify(pkgData, null, 2) + '\n', 'utf-8');
        }
      }

      // 2. Git commit the version bump (stage only the files we touched)
      try {
        runGit(['add', '--', ...changed], cwd);
        runGit(['commit', '-m', `chore: bump version to ${newVersion}`], cwd);
      } catch {
        // commit might fail if nothing changed, that's OK
      }

      // 3. Create git tag
      if (autoTag) {
        try {
          runGit(['tag', '-a', `${tagPrefix}${newVersion}`, '-m', `Release ${newVersion}`], cwd);
        } catch {
          // tag might already exist
        }
      }

      api.log.info('semver-bump: bumped', { from: currentVersion, to: newVersion, bump: bumpPart });
      api.metrics.counter('version_bump', 1, { bump: bumpPart });

      await api.session.append({
        type: 'semver-bump:bumped',
        ts: new Date().toISOString(),
        from: currentVersion,
        to: newVersion,
        bump: bumpPart,
      });

      // Snapshot the success for health() / /diag plugins. We capture
      // commit counts at this point because the bumps write a
      // "chore: bump version" commit after this block, so the
      // pre-bump count is the meaningful one for an operator.
      state.lastBump = {
        when: new Date().toISOString(),
        from: currentVersion,
        to: newVersion,
        type: bumpPart,
        commitCount: commits.length,
        breakingCount: commits.filter((c) => c.breaking).length,
      };

      return {
        ok: true,
        currentVersion,
        newVersion,
        bump: bumpPart,
        tag: `${tagPrefix}${newVersion}`,
        message: `Bumped ${currentVersion} → ${newVersion} (${bumpPart})`,
      };
    }

    // --- semver_bump ---
    api.tools.register({
      name: 'semver_bump',
      description:
        'Determine the next version bump from conventional commits since the last tag, or force a specific bump. Creates a git tag.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Working directory (defaults to project root)' },
          dry_run: { type: 'boolean', default: false },
          part: {
            type: 'string',
            enum: ['major', 'minor', 'patch', 'auto'],
            default: defaultPart,
            description:
              'Version part to bump. Omitted → the configured default (/settings semver-part, factory default: patch). Use auto to infer from commits.',
          },
        },
      },
      permission: 'confirm',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        state.invocationCount += 1;
        state.perTool['semver_bump'] = (state.perTool['semver_bump'] ?? 0) + 1;
        const cwd = input['cwd'] as string | undefined;
        const dryRun = (input['dry_run'] as boolean | undefined) ?? false;
        const part = (input['part'] as BumpType) ?? defaultPart;
        return performBump(part, dryRun, cwd);
      },
    });

    // --- /semver slash command — lets the user pick the bump mode directly ---
    api.slashCommands.register({
      name: 'semver',
      description: 'Show the current version or bump it (patch/minor/major/auto)',
      category: 'Run',
      argsHint: '[status|patch|minor|major|auto] [--dry]',
      help: [
        '/semver               Show current version, latest tag and the suggested bump',
        '/semver status        Same as bare /semver',
        '/semver patch         Bump the patch version (commit + tag)',
        '/semver minor         Bump the minor version (commit + tag)',
        '/semver major         Bump the major version (commit + tag)',
        '/semver auto          Infer the bump from conventional commits since the last tag',
        '/semver <part> --dry  Preview without writing anything',
      ].join('\n'),
      async run(args, ctx) {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const dry = tokens.includes('--dry') || tokens.includes('--dry-run');
        const mode = tokens.find((t) => !t.startsWith('--')) ?? 'status';
        const cwd = ctx?.cwd;

        if (mode === 'status') {
          const pkg = getPackageJson(cwd);
          if (!pkg) return { message: 'No package.json found' };
          let lastTag: string | undefined;
          try {
            lastTag = runGit(['describe', '--tags', '--abbrev=0'], cwd) || undefined;
          } catch {
            // not a git repo or no tags yet
          }
          let suggestion: BumpType = 'patch';
          let commitCount = 0;
          try {
            const commits = getRecentCommits(lastTag, cwd);
            commitCount = commits.length;
            suggestion = determineBump(commits);
          } catch {
            // git unavailable — keep the patch default
          }
          return {
            message: [
              `Current version: ${pkg.version}`,
              `Latest tag:      ${lastTag ?? '(none)'}`,
              `Commits since:   ${commitCount}`,
              `Suggested bump:  ${suggestion} → ${bumpVersion(pkg.version, suggestion)}`,
              `Default part:    ${defaultPart} (change: /settings semver-part)`,
              '',
              'Run /semver patch|minor|major|auto to apply (add --dry to preview).',
            ].join('\n'),
          };
        }

        if (mode !== 'patch' && mode !== 'minor' && mode !== 'major' && mode !== 'auto') {
          return { message: `Unknown mode "${mode}". Use status, patch, minor, major or auto.` };
        }

        const safeCwd = resolveProjectRoot(cwd);
        if (!safeCwd) {
          return { message: 'cwd must stay within the current project directory' };
        }
        const result = await performBump(mode, dry, safeCwd);
        /* v8 ignore next -- performBump always returns a message or an error; the JSON.stringify fallback is defensive. */
        return { message: String(result['message'] ?? result['error'] ?? JSON.stringify(result)) };
      },
    });

    // --- semver_current ---
    api.tools.register({
      name: 'semver_current',
      description: 'Return the current version from package.json and the latest git tag.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Working directory' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        state.invocationCount += 1;
        state.perTool['semver_current'] = (state.perTool['semver_current'] ?? 0) + 1;
        const cwdInput = input['cwd'] as string | undefined;
        const safeCwd = resolveProjectRoot(cwdInput);
        if (!safeCwd) {
          return { ok: false, error: 'cwd must stay within the current project directory' };
        }

        const pkg = getPackageJson(safeCwd);
        const currentVersion = pkg?.version ?? 'unknown';

        let latestTag: string | null = null;
        let commitsSinceTag = 0;
        try {
          const tagsOutput = runGit(['describe', '--tags', '--abbrev=0'], safeCwd);
          latestTag = tagsOutput || null;

          if (latestTag) {
            const countOutput = runGit(['rev-list', '--count', `${latestTag}..HEAD`], safeCwd);
            commitsSinceTag = Number.parseInt(countOutput, 10) || 0;
          }
        } catch {
          latestTag = null;
        }

        return {
          ok: true,
          currentVersion,
          latestTag: latestTag ?? null,
          tagPrefix,
          commitsSinceTag,
        };
      },
    });

    // --- semver_changelog ---
    api.tools.register({
      name: 'semver_changelog',
      description:
        'Generate a changelog (in markdown) between two version tags or from a tag to HEAD.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Starting tag (exclusive)' },
          to: { type: 'string', description: 'Ending tag or "HEAD"' },
          cwd: { type: 'string', description: 'Working directory' },
          format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
        },
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        state.invocationCount += 1;
        state.perTool['semver_changelog'] = (state.perTool['semver_changelog'] ?? 0) + 1;
        const from = input['from'] as string | undefined;
        const to = (input['to'] as string) ?? 'HEAD';
        const cwd = input['cwd'] as string | undefined;
        const safeCwd = resolveProjectRoot(cwd);
        if (!safeCwd) {
          return { ok: false, error: 'cwd must stay within the current project directory' };
        }
        const format = (input['format'] as 'markdown' | 'json') ?? 'markdown';

        const range = from ? `${from}..${to}` : to;

        let commits: ConventionalCommit[];
        try {
          const output = runGit(['log', range === to ? '-30' : range, '--format=%H %s'], safeCwd);
          commits = output
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const spaceIdx = line.indexOf(' ');
              const hash = line.slice(0, spaceIdx);
              const message = line.slice(spaceIdx + 1);
              return { hash, ...parseConventional(message) };
            });
        } catch (err: unknown) {
          return { ok: false, error: `Failed to get git log: ${err}` };
        }

        if (format === 'json') {
          return {
            ok: true,
            from,
            to,
            commits,
            commitCount: commits.length,
          };
        }

        const changelog = generateChangelog(commits);

        return {
          ok: true,
          from: from ?? '(beginning)',
          to,
          changelog,
          commitCount: commits.length,
          breakingCount: commits.filter((c) => c.breaking).length,
        };
      },
    });

    api.log.info('semver-bump plugin loaded', { version: '0.1.0', tagPrefix, autoTag });
  },

  teardown(api) {
    // H1 pattern: zero counters on unload. semver-bump has no
    // file handles, timers, or watches — every git command runs
    // synchronously and completes before the tool returns. The
    // unload log preserves per-session invocation counts so
    // operators can see how many bumps/changelogs/queries the
    // session performed.
    const finalTotal = state.invocationCount;
    const finalPerTool = { ...state.perTool };
    state.invocationCount = 0;
    state.perTool = { semver_bump: 0, semver_current: 0, semver_changelog: 0 };
    state.lastBump = null;
    api.log.info('semver-bump: teardown complete', {
      invocations: finalTotal,
      perTool: finalPerTool,
    });
  },

  async health() {
    // /diag plugins — surface a one-line status plus per-session
    // counters so an operator can confirm the plugin is wired and
    // see how heavily it's been used. No resources to track.
    return {
      ok: true,
      message:
        state.lastBump === null
          ? `semver-bump: ${state.invocationCount} call(s) this session`
          : `semver-bump: last bump ${state.lastBump.from} → ${state.lastBump.to} (${state.lastBump.type}) at ${state.lastBump.when}`,
      invocationCount: state.invocationCount,
      perTool: { ...state.perTool },
      lastBump: state.lastBump,
    };
  },
};

export default plugin;
