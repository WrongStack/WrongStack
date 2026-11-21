// Per-command hard-blocks. Keep this list narrow: `exec` is already a
// confirm-gated tool with argv passed as an array and cwd confined to the
// project. These patterns should block clear sandbox escapes / destructive
// operations, not normal development workflows that happen to execute code.
const BLOCKED_ARG_PATTERNS: Record<string, RegExp[]> = {
  python: [],
  // git --exec=<cmd> runs arbitrary commands via upload-pack/receive-pack;
  // -C <dir> changes working directory, bypassing cwd sandbox;
  // -c/--config <k>=<v> injects config that runs commands
  // (e.g. core.sshCommand, core.pager, http.proxy, alias.x=!cmd).
  git: [
    /^--exec=/,
    /^--upload-pack=/,
    /^--receive-pack=/,
    /^-C/,
    /^-c/,
    /^--config$/,
    /^--config=/,
    /^--config-env=/,
  ],
  node: [],
  go: [],
  bun: [],
  docker: [],
  // find -exec/-ok/-execdir/-okdir execute arbitrary commands
  find: [
    /^-exec$/,
    /^-exec;$/,
    /^-ok$/,
    /^-ok;$/,
    /^-execdir$/,
    /^-execdir;$/,
    /^-okdir$/,
    /^-okdir;$/,
    /^-exec=/,
    /^-ok=/,
    /^-execdir=/,
    /^-okdir=/,
  ],
  // rm -rf / is catastrophic — block absolute paths, home, dot-dirs,
  // and glob patterns that could expand to dangerous targets.
  // `rm -rf ./src/*` expands to project files; `rm -rf ../../` escapes upward;
  // `rm -rf /*` targets the filesystem root. All are blocked.
  rm: [/^\//, /^[A-Za-z]:[\\/]/, /^~\//, /^~$/, /^\.$/, /^\.\.$/, /\*$/, /\/$/, /\/\*$/, /\.\//],
  // npm/pnpm subcommands are checked separately below. Matching every arg here
  // over-blocked normal dev flows such as `pnpm vitest run ...`.
  npm: [],
  pnpm: [],
  npx: [],
};

/**
 * Commands whose {@link BLOCKED_ARG_PATTERNS} entries match the PATH operands
 * they act on, so the operands after a `--` terminator must be checked too.
 */
const PATH_OPERAND_COMMANDS: ReadonlySet<string> = new Set(['rm']);

/**
 * Options blocked by NAME, independent of how the value is attached.
 *
 * `BLOCKED_ARG_PATTERNS` above is prefix-anchored on `--opt=`, but every
 * option parser this tool fronts also accepts `--opt value` as two argv
 * entries. `["push", "--exec", "./evil.sh"]` therefore walked straight past a
 * table whose whole purpose was to stop `--exec`. Matching the option NAME —
 * after splitting off any `=value` — closes both spellings with one entry.
 *
 * The git set is deliberately wider than the `=`-anchored table it supplements:
 *
 * - `--exec` / `--upload-pack` / `--receive-pack` run an arbitrary command via
 *   the transport layer. `_danger-detect.ts` (`git-exec`) already enumerated
 *   the bare forms, so the *advisory* layer warned about invocations the
 *   *blocking* layer let through. One table, both spellings, no drift.
 * - `--exec-path` makes git resolve non-builtin subcommands from a caller-named
 *   directory, so `git --exec-path=/tmp/x status` runs `/tmp/x/git-status`.
 * - `--git-dir` / `--work-tree` relocate the repository and working tree, which
 *   is the same cwd-sandbox escape `-C` is blocked for.
 */
const BLOCKED_OPTION_NAMES: Record<string, ReadonlySet<string>> = {
  git: new Set([
    '--exec',
    '--upload-pack',
    '--receive-pack',
    '--exec-path',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '-c',
    '--config',
    '--config-env',
    '-C',
  ]),
  find: new Set(['-exec', '-ok', '-execdir', '-okdir']),
};

/** `--opt=value` → `--opt`; everything else unchanged. */
function optionName(arg: string): string {
  const eq = arg.indexOf('=');
  return eq > 0 ? arg.slice(0, eq) : arg;
}

// Subcommand verbs only make sense in subcommand position. Keep externally
// destructive actions blocked there without rejecting harmless downstream args
// named "run", "publish", etc. passed to test runners or build tools.
const BLOCKED_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  docker: new Set(['push']),
  podman: new Set(['push']),
  npm: new Set(['publish', 'deploy']),
  pnpm: new Set(['publish']),
  yarn: new Set(['publish']),
};

const BLOCKED_SUBCOMMAND_SEQUENCES: Record<string, readonly (readonly string[])[]> = {
  yarn: [['npm', 'publish']],
};

/**
 * Positional args that may be the subcommand. A bare option (`--filter`, `-w`)
 * may take the NEXT argv entry as its value, so a positional right after one
 * could be that value and the real subcommand may follow: `pnpm --filter app
 * publish`, `npm -w pkg publish`, `docker --context prod push`. Taking only the
 * first positional let every such spelling past the gate. Without a per-tool
 * table of value-taking options, keep every positional up to and including
 * the first one that does NOT follow a bare option — that one is certainly the
 * subcommand. Fails closed: `pnpm --silent test publish` is also refused.
 */
function candidateSubcommandCount(positionalFollowsBareOption: boolean[]): number {
  const firstCertain = positionalFollowsBareOption.indexOf(false);
  return firstCertain === -1 ? positionalFollowsBareOption.length : firstCertain + 1;
}

/** Positional args before `--`, each flagged when it directly follows a bare option. */
function positionalArgs(args: string[]): { values: string[]; followsBareOption: boolean[] } {
  const values: string[] = [];
  const followsBareOption: boolean[] = [];
  let previousWasBareOption = false;
  for (const arg of args) {
    if (arg === '--') break;
    if (arg.startsWith('-')) {
      previousWasBareOption = !arg.includes('=');
      continue;
    }
    values.push(arg);
    followsBareOption.push(previousWasBareOption);
    previousWasBareOption = false;
  }
  return { values, followsBareOption };
}

export function validateArgs(
  cmd: string,
  args: string[],
  options: {
    allowPublish?: boolean | undefined;
    validatedGitArgumentIndexes?: ReadonlySet<number> | undefined;
  } = {},
): string | null {
  const positional = positionalArgs(args);
  const candidates = candidateSubcommandCount(positional.followsBareOption);

  const blockedSubcommands = BLOCKED_SUBCOMMANDS[cmd];
  if (blockedSubcommands && !options.allowPublish) {
    const subcommand = positional.values
      .slice(0, candidates)
      .find((value) => blockedSubcommands.has(value));
    if (subcommand) return `Blocked subcommand "${subcommand}" for command "${cmd}"`;
  }

  const blockedSequences = BLOCKED_SUBCOMMAND_SEQUENCES[cmd];
  if (blockedSequences && !options.allowPublish) {
    const actual = positional.values;
    for (let start = 0; start < candidates; start++) {
      const blocked = blockedSequences.find((seq) =>
        seq.every((part, idx) => actual[start + idx] === part),
      );
      if (blocked) return `Blocked subcommand "${blocked.join(' ')}" for command "${cmd}"`;
    }
  }

  // Name-based check first: it covers `--opt=value` and `--opt value` alike,
  // and reports the option rather than the spelling that happened to be used.
  const blockedOptions = BLOCKED_OPTION_NAMES[cmd];
  if (blockedOptions) {
    for (const [index, arg] of args.entries()) {
      // In `find`, `--` only terminates leading [-H|-L|-P] flags; primaries like
      // `-exec` / `-okdir` still execute after `--`.
      if (arg === '--' && cmd !== 'find') break;
      if (cmd === 'git' && options.validatedGitArgumentIndexes?.has(index)) continue;
      if (blockedOptions.has(optionName(arg))) {
        return `Blocked option "${optionName(arg)}" for command "${cmd}"`;
      }
    }
  }

  const blocked = BLOCKED_ARG_PATTERNS[cmd];
  if (!blocked) return null;

  for (const [index, arg] of args.entries()) {
    // After `--` git reads pathspecs, so an option-shaped operand is not an
    // option and the scan stops. `find` primaries still execute after `--`, and
    // `rm`'s patterns match the PATHS being deleted (`rm -rf -- /`).
    if (arg === '--' && cmd !== 'find' && !PATH_OPERAND_COMMANDS.has(cmd)) break;
    if (cmd === 'git' && options.validatedGitArgumentIndexes?.has(index)) continue;
    // The rm path patterns are written with `/`; Windows also separates with
    // `\`, so `..\outside`, `\\host\share` and `\Windows` walked past every
    // one of them. Test the slash-normalized spelling as well.
    const probe = cmd === 'rm' ? arg.replace(/\\/g, '/') : arg;
    for (const pattern of blocked) {
      if (pattern.test(arg) || pattern.test(probe)) {
        return `Blocked argument "${arg}" for command "${cmd}" (matches security pattern ${pattern})`;
      }
    }
  }
  return null;
}
