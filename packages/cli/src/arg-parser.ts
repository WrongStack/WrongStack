/**
 * Unified CLI argument parsing. Three parsers that were previously
 * spread across index.ts, subcommands/index.ts, and slash-commands/index.ts.
 */

/** Flags that are boolean-only (no value expected after them). */
export const BOOLEAN_FLAGS = new Set([
  'yolo',
  'no-yolo',
  'yolo-destructive',
  'confirm-destructive',
  'force-all-yolo',
  'verbose',
  'trace',
  'help',
  'version',
  'yes',
  'no-banner',
  'no-features',
  'tui',
  'no-tui',
  // Recovery switches. `--recover` reopens the most recent session with no
  // trailing `session_end` (see wiring/resume-candidate.ts); `--no-recovery`
  // suppresses it, so a launch script that passes both still starts fresh.
  // Both are boolean so they cannot swallow the next positional token.
  'no-recovery',
  'recover',
  'output-json',
  'prompt',
  'metrics',
  'webui',
  'webui-session-child',
  'simpleui',
  'full-auto',
  'desktop',
  'open',
  'webui-require-token',
  'require-token',
  'no-check',
  'no-models-refresh',
  // (removed: 'director' and 'no-director' — Director Mode is always on)
  'no-autonomy',
  'no-hints',
  'hints',
  'no-menu',
  'no-hooks',
  'skip',
  'skip-index',
  'mouse',
  'no-interactive',
  'token-saving-mode',
  'system-lite',
  'system-pro',
  'hq',
  'hq-allow-exec',
  'tunnel',
  // Opt-in to a non-loopback HQ bind with no token/password configured.
  'insecure-open',
  'strict-port',
  'client',
  // `wstack doctor` booleans. Without these, `--daemons --clear-stale` parses
  // as `daemons="--clear-stale"` and the second flag disappears.
  'daemons',
  'clear-stale',
  // `wstack update` booleans. Keeping these here prevents parseArgs from
  // consuming a following positional token as an accidental flag value.
  'check-only',
  'allow-scripts',
  'lifecycle-scripts',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  // `wstack acp` booleans. Without these, parseArgs treats the value after
  // `--fs`/`--echo` as the flag's value and eats a following positional
  // (e.g. the agent list in `acp bench --fs gemini-cli,codex-cli`).
  'echo',
  'fs',
  // `wstack modeldiag test` booleans. Keep a following positional token from
  // being consumed as the value of one of these switches.
  'all-models',
  'plan',
  'json',
  // Destructive-preview switch (`wstack chronicle prune --dry-run`). It is
  // boolean at every call site, and leaving it out let it consume the next
  // positional — on a command whose whole purpose is to NOT delete.
  'dry-run',
  // Subcommand booleans. A boolean flag missing from this set makes `parseArgs`
  // swallow the FOLLOWING positional as its value (`rewind --all sess123` lost
  // the session id, `export --no-tools out.md` lost the output path), on top of
  // the handler never seeing the flag at all.
  'all',
  'list',
  'latest',
  'disabled',
  'enable',
  'no-tools',
  'no-diagnostics',
  'unsupported',
  'ws',
  'force',
  'no-browser',
  // `wstack auth local` booleans
  'no-key',
  'skip-key',
  'no-probe',
  'skip-probe',
  'probe-only',
  // `wstack models add` capability toggles
  'tools',
  'vision',
  'no-vision',
  'reasoning',
  'no-reasoning',
  'streaming',
  'no-streaming',
  'json-mode',
  'no-json-mode',
]);

// ------------------------------------------------------------------ main args

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

/** Parse top-level `wstack` CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      if (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('-')) {
        flags[name] = argv[++i] ?? '';
      } else {
        flags[name] = true;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const short = a.slice(1);
      const expand: Record<string, string> = { v: 'verbose', y: 'yes', h: 'help' };
      flags[expand[short] ?? short] = true;
    } else {
      positional.push(a);
    }
  }
  normalizeSurfaceAliases(flags, positional);
  return { flags, positional };
}

/**
 * Keep the user-facing launch shapes equivalent:
 *   wstack --webui      == wstack webui
 *   wstack --simpleui   == wstack simpleui
 *   wstack --desktop    == wstack desktop
 *   wstack --hq         == wstack hq / wstack hq serve
 *
 * HQ token management remains a real subcommand (`wstack hq token ...`), so
 * only the bare and explicit serve forms are normalized here.
 */
function normalizeSurfaceAliases(
  flags: Record<string, string | boolean>,
  positional: string[],
): void {
  // SimpleUI deliberately reuses the WebUI backend/runtime path. Keep its own
  // flag so dispatch can select the independent frontend build, while also
  // setting `webui` so every existing non-interactive surface guard applies.
  if (flags['simpleui']) flags['webui'] = true;
  if (flags['webui-session-child']) flags['webui'] = true;

  const first = positional[0];
  if (first === 'simpleui') {
    flags['simpleui'] = true;
    flags['webui'] = true;
    positional.splice(0, 1);
    return;
  }
  if (first === 'webui' || first === 'desktop') {
    flags[first] = true;
    positional.splice(0, 1);
    return;
  }
  // Only normalize the bare/serve forms. `wstack hq token …` stays a real
  // subcommand dispatch so the HQ handler sees its own args. And when
  // `--help`/`--version` is present, keep `hq` as a positional so the
  // help short-circuit can defer to the subcommand's focused help instead
  // of printing global help.
  if (
    first === 'hq' &&
    (positional.length === 1 || positional[1] === 'serve') &&
    flags['help'] !== true &&
    flags['version'] !== true
  ) {
    flags['hq'] = true;
    positional.splice(0, positional[1] === 'serve' ? 2 : 1);
  }
}

// --------------------------------------------------------------- auth flags

export interface AuthFlags {
  positional: string[];
  label?: string | undefined;
  family?: import('@wrongstack/core/types').WireFamily | undefined;
  baseUrl?: string | undefined;
  envVars?: string[] | undefined;
}

/** Parse `wstack auth <provider> [--label ...] [--family ...] [...]` flags. */
export function parseAuthFlags(args: string[]): AuthFlags {
  const out: AuthFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--label') {
      const v = args[++i];
      if (v) out.label = v;
    } else if (a === '--family') {
      const v = args[++i];
      if (v) out.family = v as AuthFlags['family'];
    } else if (a === '--base-url') {
      const v = args[++i];
      if (v) out.baseUrl = v;
    } else if (a === '--env') {
      const v = args[++i];
      if (v)
        out.envVars = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    } else if (a && !a.startsWith('--')) {
      out.positional.push(a);
    }
  }
  return out;
}

// -------------------------------------------------------------- spawn flags

interface SpawnFlags {
  description: string;
  opts: {
    provider?: string | undefined;
    model?: string | undefined;
    tools?: string[] | undefined;
    name?: string | undefined;
  };
}

/**
 * Parse `/spawn` flags from the args head. Supported:
 *   --provider=<id> / -p <id>   override the subagent's provider id
 *   --model=<id>    / -m <id>   override the subagent's model
 *   --name=<label>  / -n <label> display name
 *   --tools=a,b,c               restrict the subagent's tool slice
 *
 * Anything after the last flag is the task description.
 */
export function parseSpawnFlags(input: string): SpawnFlags {
  const opts: SpawnFlags['opts'] = {};
  let rest = input;
  const consume = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re);
    if (m) {
      rest = rest.slice(m[0].length).replace(/^\s+/, '');
      return m;
    }
    return null;
  };
  while (rest.length > 0) {
    let m: RegExpMatchArray | null;
    m = consume(/^(?:--provider|-p)[=\s]+(\S+)\s*/);
    if (m) opts.provider = m[1];
    else {
      m = consume(/^(?:--model|-m)[=\s]+(\S+)\s*/);
      if (m) opts.model = m[1];
      else {
        m = consume(/^(?:--name|-n)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
        if (m) opts.name = m[1] ?? m[2] ?? m[3];
        else {
          m = consume(/^(?:--tools|-t)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
          if (m) {
            const rawTools = m[1] ?? m[2] ?? m[3] ?? '';
            opts.tools = rawTools
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
          } else break;
        }
      }
    }
  }
  return { description: rest.trim(), opts };
}
