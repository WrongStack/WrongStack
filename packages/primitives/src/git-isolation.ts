/**
 * The environment to run `git` with on a repository nobody has vouched for.
 *
 * A repository's own `.git/config` names programs git runs on ordinary
 * read commands: `core.fsmonitor` on status/diff, and the `clean`/`process`
 * command of any filter its `.gitattributes` assigns, whenever status, diff,
 * add or hash-object reads a working-tree file. An archive or a shared
 * directory can carry that config, so a status line refresh or an automatic
 * review would run it.
 *
 * The returned environment turns fsmonitor off and blanks (an empty command
 * is no filter) every filter command that comes from outside the user's own
 * system/global config; their git-lfs stays, or every LFS file reads as
 * modified. Overrides travel as `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`,
 * not `-c key=value`: `-c` splits at the first `=`, and a filter named `a=b`
 * slipped past `-c filter.a=b.clean=`. They are appended after any entries
 * the base environment already holds. Needs git 2.31+.
 *
 * Undefined when the config could not be listed: nothing is blanked then,
 * and the caller must not run git.
 */
import { execFile, spawnSync } from 'node:child_process';

export interface GitIsolationOptions {
  /** The environment git will run with; `GIT_CONFIG_*` entries are appended to its own. Default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  binary?: string | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_LISTING_BYTES = 1024 * 1024;
// Git permits Unicode line separators in filter names; JS dot needs dotAll to include them.
const FILTER_COMMAND_RE = /^filter\..*\.(?:clean|smudge|process)$/s;
/** The user's own config. Anything else (`local`, `worktree`, a file the repository includes) is the repository's. */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set(['system', 'global']);

function listingArgs(scoped: boolean): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    'config',
    ...(scoped ? ['--show-scope'] : []),
    '--null',
    '--name-only',
    '--get-regexp',
    '^filter[.]',
  ];
}

type Listing = { code: number | string | null; stdout: string };

/** Exit 1 is "no filter configured"; anything else but 0 is a failure. */
function isEmptyListing(listing: Listing): boolean {
  return listing.code === 1 && listing.stdout === '';
}

/** Filter command keys from a listing that does not come from a trusted scope. */
export function untrustedGitFilterKeys(stdout: string, scoped: boolean): string[] {
  const fields = stdout.split('\0');
  const keys = new Set<string>();
  for (let i = 0; i < fields.length; ) {
    const scope = scoped ? fields[i++] : undefined;
    const key = fields[i++];
    if (!key || !FILTER_COMMAND_RE.test(key)) continue;
    // Git before 2.26 has no `--show-scope`: every filter command is blanked.
    if (scope === undefined || !TRUSTED_SCOPES.has(scope)) keys.add(key);
  }
  return [...keys];
}

/** `GIT_CONFIG_*` entries for `entries`, after the ones `baseEnv` already holds. */
export function gitConfigEnv(
  entries: ReadonlyArray<readonly [key: string, value: string]>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (entries.length === 0) return {};
  const parsed = Number(baseEnv['GIT_CONFIG_COUNT'] ?? 0);
  let n = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  const env: Record<string, string> = {};
  for (const [key, value] of entries) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env['GIT_CONFIG_COUNT'] = String(n);
  return env;
}

function isolationEnv(keys: readonly string[], baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...gitConfigEnv(
      [['core.fsmonitor', 'false'], ...keys.map((key) => [key, ''] as const)],
      baseEnv,
    ),
    // A background `status` otherwise takes `.git/index.lock` to refresh the index, and the
    // user's own commit or checkout at that moment fails with "index.lock: File exists".
    // Only optional locks are skipped; writes still take theirs.
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function fromListings(
  scoped: Listing,
  unscoped: () => Listing | Promise<Listing>,
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> | undefined | Promise<Record<string, string> | undefined> {
  if (scoped.code === 0) return isolationEnv(untrustedGitFilterKeys(scoped.stdout, true), baseEnv);
  if (isEmptyListing(scoped)) return isolationEnv([], baseEnv);
  const finish = (listing: Listing) => {
    if (listing.code === 0)
      return isolationEnv(untrustedGitFilterKeys(listing.stdout, false), baseEnv);
    return isEmptyListing(listing) ? isolationEnv([], baseEnv) : undefined;
  };
  const next = unscoped();
  return next instanceof Promise ? next.then(finish) : finish(next);
}

function listAsync(cwd: string, scoped: boolean, opts: GitIsolationOptions): Promise<Listing> {
  return new Promise((resolve) => {
    execFile(
      opts.binary ?? 'git',
      listingArgs(scoped),
      {
        cwd,
        env: opts.baseEnv ?? process.env,
        maxBuffer: MAX_LISTING_BYTES,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        // A timeout or an overflow kills git: never a usable listing.
        const code = error ? ((error as { code?: number | string }).code ?? -1) : 0;
        const killed = !!error && (error as { killed?: boolean }).killed === true;
        resolve({ code: killed ? -1 : code, stdout: String(stdout) });
      },
    );
  });
}

function listSync(cwd: string, scoped: boolean, opts: GitIsolationOptions): Listing {
  const result = spawnSync(opts.binary ?? 'git', listingArgs(scoped), {
    cwd,
    env: opts.baseEnv ?? process.env,
    encoding: 'utf8',
    maxBuffer: MAX_LISTING_BYTES,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.signal) return { code: -1, stdout: '' };
  return { code: result.status, stdout: result.stdout ?? '' };
}

/** See the module comment. Merge the result over the environment git runs with. */
export async function gitIsolationEnv(
  cwd: string,
  opts: GitIsolationOptions = {},
): Promise<Record<string, string> | undefined> {
  const baseEnv = opts.baseEnv ?? process.env;
  return fromListings(await listAsync(cwd, true, opts), () => listAsync(cwd, false, opts), baseEnv);
}

/** {@link gitIsolationEnv} for synchronous callers. */
export function gitIsolationEnvSync(
  cwd: string,
  opts: GitIsolationOptions = {},
): Record<string, string> | undefined {
  const baseEnv = opts.baseEnv ?? process.env;
  return fromListings(listSync(cwd, true, opts), () => listSync(cwd, false, opts), baseEnv) as
    | Record<string, string>
    | undefined;
}
