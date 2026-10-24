/**
 * Evaluate the danger level of a (cmd, args) pair.
 *
 * Returns 'safe' if no rule fires, otherwise the highest level among all
 * matching rules. The 'matchedRule' field is the *last* rule that fired
 * (stable, since rules are evaluated in declaration order).
 *
 * Optional `bypass` argument: a set of rule ids that should be SKIPPED
 * even if they would otherwise match. Wired from
 * `config.tools.exec.danger.bypass` (see `ExecDangerConfig` in
 * `packages/contracts/src/types/config.ts`). Unknown ids are silently
 * ignored — forward-compat: a rule added in a future version can be
 * referenced before the user upgrades their config schema.
 *
 * This function is the single source of truth for danger classification;
 * it is pure (no side effects) and unit-tested in `danger-detect.test.ts`.
 */
/**
 * Launchers that run another program, keyed by the options they consume.
 *
 * `exec` receives argv, so the launcher is the EXECUTABLE and the real command
 * is its first operand — and `env`, `nice`, `nohup` and `timeout` all ship in
 * the default exec allowlist. Every rule here keys on `cmd`, so
 * `exec nohup rm -rf /` read as the harmless `nohup` and assessed `safe`
 * (probe-verified 2026-09-22: 10 of 12 launcher-wrapped forms).
 *
 * `numericOperand` marks the launchers that also take a positional of their
 * own before the command (`timeout 5 rm …`).
 */
/**
 * GNU coreutils `timeout` DURATION.
 *
 * The `timeout` manual defines it as "a floating point number in either the
 * current or the C locale (see Floating point numbers) followed by an optional
 * unit" ('s' seconds, 'm' minutes, 'h' hours, 'd' days) — and the manual's
 * `Floating point` node states those numbers are parsed with `strtod`/`strtold`
 * and "therefore can use scientific notation like 1.0e-34 and -10e100", plus
 * hexadecimal floating point such as `-0x.ep-3`. So `1e3`, `2E4` and `0x1p3`
 * are all valid durations, not exotic typos.
 *
 * Matching only the integer spelling mis-parsed every other form, and a
 * mis-parsed operand does not merely fail to unwrap — it is taken FOR the
 * command, so the wrapped command disappears from the cmd-keyed rules.
 */
const TIMEOUT_DURATION =
  /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0[xX][0-9a-fA-F]*(?:\.[0-9a-fA-F]*)?[pP][-+]?\d+)[smhd]?$/;

// Exported for the parity guard at the bottom of this package's
// danger-detect.test.ts, which pins `valueFlags` against core's
// HALT_LAUNCHER_VALUE_FLAGS (security/yolo-risk.ts). The two tables are
// hand-copied mirrors; recorded as a test-only export in
// architecture/test-only-exports.json.
export const ARGV_LAUNCHERS: ReadonlyMap<
  string,
  {
    valueFlags: ReadonlySet<string>;
    numericOperand: boolean;
    /**
     * Flags whose VALUE is itself a command line the launcher splits and runs
     * (`env -S "cmd args"`). Left out, those words stay invisible to every
     * `cmd`-keyed rule and the launcher itself is classified instead.
     */
    splitStringFlags?: ReadonlySet<string> | undefined;
  }
> = new Map([
  ['nohup', { valueFlags: new Set<string>(), numericOperand: false }],
  ['setsid', { valueFlags: new Set<string>(), numericOperand: false }],
  ['unbuffer', { valueFlags: new Set<string>(), numericOperand: false }],
  ['command', { valueFlags: new Set<string>(), numericOperand: false }],
  ['exec', { valueFlags: new Set(['-a']), numericOperand: false }],
  [
    'env',
    {
      valueFlags: new Set(['-u', '-C', '--unset', '--chdir']),
      numericOperand: false,
      splitStringFlags: new Set(['-S', '--split-string']),
    },
  ],
  ['nice', { valueFlags: new Set(['-n', '--adjustment']), numericOperand: false }],
  ['ionice', { valueFlags: new Set(['-c', '-n', '-p']), numericOperand: false }],
  ['stdbuf', { valueFlags: new Set(['-i', '-o', '-e']), numericOperand: false }],
  [
    'timeout',
    { valueFlags: new Set(['-s', '-k', '--signal', '--kill-after']), numericOperand: true },
  ],
  [
    'sudo',
    {
      // sudo(8)'s value-taking options: user, group, close-from, prompt (the
      // -p prompt is the one a wrapper sets), host, role, type, chdir, chroot,
      // command-timeout, other-user. Every one is documented as taking a value,
      // so that value must never be mistaken for the command being run —
      // `sudo -p pw rm -rf x` read the prompt as the command and reported
      // 'caution' (the bare-`sudo` rule) instead of 'destructive'.
      //
      // Options with NO value are deliberately absent (-n, -b, -E, -H, -k, -A,
      // -S, -v): skipping a token for one of those would swallow the command
      // itself, which is strictly worse than leaving its name visible.
      valueFlags: new Set([
        '-u',
        '-g',
        '-C',
        '-p',
        '-h',
        '-r',
        '-t',
        '-D',
        '-R',
        '-T',
        '-U',
        '--user',
        '--group',
        '--close-from',
        '--prompt',
        '--host',
        '--role',
        '--type',
        '--chdir',
        '--chroot',
        '--command-timeout',
        '--other-user',
      ]),
      numericOperand: false,
    },
  ],
  [
    'doas',
    {
      // doas(1) (man.openbsd.org) is short-option-only. Its VALUE-taking options
      // are -a (authentication style), -C (config file) and -u (user); -n, -s and
      // -L take none, so they stay out of this list for the same reason sudo's
      // no-value options do — skipping a token for one would swallow the command
      // itself, which is strictly worse than leaving its name visible.
      valueFlags: new Set(['-u', '-C', '-a']),
      numericOperand: false,
    },
  ],
]);

/**
 * Words a launcher's split-string flag expands to, or undefined when the
 * leading flag prefix carries none.
 *
 * `env -S "<command line>"` passes a WHOLE command line as one argv token and
 * env splits it before exec'ing the words, so the generic scan inside
 * `unwrapArgvLaunchers` would stop at the flag and keep reporting `env` itself —
 * everything the launcher actually runs stays invisible. Every documented
 * spelling is expanded: `-S <cmd>`, `-S<cmd>`, `--split-string <cmd>` and
 * `--split-string=<cmd>`. Only the LEADING flag prefix is searched: a `-S` that
 * appears after the command name belongs to that command, not to the launcher.
 */
function expandSplitStringWords(
  args: readonly string[],
  splitFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): string[] | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // VAR=value
    if (token === '--') break;
    if (!token.startsWith('-') || token === '-') break; // the command itself
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    // `-Svalue`: GNU getopt lets a short option's value ride the same token, so
    // `env -S'rm -rf x'` arrives as a single argv entry.
    const glued = [...splitFlags].find(
      (flag) => flag.length === 2 && token.length > flag.length && token.startsWith(flag),
    );
    if (splitFlags.has(name) || glued !== undefined) {
      let inline: string | undefined;
      if (glued !== undefined) inline = token.slice(glued.length);
      else if (eq !== -1) inline = token.slice(eq + 1);
      const value = inline ?? args[i + 1];
      if (value === undefined) return undefined;
      const words = value.split(/\s+/).filter((word) => word.length > 0);
      if (words.length === 0) return undefined;
      // The separated spellings consume the value token as well.
      return [...words, ...args.slice(i + (inline === undefined ? 2 : 1))];
    }
    if (valueFlags.has(name) && eq === -1) i += 1;
  }
  return undefined;
}

/**
 * Peel transparent launchers off an argv pair so the rules see the real
 * command. Bounded at four hops; returns the input unchanged when the shape is
 * not understood, so an unrecognised launcher never silently drops arguments.
 */
export function unwrapArgvLaunchers(
  cmd: string,
  args: readonly string[],
): { cmd: string; args: readonly string[] } {
  let currentCmd = cmd;
  let currentArgs = args;
  for (let hops = 0; hops < 4; hops += 1) {
    const base = currentCmd
      .toLowerCase()
      .replace(/^.*[\\/]/, '')
      .replace(/\.(?:exe|cmd|bat|com)$/, '');
    const spec = ARGV_LAUNCHERS.get(base);
    if (!spec) break;
    // A flag whose VALUE is itself a command line (`env -S "rm -rf x"`): env
    // splits it and runs the words, so expand it before the generic scan.
    if (spec.splitStringFlags !== undefined) {
      const words = expandSplitStringWords(currentArgs, spec.splitStringFlags, spec.valueFlags);
      if (words !== undefined) {
        const command = words[0];
        if (command === undefined) break;
        currentCmd = command;
        currentArgs = words.slice(1);
        continue;
      }
    }
    let i = 0;
    while (i < currentArgs.length) {
      const token = currentArgs[i] ?? '';
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        i += 1;
        continue;
      }
      if (token === '--') {
        i += 1;
        break;
      }
      if (!token.startsWith('-') || token === '-') break;
      const name = token.split('=', 1)[0] ?? token;
      i += 1;
      if (spec.valueFlags.has(name) && !token.includes('=')) i += 1;
    }
    // `timeout`'s own positional. Accepting only the integer spelling left the
    // decimal forms unparsed, and an unparsed operand is taken FOR the command:
    // `timeout 0.5s rm -rf ./build` unwrapped to cmd `0.5s`, so the wrapped
    // `rm -rf` never reached the cmd-keyed rules and the same delete that
    // `timeout 5 rm -rf ./build` reports as 'destructive' reported 'safe'.
    // Over-accepting a malformed number is harmless — this token position is
    // definitionally the duration, so a skipped token can only be the duration.
    if (spec.numericOperand && TIMEOUT_DURATION.test(currentArgs[i] ?? '')) i += 1;
    const next = currentArgs[i];
    if (next === undefined) break;
    currentCmd = next;
    currentArgs = currentArgs.slice(i + 1);
  }
  return { cmd: currentCmd, args: currentArgs };
}
