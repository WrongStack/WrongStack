/**
 * Lockfile sync — after a commit, is the lockfile still the one the manifests
 * describe?
 *
 * A commit that changes a manifest's dependencies (`package.json`,
 * `Cargo.toml`, `go.mod`) without the lockfile that pins them leaves the
 * repository in a state a locked install (CI's `pnpm install --frozen-lockfile`,
 * `npm ci`, `cargo build --locked`) refuses, or resolves differently on the
 * next machine. Nothing else looks at the committed pair: the
 * lockfile-consistency analyzer only reads text the model hands it.
 *
 * Only a lockfile the repository TRACKS counts: a library that keeps its
 * lockfile out of git has nothing to keep in sync. A root commit, a merge
 * and a deleted manifest are not judged.
 */

import { execFile } from 'node:child_process';
import type { HookInput, PluginAPI } from '@wrongstack/contracts/types';
import { shellCommandLinesFromInput } from '@wrongstack/core/security';
import { buildChildEnv } from '@wrongstack/core/utils';
import { gitIsolationEnv } from '@wrongstack/primitives';

export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

type ManifestKind = 'npm' | 'cargo' | 'go';

const MANIFESTS: Record<string, ManifestKind> = {
  'package.json': 'npm',
  'Cargo.toml': 'cargo',
  'go.mod': 'go',
};

/** Lockfiles per ecosystem, in the order a directory is searched. */
const LOCKFILES: Record<ManifestKind, readonly string[]> = {
  npm: [
    'pnpm-lock.yaml',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ],
  cargo: ['Cargo.lock'],
  go: ['go.sum'],
};

const REFRESH_COMMAND: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm install',
  'package-lock.json': 'npm install',
  'npm-shrinkwrap.json': 'npm install',
  'yarn.lock': 'yarn install',
  'bun.lock': 'bun install',
  'bun.lockb': 'bun install',
  'Cargo.lock': 'cargo check',
  'go.sum': 'go mod tidy',
};

export interface LockfileDrift {
  manifest: string;
  lockfile: string;
  /** Short description of what changed, e.g. `+zod, ~react`. */
  summary: string;
}

export const runGit: GitRunner = async (cwd, args) => {
  // The repository's config names programs git runs on status/diff
  // (fsmonitor, `.gitattributes` filters); when they cannot be switched off,
  // git does not run.
  const isolation = await gitIsolationEnv(cwd, { baseEnv: buildChildEnv() });
  if (!isolation) return null;
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...buildChildEnv(), ...isolation },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
};

// ---------------------------------------------------------------------------
// Commit detection
// ---------------------------------------------------------------------------

const SHELL_GIT_COMMIT = /(?:^|[\s;&|(])git(?:\s+-[cC]\s+\S+)*\s+commit\b/;

/** True when a finished tool call made a commit: the `git` tool's `commit`, or `git commit` in a shell. */
export function isCommitCall(
  toolName: string | undefined,
  toolInput: unknown,
  shellCommand: string,
): boolean {
  if (toolName === 'git') {
    const command = (toolInput as { command?: unknown } | null | undefined)?.command;
    return command === 'commit';
  }
  return shellCommand.length > 0 && SHELL_GIT_COMMIT.test(shellCommand);
}

// ---------------------------------------------------------------------------
// Dependency extraction
// ---------------------------------------------------------------------------

const NPM_DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** `section:name` → spec, plus the resolution overrides as one entry each. Null when unparseable. */
function npmDeps(text: string): Map<string, string> | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== 'object') return null;
  const p = pkg as Record<string, unknown>;
  const out = new Map<string, string>();
  for (const section of NPM_DEP_SECTIONS) {
    const deps = p[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      out.set(`${section}:${name}`, String(spec));
    }
  }
  const pnpm = p['pnpm'] as Record<string, unknown> | undefined;
  const overrides: Array<[string, unknown]> = [
    ['overrides', p['overrides']],
    ['resolutions', p['resolutions']],
    ['pnpm.overrides', pnpm?.['overrides']],
  ];
  for (const [key, value] of overrides) {
    if (value !== undefined) out.set(key, JSON.stringify(value));
  }
  return out;
}

const CARGO_DEP_HEADER =
  /^\[(?:target\.[^\]]+\.)?(?:workspace\.)?(?:dev-|build-)?dependencies(?:\.[^\]]+)?\]$|^\[patch\.[^\]]+\]$|^\[replace\]$/;

/**
 * Strip a trailing `#` comment from a Cargo TOML line, respecting string
 * literals. The previous spelling applied a blind `\s+#.*$` regex that also
 * matched `#` inside a quoted string (e.g. `name = "feature #123"` became
 * `name = "feature`), collapsing two distinct dep values to identical map
 * keys and masking drift in `dependencyChange`. The string-aware scan
 * below only treats `#` as a comment when it sits at the start of the line
 * or after whitespace AND outside a `"…"` or `'…'` literal.
 */
function stripCargoComment(line: string): string {
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      // A quote preceded by `\` is escaped per the TOML spec — stay in the
      // string. Otherwise the quote closes the literal.
      if (ch === stringChar && line[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Every line inside a dependency-bearing TOML table, keyed by its table. */
function cargoDeps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let table: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripCargoComment(raw).trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      table = CARGO_DEP_HEADER.test(line) ? line : null;
      continue;
    }
    if (table) out.set(`${table} ${line.replace(/\s+/g, ' ')}`, '');
  }
  return out;
}

/** `require` / `replace` / `exclude` entries, single-line or in a block. */
function goDeps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (block) {
      if (line === ')') block = null;
      else out.set(`${block} ${line.replace(/\s+/g, ' ')}`, '');
      continue;
    }
    const m = /^(require|replace|exclude)\s*(\(|.+)$/.exec(line);
    if (!m) continue;
    if (m[2] === '(') block = m[1] ?? null;
    else out.set(`${m[1]} ${(m[2] ?? '').replace(/\s+/g, ' ')}`, '');
  }
  return out;
}

function depsOf(kind: ManifestKind, text: string): Map<string, string> | null {
  if (kind === 'npm') return npmDeps(text);
  if (kind === 'cargo') return cargoDeps(text);
  return goDeps(text);
}

/** Null when the dependencies are the same; otherwise a short summary of the change. */
export function dependencyChange(kind: ManifestKind, before: string, after: string): string | null {
  const a = depsOf(kind, before);
  const b = depsOf(kind, after);
  if (!a || !b) return null;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of b) {
    if (!a.has(key)) added.push(key);
    else if (a.get(key) !== value) changed.push(key);
  }
  for (const key of a.keys()) if (!b.has(key)) removed.push(key);
  const total = added.length + removed.length + changed.length;
  if (total === 0) return null;
  if (kind !== 'npm') return `${total} dependency line${total === 1 ? '' : 's'} changed`;
  const label = (key: string) => key.slice(key.indexOf(':') + 1);
  const parts = [
    ...added.map((k) => `+${label(k)}`),
    ...removed.map((k) => `-${label(k)}`),
    ...changed.map((k) => `~${label(k)}`),
  ];
  const shown = parts.slice(0, 6).join(', ');
  return parts.length > 6 ? `${shown}, +${parts.length - 6} more` : shown;
}

// ---------------------------------------------------------------------------
// HEAD inspection
// ---------------------------------------------------------------------------

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * The tracked lockfile governing `manifest`: the nearest one up the tree (a
 * workspace package's `package.json` is pinned by the root `pnpm-lock.yaml`).
 */
async function trackedLockfileFor(
  root: string,
  kind: ManifestKind,
  manifest: string,
  git: GitRunner,
): Promise<string | null> {
  let dir = dirOf(manifest);
  for (;;) {
    const candidates = LOCKFILES[kind].map((name) => (dir ? `${dir}/${name}` : name));
    const tracked = await git(root, ['ls-files', '-z', '--', ...candidates]);
    const first = tracked?.split('\0').find((p) => p.length > 0);
    if (first) return first;
    // go.sum lives beside its go.mod; a module has no ancestor lockfile.
    if (kind === 'go' || dir === '') return null;
    dir = dirOf(dir);
  }
}

/**
 * Manifests whose dependencies the HEAD commit changed without their tracked
 * lockfile. Null outside a repository or when HEAD cannot be judged (a root
 * commit, a merge).
 */
export async function findLockfileDrift(
  cwd: string,
  git: GitRunner = runGit,
): Promise<{ commit: string; findings: LockfileDrift[] } | null> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  if (!root) return null;
  const parents = (await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']))
    ?.trim()
    .split(/\s+/);
  // [commit, parent] — a root commit has no parent, a merge has several.
  if (parents?.length !== 2) return null;
  const [commit, parent] = parents as [string, string];
  const files = (
    await git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit])
  )
    ?.split('\0')
    .filter((p) => p.length > 0);
  if (!files) return null;
  const inCommit = new Set(files);
  const findings: LockfileDrift[] = [];
  for (const manifest of files) {
    const kind = MANIFESTS[manifest.slice(manifest.lastIndexOf('/') + 1)];
    if (!kind) continue;
    const after = await git(root, ['show', `${commit}:${manifest}`]);
    if (after === null) continue; // deleted
    const before = (await git(root, ['show', `${parent}:${manifest}`])) ?? '';
    const summary = dependencyChange(kind, before, after);
    if (!summary) continue;
    const lockfile = await trackedLockfileFor(root, kind, manifest, git);
    if (!lockfile || inCommit.has(lockfile)) continue;
    findings.push({ manifest, lockfile, summary });
  }
  return { commit, findings };
}

/** The note the model gets: what drifted and the command that refreshes it. */
export function lockfileDriftNote(commit: string, findings: readonly LockfileDrift[]): string {
  const lines = findings.map((f) => {
    const name = f.lockfile.slice(f.lockfile.lastIndexOf('/') + 1);
    const refresh = REFRESH_COMMAND[name] ?? 'the package manager install';
    return `  - ${f.manifest} (${f.summary}) is not matched by ${f.lockfile}: run \`${refresh}\` and commit ${f.lockfile}.`;
  });
  return [
    `dep-guard: commit ${commit.slice(0, 9)} changed dependencies without their lockfile. A locked install (CI) now fails or resolves differently:`,
    ...lines,
    'If the change needs no lockfile update, say why.',
  ].join('\n');
}

/**
 * The PostToolUse hook: after a successful commit (the `git` tool or `git
 * commit` in a shell), one note per commit when it left a lockfile behind.
 * Returns the unregister function.
 */
export function registerLockfileSync(
  api: Pick<PluginAPI, 'registerHook' | 'metrics'>,
  git: GitRunner = runGit,
): () => void {
  let lastJudged: string | null = null;
  return api.registerHook(
    'PostToolUse',
    'git|bash|exec|pwsh',
    (async (input: HookInput) => {
      if (input.toolResult?.isError) return;
      const shell =
        input.toolName === 'git'
          ? ''
          : shellCommandLinesFromInput(
              (input.toolInput ?? {}) as Record<string, unknown>,
            ).lines.join('\n');
      if (!isCommitCall(input.toolName, input.toolInput, shell)) return;
      const result = await findLockfileDrift(input.cwd, git);
      // A commit the hooks refused leaves HEAD where it was: judge each commit once.
      if (!result || result.commit === lastJudged) return;
      lastJudged = result.commit;
      if (result.findings.length === 0) return;
      api.metrics.counter('lockfile_drift_notes');
      return { additionalContext: lockfileDriftNote(result.commit, result.findings) };
    }) as never,
    { name: 'dep-guard:lockfile-sync' },
  );
}
