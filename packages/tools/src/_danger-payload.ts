/** Interpreters whose `-c` / `-e` / `-Command` operand is a command LINE. */
const INLINE_PAYLOAD_FLAGS = new Set([
  '-c',
  '-e',
  '-E',
  '--eval',
  '-eval',
  '-command',
  '--command',
  '-commandwithargs',
]);

const INLINE_PAYLOAD_HOSTS = new Set([
  'bash',
  'sh',
  'zsh',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'node',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'cmd',
]);

/**
 * cmd.exe's command-line switches. Host-keyed: `/c` is an ordinary path for
 * every other host, so it must not join the shared flag set.
 */
const CMD_PAYLOAD_FLAGS = new Set(['/c', '/k']);

/**
 * Hosts whose short options may be CLUSTERED: `bash -lc "<cmd>"`, `sh -ec`,
 * `zsh -xc` carry `-c` inside the cluster and the next argv entry is still the
 * command string. PowerShell and the script interpreters take no clusters.
 */
const CLUSTERED_FLAG_HOSTS = new Set(['bash', 'sh', 'zsh', 'ksh', 'fish']);

/** True when `flag` (lowercased) is a short-option cluster that includes `-c`. */
export function isClusteredCommandStringFlag(host: string, flag: string): boolean {
  return CLUSTERED_FLAG_HOSTS.has(host) && /^-[a-z]*c[a-z]*$/.test(flag.toLowerCase());
}

/** Shell/PowerShell operators that end one command in a line and start the next. */
const PAYLOAD_SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n']);

/**
 * Split a command line into the argv of each command it chains, keeping a
 * quoted run as one token. `cd /tmp && rm -rf x` is two commands; read as one,
 * `rm` was only an argument of `cd` and no cmd-keyed rule saw it.
 */
function splitPayload(payload: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  for (const token of payload.match(/"[^"]*"|'[^']*'|&&|\|\||[;|&\n]|[^\s;|&]+/g) ?? []) {
    if (PAYLOAD_SEPARATORS.has(token)) {
      if (current.length > 0) commands.push(current);
      current = [];
      continue;
    }
    current.push(token.replace(/^(['"])([\s\S]*)\1$/, '$2'));
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

/**
 * The (cmd, args) pairs hiding inside an inline interpreter payload, one per
 * chained command.
 *
 * A real invocation ships the payload as ONE argv string —
 * `powershell -Command "Remove-Item -Recurse -Force C:\Users\x"` arrives as
 * `['-Command', 'Remove-Item -Recurse -Force C:\Users\x']`. Every rule here
 * matches its flags per-ARG and anchored, so nothing in that single string
 * matched and the assessment came back `safe` (probe-verified 2026-09-22) — while
 * the artificially pre-split spelling the tests used was flagged. The core-side
 * permission gate joins cmd+args into a line and classified these correctly, so
 * the confirmation still happened; the banner that explains WHY did not.
 *
 * Returned as an extra pair rather than by rewriting the input, reusing the same
 * mechanism the launcher unwrapping already uses — so a rule keyed on the
 * interpreter itself (`inline-eval`, `pipe-to-shell`) keeps firing too.
 */
export function inlinePayloadPairs(
  cmd: string,
  args: readonly string[],
): Array<{ cmd: string; args: readonly string[] }> {
  const base = cmd
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(?:exe|cmd|bat|com)$/, '');
  if (!INLINE_PAYLOAD_HOSTS.has(base)) return [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]?.toLowerCase();
    if (
      flag === undefined ||
      !(base === 'cmd'
        ? CMD_PAYLOAD_FLAGS.has(flag)
        : INLINE_PAYLOAD_FLAGS.has(flag) || isClusteredCommandStringFlag(base, flag))
    ) {
      continue;
    }
    const payload = args[i + 1];
    // Only a payload that actually looks like a command LINE is worth
    // re-reading: a single bare token is already visible to every rule. It must
    // not END the scan, though — `-e` is node/perl/ruby/python's eval flag, but
    // for a shell it is errexit and takes no value at all, so
    // `bash -e -c "rm -rf build"` read `-c` as the operand of `-e`, found no
    // command line in it, and returned no pairs: no cmd-keyed rule ever saw
    // `rm` and the banner dropped from 'destructive' to 'caution'. Keep looking
    // for the flag that actually carries the line.
    if (payload === undefined || !/\s/.test(payload.trim())) continue;
    return splitPayload(payload).map(([head = '', ...rest]) => ({ cmd: head, args: rest }));
  }
  return [];
}
