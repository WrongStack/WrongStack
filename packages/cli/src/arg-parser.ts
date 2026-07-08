/**
 * Unified CLI argument parsing. Three parsers that were previously
 * spread across index.ts, subcommands/index.ts, and slash-commands/index.ts.
 */

/** Flags that are boolean-only (no value expected after them). */
export const BOOLEAN_FLAGS = new Set([
  'yolo',
  'yolo-destructive',
  'confirm-destructive',
  'force-all-yolo',
  'verbose',
  'trace',
  'help',
  'version',
  'no-banner',
  'no-features',
  'tui',
  'no-tui',
  'no-recovery',
  'recover',
  'output-json',
  'prompt',
  'metrics',
  'webui',
  'desktop',
  'open',
  'webui-require-token',
  'require-token',
  'no-check',
  'no-models-refresh',
  'director',
  'no-director',
  'no-autonomy',
  'autonomy',
  'eternal',
  'no-hints',
  'hints',
  'no-hooks',
  'skip',
  'skip-index',
  'mouse',
  'no-interactive',
  'token-saving-mode',
  'hq',
  'hq-allow-exec',
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
      const expand: Record<string, string> = { v: 'verbose' };
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
  const first = positional[0];
  if (first === 'webui' || first === 'desktop') {
    flags[first] = true;
    positional.splice(0, 1);
    return;
  }
  if (first === 'hq' && (positional.length === 1 || positional[1] === 'serve')) {
    flags['hq'] = true;
    positional.splice(0, positional[1] === 'serve' ? 2 : 1);
  }
}

// --------------------------------------------------------------- auth flags

export interface AuthFlags {
  positional: string[];
  label?: string | undefined;
  family?: import('@wrongstack/core').WireFamily | undefined;
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

export interface SpawnFlags {
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
    m = consume(/^--provider=(\S+)\s*/);
    if (m) opts.provider = m[1];
    else {
      m = consume(/^--model=(\S+)\s*/);
      if (m) opts.model = m[1];
      else {
        m = consume(/^--name=("([^"]+)"|(\S+))\s*/);
        if (m) opts.name = m[2] ?? m[3];
        else {
          m = consume(/^--tools=(\S+)\s*/);
          if (m)
            opts.tools = m[1]
              ?.split(',')
              .map((t) => t.trim())
              .filter(Boolean);
          else {
            m = consume(/^-p\s+(\S+)\s*/);
            if (m) opts.provider = m[1];
            else {
              m = consume(/^-m\s+(\S+)\s*/);
              if (m) opts.model = m[1];
              else {
                m = consume(/^-n\s+("([^"]+)"|(\S+))\s*/);
                if (m) opts.name = m[2] ?? m[3];
                else break;
              }
            }
          }
        }
      }
    }
  }
  return { description: rest.trim(), opts };
}
