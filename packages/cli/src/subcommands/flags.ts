/**
 * Re-attach the flags `parseArgs` stripped before a subcommand handler ran.
 *
 * The dispatcher (`boot.ts`) hands a handler only `positional.slice(1)`, while
 * `parseArgs` has already pulled every `--flag` into `flags`. A handler that
 * parses its own `args` therefore saw NONE of the flags it documents:
 * `rewind --last 2` printed usage, `export --format json --out r.json` dumped
 * markdown to stdout, `plugin add X --disabled` wrote it enabled, and
 * `chronicle prune --days 7 --dry-run` performed a real 30-day purge.
 *
 * Re-injecting every flag at the dispatcher would be wrong: top-level switches
 * (`--verbose`, `--yolo`, `--tui`) would land in the subcommand's argv too, and
 * handlers with an "Unknown flag" branch — `export.ts` has one — would start
 * rejecting valid invocations. So each handler declares the flags it owns and
 * gets back exactly those.
 *
 * A spelling already present in `args` always wins: a directly-invoked handler
 * (and anything the caller placed after `--`) keeps overriding.
 */
export function restoreFlags(
  args: string[],
  deps: { flags?: Record<string, string | boolean> | undefined },
  names: readonly string[],
): string[] {
  const flags = deps.flags;
  if (!flags) return args;

  const alreadyPresent = new Set(
    args
      .filter((a) => a.startsWith('-'))
      .map((a) => a.replace(/^-+/, '').split('=')[0])
      .filter((a): a is string => a !== undefined && a.length > 0),
  );

  const restored: string[] = [];
  for (const name of names) {
    if (alreadyPresent.has(name)) continue;
    const value = flags[name];
    if (value === undefined || value === false) continue;
    // `parseArgs` normalises `-x` to a single-character key; emit it back in
    // the spelling the handler's own parser recognises.
    const token = name.length === 1 ? `-${name}` : `--${name}`;
    if (value === true) restored.push(token);
    else restored.push(token, value);
  }

  return restored.length > 0 ? [...args, ...restored] : args;
}
