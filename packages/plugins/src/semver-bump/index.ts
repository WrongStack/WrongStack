import { access, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BumpType, ConventionalCommit } from './semver-operations.js';
import {
  bumpVersion,
  collectManifests,
  determineBump,
  generateChangelog,
  getPackageJson,
  getRecentCommits,
  parseGitLogOutput,
  runCommand,
  runGit,
} from './semver-operations.js';

export { determineBump, parseConventional } from './semver-operations.js';

/**
 * semver-bump plugin — Conventional-commit-driven semver version bumps.
 *
 * Tools registered:
 * - semver_bump: Determine and apply the next version bump
 * - semver_current: Show the current version from package.json
 * - semver_changelog: Generate a changelog between two versions
 */
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { scriptSpawnArgs, toErrorMessage } from '@wrongstack/core/utils';

const API_VERSION = '^0.1.10';

function requireProjectRoot(rawCwd: string | undefined): string {
  const safeCwd = resolveProjectRoot(rawCwd);
  if (!safeCwd) {
    throw new ToolValidationError({
      message: 'cwd must stay within the current project directory',
      field: 'cwd',
    });
  }
  return safeCwd;
}

/** A git ref starting with `-` would be parsed as an option (e.g. `--output=<file>`). */
function requireGitRef(field: string, ref: string | undefined): void {
  if (ref !== undefined && (typeof ref !== 'string' || ref.startsWith('-'))) {
    throw new ToolValidationError({ message: `${field} is not a valid git ref`, field });
  }
}

function resolveProjectRoot(rawCwd: string | undefined, root = process.cwd()): string | null {
  if (typeof rawCwd !== 'string' || rawCwd.length === 0) return root;
  const base = resolve(root);
  const resolved = isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(base, rawCwd);
  const rel = relative(base, resolved);
  if (rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel))) return resolved;
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
    const tagMessage =
      ((api.config.extensions?.['semver-bump'] as Record<string, unknown>)?.[
        'tagMessage'
      ] as string) ?? 'Release {{version}}';

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
      // Failures throw: the executor only flags a call as failed when execute rejects.
      cwd = requireProjectRoot(cwd);
      // Get current version
      const pkg = await getPackageJson(cwd);
      if (!pkg) {
        throw new Error('No package.json found');
      }

      const currentVersion = pkg.version;

      // Determine bump
      let bumpPart: BumpType = part;
      let commits: ConventionalCommit[] = [];

      if (part === 'auto') {
        // Find last tag
        let lastTag: string | undefined;
        try {
          const tagsOutput = await runGit(['describe', '--tags', '--abbrev=0'], cwd);
          lastTag = tagsOutput || undefined;
        } catch {
          // No tags yet — use empty commit list
        }

        try {
          commits = await getRecentCommits(lastTag, cwd);
        } catch (err: unknown) {
          throw new Error(`Git error: ${toErrorMessage(err)}`, { cause: err });
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
          bump: bumpPart,
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
      const changed: string[] = await collectManifests(root);
      let hasBumpScript = true;
      try {
        await access(bumpScript);
      } catch {
        hasBumpScript = false;
      }
      if (hasBumpScript) {
        const generatedPaths = [
          'website/package.json',
          'website/package-lock.json',
          'website/src/lib/utils.ts',
          'website/src/data/content.ts',
          'website/index.html',
          'packages/webui-protocol/schema/ws-core.schema.json',
          'packages/webui-protocol/schema/openapi.json',
        ].map((rel) => join(root, rel));
        const readGenerated = async (p: string): Promise<string | undefined> => {
          try {
            return await readFile(p, 'utf-8');
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
            throw err;
          }
        };
        const before = await Promise.all(generatedPaths.map(readGenerated));
        try {
          await runCommand(
            process.execPath,
            scriptSpawnArgs(bumpScript, ['set', newVersion]),
            root,
          );
        } catch (err: unknown) {
          throw new Error(`bump script failed: ${toErrorMessage(err)}`, { cause: err });
        }
        for (const [index, p] of generatedPaths.entries()) {
          const after = await readGenerated(p);
          if (after === undefined) {
            // Absent both before and after: never tracked in this checkout.
            // Present before but missing after: the script deleted a file it
            // was expected to regenerate — surface it instead of silently
            // dropping the deletion from the version commit.
            if (before[index] !== undefined) {
              throw new Error(
                `bump script deleted a generated file it was expected to regenerate: ${p}`,
              );
            }
            continue;
          }
          if (after !== before[index]) changed.push(p);
        }
      } else {
        // Two-phase: parse and re-serialise EVERY manifest before writing
        // any of them. The previous single loop wrote as it went, so a
        // malformed or unreadable package.json partway through left the
        // repo half-bumped — some packages on the new version, some on the
        // old, and no record of which. A version bump has to be all or
        // nothing; the parse step is where it can still be abandoned safely.
        const pending: { path: string; contents: string; original: string }[] = [];
        const lockstep: string[] = [];
        for (const manifest of changed) {
          let pkgData: { version?: string };
          let original: string;
          try {
            original = await readFile(manifest, 'utf-8');
            pkgData = JSON.parse(original) as { version?: string };
          } catch (err: unknown) {
            throw new Error(
              `cannot bump: ${manifest} is not readable as JSON (${toErrorMessage(err)}). ` +
                'No manifests were modified.',
              { cause: err },
            );
          }
          if (!pkgData || typeof pkgData !== 'object') {
            throw new Error(
              `cannot bump: ${manifest} does not contain a JSON object. No manifests were modified.`,
            );
          }
          // Only manifests on the repo's current version move with it: a
          // workspace package with its own version (or none) is not lockstep.
          if (pkgData.version !== currentVersion) continue;
          pkgData.version = newVersion;
          pending.push({
            path: manifest,
            contents: `${JSON.stringify(pkgData, null, 2)}\n`,
            original,
          });
          lockstep.push(manifest);
        }
        changed.splice(0, changed.length, ...lockstep);
        // A write can still fail (EBUSY/EPERM from an editor or AV handle,
        // ENOSPC): put back what was already written so the bump stays all or
        // nothing instead of leaving the repo half on the new version.
        const written: typeof pending = [];
        try {
          for (const entry of pending) {
            await writeFile(entry.path, entry.contents, 'utf-8');
            written.push(entry);
          }
        } catch (err: unknown) {
          const notRestored: string[] = [];
          for (const entry of written) {
            await writeFile(entry.path, entry.original, 'utf-8').catch(() => {
              notRestored.push(entry.path);
            });
          }
          throw new Error(
            `cannot bump: writing manifests failed (${toErrorMessage(err)}). ` +
              (notRestored.length === 0
                ? 'No manifests were modified.'
                : `Could not restore: ${notRestored.join(', ')}.`),
            { cause: err },
          );
        }
      }

      // 2. Git commit the version bump (stage only the files we touched)
      let commitError: string | undefined;
      try {
        await runGit(['add', '--', ...changed], cwd);
        // `--only`: a bare commit takes the WHOLE index, so anything someone
        // else had staged rode along in the version commit.
        await runGit(
          ['commit', '-m', `chore: bump version to ${newVersion}`, '--only', '--', ...changed],
          cwd,
        );
      } catch (err: unknown) {
        // Manifests are already written, so report rather than throw.
        commitError = toErrorMessage(err);
      }

      // 3. Create git tag
      let tagError: string | undefined;
      if (autoTag && commitError !== undefined) {
        // HEAD is still the previous commit: tagging it would mark a commit
        // whose manifests carry the OLD version as the new release.
        tagError = 'skipped because the version commit failed';
      } else if (autoTag) {
        try {
          const msg = tagMessage.replace('{{version}}', newVersion);
          await runGit(['tag', '-a', `${tagPrefix}${newVersion}`, '-m', msg], cwd);
        } catch (err: unknown) {
          tagError = toErrorMessage(err);
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

      const tagged = autoTag && tagError === undefined;
      const warnings = [
        ...(commitError ? [`commit failed: ${commitError}`] : []),
        ...(tagError ? [`tag failed: ${tagError}`] : []),
      ];
      return {
        ok: true,
        currentVersion,
        newVersion,
        bump: bumpPart,
        // Only name the tag when it was actually created.
        tag: tagged ? `${tagPrefix}${newVersion}` : null,
        committed: commitError === undefined,
        tagged,
        ...(warnings.length > 0 ? { warnings } : {}),
        message:
          `Bumped ${currentVersion} → ${newVersion} (${bumpPart})` +
          (warnings.length > 0 ? ` — ${warnings.join('; ')}` : ''),
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
        const dryRun =
          (input['dry_run'] as boolean | undefined) ??
          (input['dryRun'] as boolean | undefined) ??
          (input['dry'] as boolean | undefined) ??
          false;
        const rawPart =
          input['part'] ??
          input['bumpType'] ??
          input['bump_type'] ??
          input['type'] ??
          input['releaseType'] ??
          input['release_type'] ??
          input['level'] ??
          input['increment'] ??
          input['bump'];
        const normPart = typeof rawPart === 'string' ? rawPart.trim().toLowerCase() : undefined;
        const part =
          normPart === 'major' ||
          normPart === 'minor' ||
          normPart === 'patch' ||
          normPart === 'auto'
            ? (normPart as BumpType)
            : defaultPart;
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
          const pkg = await getPackageJson(cwd);
          if (!pkg) return { message: 'No package.json found' };
          let lastTag: string | undefined;
          try {
            lastTag = (await runGit(['describe', '--tags', '--abbrev=0'], cwd)) || undefined;
          } catch {
            // not a git repo or no tags yet
          }
          let suggestion: BumpType = 'patch';
          let commitCount = 0;
          try {
            const commits = await getRecentCommits(lastTag, cwd);
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
        try {
          const result = await performBump(mode, dry, safeCwd);
          /* v8 ignore next -- performBump always returns a message; the JSON.stringify fallback is defensive. */
          return { message: String(result['message'] ?? JSON.stringify(result)) };
        } catch (err: unknown) {
          return { message: toErrorMessage(err) };
        }
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
        const safeCwd = requireProjectRoot(input['cwd'] as string | undefined);

        const pkg = await getPackageJson(safeCwd);
        const currentVersion = pkg?.version ?? 'unknown';

        let latestTag: string | null = null;
        let commitsSinceTag = 0;
        try {
          const tagsOutput = await runGit(['describe', '--tags', '--abbrev=0'], safeCwd);
          latestTag = tagsOutput || null;

          if (latestTag) {
            const countOutput = await runGit(
              ['rev-list', '--count', `${latestTag}..HEAD`],
              safeCwd,
            );
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
        requireGitRef('from', from);
        requireGitRef('to', to);
        const safeCwd = requireProjectRoot(input['cwd'] as string | undefined);
        const format = (input['format'] as 'markdown' | 'json') ?? 'markdown';

        // Without `from`, the last 30 commits reachable from `to` (it was ignored before).
        const rangeArgs = from ? [`${from}..${to}`] : ['-30', to];

        let commits: ConventionalCommit[];
        try {
          const output = await runGit(
            ['log', ...rangeArgs, '--format=%H%x1f%s%x1f%b%x1e'],
            safeCwd,
          );
          commits = parseGitLogOutput(output);
        } catch (err: unknown) {
          throw new Error(`Failed to get git log: ${toErrorMessage(err)}`, { cause: err });
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
    // file handles, timers, or watches — every git command is awaited
    // before the tool returns. The
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
