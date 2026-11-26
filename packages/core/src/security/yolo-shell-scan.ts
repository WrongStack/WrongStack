export const SHELL_OPERATORS = new Set(['&&', '&', '||', '|', ';', '>', '>>', '<', '2>', '2>>']);

/**
 * Shell quote/escape state for a character-by-character scan.
 *
 * Both scanners in this module walk a command line and must agree on what a
 * shell treats as quoted, because a separator inside quotes is prose, not a
 * separator. The rules live here once: outside single quotes a backslash
 * escapes the NEXT character, and single quotes are literal (no escapes).
 * Without the escape rule a backslash-escaped quote flipped quote parity —
 * `echo \" ; shutdown now` runs `shutdown now` in every real shell, while the
 * classifier read the rest of the line as quoted prose and gated nothing.
 */
interface ShellScanState {
  quote: string | undefined;
  escaped: boolean;
  /** PowerShell/cmd reading: `\` is a literal character, never an escape. */
  literalBackslash?: boolean;
}

/**
 * Advance `state` over `ch`; true when `ch` is INERT (quoted or escaped) and
 * therefore must never be read as a separator.
 */
function advanceShellScan(state: ShellScanState, ch: string): boolean {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (state.quote === "'") {
    if (ch === "'") state.quote = undefined;
    return true;
  }
  if (ch === '\\' && !state.literalBackslash) {
    state.escaped = true;
    return true;
  }
  if (state.quote !== undefined) {
    if (ch === state.quote) state.quote = undefined;
    return true;
  }
  if (ch === '"' || ch === "'") {
    state.quote = ch;
    return true;
  }
  return false;
}

/**
 * Put whitespace around every UNQUOTED command separator.
 *
 * `\S+` tokenization keeps a separator glued to the previous word inside that
 * word (`echo hi;rm -rf ~/data` becomes the single token `hi;rm`), so every
 * rule that finds a command by EXACT token match (`token === 'rm'`,
 * `tokens[i] !== 'git'`, the `del`/`erase`/`rd` branches, the agent-state
 * writers, the publish verbs) never saw the command that followed — while the
 * identical line with a space before the separator was gated. A shell reads
 * `;`, `&` and `|` as separators whatever the surrounding whitespace, and this
 * module's own `splitShellSegments` already reads them that way; the tokens
 * have to agree. Runs stay together so `&&` / `||` remain single tokens for
 * `commandSegment`'s `SHELL_OPERATORS` check.
 *
 * Redirection characters are deliberately NOT spaced out: `>`, `>>` and `2>`
 * are already operators, and splitting `2>&1` would reshape tokens for no
 * detection gain (glued redirect targets are scanned against the raw string).
 */
function spaceOutUnquotedSeparators(command: string): string {
  const separators = ';&|';
  let out = '';
  // PowerShell and cmd read `\` literally, so `"C:\dir\";next` closes its
  // string where a POSIX shell would not. Track both readings and treat a
  // separator as live when EITHER sees it unquoted: wrongly splitting a POSIX
  // string only adds tokens (stricter gates); missing a live one hides a command.
  const state: ShellScanState = { quote: undefined, escaped: false };
  const literal: ShellScanState = { quote: undefined, escaped: false, literalBackslash: true };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) continue;
    const posixInert = advanceShellScan(state, ch);
    const literalInert = advanceShellScan(literal, ch);
    if ((posixInert && literalInert) || !separators.includes(ch)) {
      out += ch;
      continue;
    }
    let run = ch;
    let next = command[i + 1];
    while (next !== undefined && separators.includes(next)) {
      advanceShellScan(state, next);
      advanceShellScan(literal, next);
      run += next;
      i += 1;
      next = command[i + 1];
    }
    out += ` ${run} `;
  }
  return out;
}

/**
 * Commands whose flag takes a COMMAND LINE as its value.
 *
 * Every rule in this module finds a command by EXACT token equality, so a value
 * that is itself a command line (`env -S "rm -rf ~/data"`, `sh -c "git push
 * --force"`) left the wrapped command invisible in ONE token — while the same
 * line written directly was gated. Keyed PER COMMAND because the letters are
 * overloaded: `-c` is also `grep -c` / `tar -c`, and `/c` is a path separator
 * everywhere else. Values are stored lowercased; argument matching compares
 * lowercased, which is right for PowerShell and cmd (/c and -Command are
 * case-insensitive there) and merely fail-safe for the POSIX shells.
 *
 * Exported for the split-string parity guard in
 * packages/tools/tests/danger-detect.test.ts, which pins this table against
 * `ARGV_LAUNCHERS`' `splitStringFlags` on the tools side. The comparison there
 * lowercases, because this map stores flags lowercased while tools keeps the
 * documented spelling (`-S`). Recorded as a test-only export in
 * architecture/test-only-exports.json.
 */
export const COMMAND_STRING_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['env', ['-s', '--split-string']],
  ['sh', ['-c']],
  ['bash', ['-c']],
  ['zsh', ['-c']],
  ['dash', ['-c']],
  ['ksh', ['-c']],
  ['ash', ['-c']],
  ['fish', ['-c']],
  ['pwsh', ['-command', '-c']],
  ['powershell', ['-command', '-c']],
  ['cmd', ['/c', '/k']],
]);

/** Launchers in {@link COMMAND_STRING_FLAGS} that group short options (`-lc`). */
export const POSIX_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'fish',
]);

/** Bound on nested command-string values (`sh -c "env -S 'x'"`). */
const MAX_COMMAND_STRING_DEPTH = 4;

/**
 * Command name without a directory or executable extension, lowercased. The
 * Windows package managers and build wrappers are `.cmd`/`.bat`/`.ps1` shims
 * (`npm.cmd`, `gradlew.bat`, `npm.ps1`) that every Windows shell runs by that
 * full name, so stripping only `.exe` left `npm.cmd publish` unclassified.
 */
function normalizeCommandToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}

/**
 * A token read as a command name: {@link normalizeCommandToken}, which also
 * drops the `\` of an alias-escaped `\rm`. Detectors compare this, never the
 * raw token, so `/bin/rm -rf x` is gated exactly like `rm -rf x`.
 */
export function commandName(token: string | undefined): string {
  return token ? normalizeCommandToken(token) : '';
}

/**
 * Quote-aware whitespace split, before any command-string expansion.
 *
 * Kept separate from {@link tokenizeShell} so the expansion can recurse into a
 * value it has already split without re-entering itself unbounded.
 */
function flatShellTokens(command: string): string[] {
  return (
    spaceOutUnquotedSeparators(command)
      .match(/"[^"]*"|'[^']*'|\S+/g)
      ?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
  );
}

/**
 * Splice the words of each command-string flag's value into the token stream.
 *
 * `env -S "<cmd>"`, `sh -c "<cmd>"`, `cmd /c "<cmd>"` and PowerShell's
 * `-Command` all pass a WHOLE command line as one argv token that the launcher
 * then splits and runs. Left as one token, no `cmd`-keyed rule could see it:
 * `env -S 'rm -rf ~/data'` assessed as not destructive while the identical
 * `env rm -rf ~/data` returned 'delete-outside'. The value is therefore
 * tokenized as the command line it is, behind a `;` boundary that
 * `commandSegment` already stops at, so the spliced words cannot leak into the
 * outer command's arguments.
 */
function expandCommandStrings(tokens: readonly string[], depth: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    out.push(token);
    const flags = COMMAND_STRING_FLAGS.get(normalizeCommandToken(token));
    if (flags === undefined) continue;
    const found = findCommandStringFlag(tokens, i, flags);
    if (found === undefined) continue;
    const flagToken = tokens[found.index] ?? '';
    const lower = flagToken.toLowerCase();
    const flag = found.flag;
    let value: string | undefined;
    if (lower.length > flag.length) {
      // `-c<cmd>` / `--split-string=<cmd>`: the value rides the flag token.
      value = flagToken.slice(flag.length + (flagToken.charAt(flag.length) === '=' ? 1 : 0));
    } else {
      value = tokens[found.index + 1];
    }
    if (value === undefined || value.length === 0) continue;
    // Options that sit between the launcher and its flag (`bash -x -c`) stay in
    // the stream, then the payload is spliced behind the `;` boundary.
    for (let k = i + 1; k <= found.index; k += 1) out.push(tokens[k] ?? '');
    out.push(';');
    const inner = flatShellTokens(value);
    // Past the bound the words still become visible; only deeper nesting stops.
    out.push(
      ...(depth + 1 >= MAX_COMMAND_STRING_DEPTH ? inner : expandCommandStrings(inner, depth + 1)),
    );
    // Resume past the flag (value rode on it) or past flag + value, exactly as
    // the previous adjacent-only form did.
    i = lower.length > flag.length ? found.index : found.index + 1;
  }
  return out;
}

/**
 * Locate the command-string flag in a launcher's option run.
 *
 * Shells parse options left to right until the first non-option argument, so
 * the flag is not always the token IMMEDIATELY after the launcher:
 * `bash -x -c 'rm -rf ~/data'`, `bash --norc -c '…'`, `pwsh -NoProfile -Command
 * '…'` and `cmd /d /c "…"` hand the payload to the launcher exactly like the
 * adjacent spellings. Reading only tokens[i+1] abandoned the launcher on the
 * first other option, left the payload ONE opaque token, and hid it from every
 * token-exact rule — `rm -rf ~/data` was then classified by the coarse
 * inline-payload substring heuristic (wrong kind: 'bulk-delete') or not at all
 * (`pwsh -NoProfile -Command`, `cmd /d /c`: unclassified, YOLO never asked).
 *
 * The scan stops at a shell operator: the payload belongs to this segment, and
 * `bash -c ; rm x` has no command string before the `;`. It does NOT stop at
 * plain words — bash's own option/value grammar (`--rcfile f`, `-O autocd`)
 * would need a per-launcher option-value table, which this module deliberately
 * does not grow (see the calibration note in yolo-payload-risk.ts). The
 * tolerance this buys is fail-closed: a launcher whose POSITIONAL arguments
 * literally spell the flag and a gated payload (`bash script.sh -c 'rm -rf
 * ~/data'`, where a real shell would hand the string to the script) is gated
 * without being executed as a command string. Adjacent-flag behavior is
 * unchanged: the scan returns `launcherIndex + 1` first whenever the adjacent
 * token matches, which is the only position the previous form ever read.
 */
function findCommandStringFlag(
  tokens: readonly string[],
  launcherIndex: number,
  flags: readonly string[],
): { index: number; flag: string } | undefined {
  const posix = POSIX_SHELLS.has(normalizeCommandToken(tokens[launcherIndex] ?? ''));
  for (let j = launcherIndex + 1; j < tokens.length; j += 1) {
    const candidate = tokens[j];
    if (candidate === undefined || SHELL_OPERATORS.has(candidate)) break;
    const lower = candidate.toLowerCase();
    // POSIX shells take options as a cluster: `bash -lc "<cmd>"`, `sh -ec`,
    // `zsh -xc` carry -c inside the cluster and the NEXT word is the command
    // string — never a glued value.
    if (posix && /^-[a-z]*c[a-z]*$/.test(lower)) return { index: j, flag: lower };
    const flag = flags.find((entry) => lower === entry || lower.startsWith(entry));
    if (flag !== undefined) return { index: j, flag };
  }
  return undefined;
}

export function tokenizeShell(command: string): string[] {
  return expandCommandStrings(flatShellTokens(command), 0);
}

export function commandSegment(tokens: string[], start: number): string[] {
  const out: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || SHELL_OPERATORS.has(token)) break;
    out.push(token);
  }
  return out;
}

/**
 * Every flag letter visible in `args`, presence-only: short clusters
 * (`-rf` → r,f — lowercased so GNU `-R` counts as recursive) plus the GNU
 * long forms (`--recursive` → r, `--force` → f). A mixed invocation
 * (`rm -r --force x`) must classify identically to either pure form — the
 * same shape-variance contract the tools-side danger rules enforce.
 */
export function flagLetters(args: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const arg of args) {
    if (/^-[a-zA-Z]+$/.test(arg)) {
      for (const ch of arg.replace(/^-+/, '')) seen.add(ch.toLowerCase());
    } else if (/^--r(?:e(?:c(?:u(?:r(?:s(?:i(?:v(?:e)?)?)?)?)?)?)?)?$/.test(arg)) {
      // F6: GNU getopt_long accepts any unambiguous long-option prefix, so
      // `rm --rec --force ~/data` deletes exactly like `rm --recursive --force
      // ~/data`. Matching only the exact `--recursive` let the abbreviated
      // spellings evade the recursive-force gate (the PowerShell Remove-Item
      // branch already binds parameter prefixes). --r…--recursive are all the
      // unambiguous prefixes of rm's --recursive; over-matching only makes the
      // destructive gate stricter, which is the fail-safe direction.
      seen.add('r');
    } else if (/^--f(?:o(?:r(?:c(?:e)?)?)?)?$/.test(arg)) {
      // F6: --f…--force, the unambiguous prefixes of rm's --force (see above).
      seen.add('f');
    }
  }
  return seen;
}

/**
 * Split a command line into shell segments, ignoring separators inside quotes
 * and separators that a backslash escapes.
 *
 * Quote-awareness is the whole point: `git commit -m "…; shutdown now"` must
 * stay ONE segment whose head is `git`. The classifier has to read the command
 * being run, never the prose it carries as an argument. Escapes belong to the
 * same question — `echo \" ; shutdown now` runs `shutdown now` in every real
 * shell, and reading that `\"` as an opener kept the segment as one quoted
 * blob, so the halt was never seen.
 *
 * `|` splits here even though `curl … | sh` is a real risk shape — that shape
 * is matched against the WHOLE command by HIGH_IMPACT_PATTERNS[0], which never
 * goes through this splitter.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  const state: ShellScanState = { quote: undefined, escaped: false };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const inert = advanceShellScan(state, ch);
    if (!inert && (ch === ';' || ch === '\n' || ch === '&' || ch === '|')) {
      if (command[i + 1] === ch) i++; // consume the second half of && / ||
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim().length > 0);
}
