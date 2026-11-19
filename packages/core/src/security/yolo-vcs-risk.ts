import { commandName, commandSegment, SHELL_OPERATORS, tokenizeShell } from './yolo-shell-scan.js';

/** rsync options whose value may be the NEXT argv entry (`--exclude .git`). */
const RSYNC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-e',
  '--rsh',
  '-f',
  '--filter',
  '--exclude',
  '--include',
  '--exclude-from',
  '--include-from',
  '--files-from',
  '--chmod',
  '--chown',
  '-T',
  '--temp-dir',
  '--backup-dir',
  '--partial-dir',
  '--compare-dest',
  '--copy-dest',
  '--link-dest',
  '--log-file',
  '--password-file',
  '--rsync-path',
  '-M',
  '--remote-option',
  '--suffix',
  '--port',
  '--timeout',
  '--bwlimit',
  '--max-size',
  '--min-size',
  '--max-delete',
  '-B',
  '--block-size',
  '--out-format',
]);

/**
 * The destination of an rsync invocation: the last positional argument, once
 * the values of value-taking options are skipped — so a trailing
 * `--exclude .git` is not mistaken for the destination. `null` for a single
 * positional (rsync only LISTS the source then), `undefined` when none
 * survives (the caller fails closed).
 */
export function rsyncDestination(args: readonly string[]): string | null | undefined {
  const positionals: string[] = [];
  for (let j = 0; j < args.length; j++) {
    const arg = args[j]!;
    if (SHELL_OPERATORS.has(arg)) break;
    if (arg.startsWith('-')) {
      if (RSYNC_VALUE_OPTIONS.has(arg)) j++;
      continue;
    }
    positionals.push(arg);
  }
  if (positionals.length === 0) return undefined;
  return positionals.length === 1 ? null : positionals[positionals.length - 1];
}

/**
 * F8: git's parse-options accepts any UNAMBIGUOUS long-option prefix, so
 * `git reset --har` ≡ `--hard`, `git clean --forc` ≡ `--force`, etc. (verified
 * empirically per command in scratch repos). True when `arg` spells `--name`
 * or a prefix of it at least `minLen` characters long — `minLen` is the
 * shortest prefix that is unambiguous among THAT command's options (e.g.
 * push's --delete needs "de": "d" is ambiguous with --dry-run; switch's
 * --force has no accepted abbreviation at all because of --force-create, so
 * callers pass the full length to keep it exact). An attached `=value` is
 * ignored for the name match; over-matching value forms git would reject only
 * makes the gate stricter (fail-safe). Tokens arrive lowercased.
 */
function gitLongOption(arg: string, name: string, minLen: number): boolean {
  if (!arg.startsWith('--')) return false;
  const opt = arg.slice(2).split('=', 1)[0]!;
  return opt.length >= minLen && name.startsWith(opt);
}

export function hasGitHistoryRewrite(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if (commandName(tokens[i]) !== 'git') continue;
    const args = commandSegment(tokens, i + 1);
    // F8: reset's only h-option is --hard, so --h…--hard are all unambiguous
    // prefixes (the =value over-match is kept, fail-safe).
    if (args.includes('reset') && args.some((arg) => gitLongOption(arg, 'hard', 1))) {
      return true;
    }
    // Rewrites every commit in place. Pre-existing gap: the branch above only
    // covered `reset --hard`, so the one command that can destroy a repository's
    // whole history outright was auto-approved under YOLO.
    if (args.includes('filter-branch') || args.includes('filter-repo')) return true;
    if (discardsLocalWork(args)) return true;
    const cleanIdx = args.indexOf('clean');
    if (cleanIdx >= 0) {
      const cleanArgs = args.slice(cleanIdx + 1);
      // F8: clean's only f-option is --force, so --f…--force are unambiguous.
      if (
        cleanArgs.some(
          (arg) => arg === '-f' || gitLongOption(arg, 'force', 1) || /^-[a-z]*f[a-z]*$/i.test(arg),
        )
      ) {
        return true;
      }
    }
    const pushIdx = args.indexOf('push');
    if (pushIdx >= 0) {
      const pushArgs = args.slice(pushIdx + 1);
      if (
        pushArgs.some(
          (arg) =>
            arg === '-f' ||
            // F8: push's --force has NO accepted abbreviation (--f…--forc are
            // ambiguous with --force-with-lease/--force-if-includes), so it
            // stays exact; --force-w…--force-with-lease are unambiguous (the
            // helper also covers the =value spelling).
            arg === '--force' ||
            gitLongOption(arg, 'force-with-lease', 7) ||
            arg.startsWith('--force=') ||
            // Combined short-flag cluster (`-fv` ≡ `-f -v`): git combines
            // short flags, so an `f` anywhere in a single-dash all-letter
            // cluster is a verbatim force-push. Mirrors the cluster-aware
            // pattern the `git clean` branch above already uses. Deliberately
            // no dry-run (`-n`) carve-out: this layer flags `--dry-run -f`
            // as destructive too (documented asymmetry vs the tools-side rule).
            /^-[a-z]*f[a-z]*$/i.test(arg) ||
            // Per-refspec force (`git push origin +main`,
            // `+HEAD:refs/heads/main`): documented git shorthand equivalent
            // to `--force` for that ref. A `+` anywhere else in a refspec
            // (branch `feature+fix`) and a leading `^` exclusion refspec are
            // not force syntax.
            arg.startsWith('+') ||
            // Remote-ref destruction without a force flag: `--mirror` force-
            // updates every remote ref and deletes the ones missing locally
            // (git-push(1)); `--delete` / `-d` (also in a cluster), `--prune`
            // and a `:ref` deletion refspec remove remote branches.
            // F8: unambiguous prefixes — mirror: --m…; delete: --de… ("d" is
            // ambiguous with --dry-run); prune: --pru… ("p"/"pr" collide with
            // --porcelain/--progress/--push-option).
            gitLongOption(arg, 'mirror', 1) ||
            gitLongOption(arg, 'delete', 2) ||
            gitLongOption(arg, 'prune', 3) ||
            /^-[a-z]*d[a-z]*$/i.test(arg) ||
            (arg.startsWith(':') && arg.length > 1),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Git commands that irreversibly lose local work the way `reset --hard` and
 * `clean -f` do, keyed on the actual subcommand (global `-C dir` / `-c k=v`
 * skipped) so a commit message saying "checkout ." cannot match:
 *   - worktree discard: `checkout -- <paths>` / `checkout .` / `checkout -f`,
 *     `switch -f|--discard-changes`, `restore <paths>` (default --worktree;
 *     `--staged` alone only unstages and stays ungated);
 *   - `stash drop|clear`;
 *   - recovery-data destruction: `reflog expire|delete`,
 *     `gc --prune=now|all`, `prune` — after which not even the reflog can
 *     bring discarded commits back.
 * `args` is lowercased.
 */
function discardsLocalWork(args: readonly string[]): boolean {
  let i = 0;
  // Global options; `-c k=v` and `-C <dir>` (both `-c` once lowercased) take a value.
  while (i < args.length && args[i]!.startsWith('-')) {
    i += args[i] === '-c' ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  // F8: checkout's only f-option is --force (--f…--forc unambiguous, minLen 1);
  // switch also has --force-create, so EVERY --force abbreviation is ambiguous
  // there and git rejects it — switch passes the full length to stay exact.
  const forceFlag = (arg: string, minLen: number) =>
    gitLongOption(arg, 'force', minLen) || /^-[a-z]*f[a-z]*$/.test(arg);
  const pathspec = (arg: string) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg);
  switch (sub) {
    case 'checkout': {
      const dashDash = rest.indexOf('--');
      if (dashDash >= 0 && rest.slice(dashDash + 1).some(pathspec)) return true;
      return rest.some((arg) => forceFlag(arg, 1)) || rest.includes('.') || rest.includes(':/');
    }
    case 'switch':
      // F8: --di…--discard-changes are unambiguous ("d" collides with --detach).
      return (
        rest.some((arg) => gitLongOption(arg, 'discard-changes', 2)) ||
        rest.some((arg) => forceFlag(arg, 'force'.length))
      );
    case 'restore': {
      // Tokens are lowercased, so `-S` (--staged) and `-s <tree>` (--source)
      // collide: only the long `--staged` counts as unstage-only (fail closed).
      // F8: --w…--worktree are unambiguous; --sta…--staged are ("s"/"st"
      // collide with --source). Missing the --worktree abbreviation let
      // `restore --staged --wor <path>` take the unstage-only exemption while
      // git also restores (destroys) the worktree.
      const worktree = rest.some((arg) => gitLongOption(arg, 'worktree', 1)) || rest.includes('-w');
      if (rest.some((arg) => gitLongOption(arg, 'staged', 3)) && !worktree) return false;
      return rest.some(pathspec);
    }
    case 'stash': {
      const verb = rest.find((arg) => !arg.startsWith('-'));
      return verb === 'drop' || verb === 'clear';
    }
    case 'reflog':
      return rest.includes('expire') || rest.includes('delete');
    case 'gc':
      // F8: gc's only p-option is --prune, so --p…--prune are unambiguous.
      return rest.some((arg) => {
        if (!gitLongOption(arg, 'prune', 1) || !arg.includes('=')) return false;
        const value = arg.slice(arg.indexOf('=') + 1);
        return value === 'now' || value === 'all';
      });
    case 'prune':
      return true;
    default:
      return false;
  }
}

/** kubectl flags that take a value, so that value is never read as the resource. */
const KUBECTL_VALUE_FLAGS = new Set([
  '-n',
  '--namespace',
  '-f',
  '--filename',
  '-l',
  '--selector',
  '-o',
  '--output',
  '--context',
  '--cluster',
  '--user',
  '--kubeconfig',
  '--grace-period',
  '--timeout',
  '-k',
  '--kustomize',
]);

/** First positional after `kubectl delete` (lowercased tokens), or ''. */
function kubectlDeleteResource(after: readonly string[]): string {
  for (let i = 0; i < after.length; i++) {
    const arg = after[i]!;
    if (SHELL_OPERATORS.has(arg)) return '';
    if (arg.startsWith('-')) {
      if (KUBECTL_VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return '';
}

export function hasExternalPublish(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const cmd = commandName(tokens[i]);
    if (!cmd) continue;
    const args = commandSegment(tokens, i + 1);
    // pnpm's built-in deploy assembles a portable package in a local folder.
    // A user-defined `pnpm run deploy` remains an external-publish risk.
    const localPnpmDeploy =
      cmd === 'pnpm' && !args.some((arg) => ['run', 'run-script', 'exec', 'dlx'].includes(arg));
    if (
      ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) &&
      (args.includes('publish') || (args.includes('deploy') && !localPnpmDeploy))
    ) {
      return true;
    }
    if (cmd === 'cargo' && (args.includes('publish') || args.includes('yank'))) return true;
    // The one-command public publishes of the other ecosystems the exec
    // allowlist ships — each as irreversible as `npm publish`, and none was
    // recognised. Gradle's `publishToMavenLocal` stays local and is excluded.
    if (cmd === 'twine' && args.includes('upload')) return true;
    if (['poetry', 'uv', 'pdm', 'hatch', 'flit'].includes(cmd) && args.includes('publish')) {
      return true;
    }
    if (cmd === 'gem' && args.includes('push')) return true;
    if (cmd === 'nuget' && args.includes('push')) return true;
    if (cmd === 'dotnet' && args.includes('nuget') && args.includes('push')) return true;
    if (cmd === 'mvn' && args.includes('deploy')) return true;
    if (
      (cmd === 'gradle' || cmd === 'gradlew') &&
      args.some((arg) => arg.startsWith('publish') && arg !== 'publishtomavenlocal')
    ) {
      return true;
    }
    if ((cmd === 'dart' || cmd === 'flutter') && args.includes('pub') && args.includes('publish')) {
      return true;
    }
    if ((cmd === 'docker' || cmd === 'podman') && args.includes('push')) return true;
    if (cmd === 'kubectl') {
      const deleteIdx = args.indexOf('delete');
      // The resource is the first positional after `delete` (flags go anywhere),
      // in any documented spelling: plural, short, or the TYPE/NAME form.
      const resource = deleteIdx >= 0 ? kubectlDeleteResource(args.slice(deleteIdx + 1)) : '';
      if (/^(?:namespaces?|ns)(?:\/|$)/.test(resource)) return true;
      if (args.includes('drain')) return true;
      // Cluster-wide (`--all`, `-A` → `-a` once lowercased) or data-bearing
      // (persistent volumes) deletes are as irreversible as a namespace.
      if (
        deleteIdx >= 0 &&
        (args.includes('--all') ||
          args.includes('-a') ||
          args.includes('--all-namespaces') ||
          /^(?:pvc|pv|persistentvolumeclaims?|persistentvolumes?)(?:\/|$)/.test(resource))
      ) {
        return true;
      }
    }
    // Infrastructure teardown and recursive cloud-storage deletes: remote,
    // irreversible, and none was known. A plan (`terraform plan -destroy`) and
    // single-object deletes stay ungated.
    if (cmd === 'terraform' || cmd === 'tofu') {
      const sub = args.find((arg) => !arg.startsWith('-'));
      if (sub === 'destroy' || (sub === 'apply' && args.includes('-destroy'))) return true;
    }
    if (cmd === 'pulumi' && args.includes('destroy')) return true;
    if (cmd === 'aws' && args.includes('s3')) {
      if (args.includes('rm') && args.includes('--recursive')) return true;
      if (args.includes('rb') && args.includes('--force')) return true;
      if (args.includes('sync') && args.includes('--delete')) return true;
    }
    if (cmd === 'gsutil' && args.includes('rm') && args.includes('-r')) return true;
    if (
      cmd === 'gcloud' &&
      args.includes('storage') &&
      args.includes('rm') &&
      (args.includes('-r') || args.includes('--recursive'))
    ) {
      return true;
    }
    if (cmd === 'rclone' && args.includes('purge')) return true;
  }
  return false;
}
