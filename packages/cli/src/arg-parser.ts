/**
 * Unified CLI argument parsing. Three parsers that were previously
 * spread across index.ts, subcommands/index.ts, and slash-commands/index.ts.
 */

/** Flags that are boolean-only (no value expected after them). */
export const BOOLEAN_FLAGS = new Set([
  'yolo',
  'no-yolo',
  'yolo-plus',
  'yolo-destructive',
  'confirm-destructive',
  'force-all-yolo',
  'verbose',
  'trace',
  'help',
  'version',
  'yes',
  'no-banner',
  'tui',
  'no-tui',
  // Recovery switches. `--recover` reopens the most recent session with no
  // trailing `session_end` (see wiring/resume-candidate.ts); `--no-recovery`
  // suppresses it, so a launch script that passes both still starts fresh.
  // Both are boolean so they cannot swallow the next positional token.
  'no-recovery',
  'recover',
  // `--continue` / `-c`: resume the most recent session (same pick as a bare
  // `--resume`). Boolean so `wstack -c "next step"` keeps the prompt.
  'continue',
  // `--fork-session` (with --resume/--continue/--recover): branch instead of reopening.
  'fork-session',
  // `--strict-mcp-config`: start only the `--mcp-config` servers.
  'strict-mcp-config',
  // `--include-partial-messages`: add text_delta events to stream-json output.
  'include-partial-messages',
  // `--safe-mode`: start with plugins/hooks/MCP/skills/instruction overrides off.
  'safe-mode',
  // `--restricted`: no code-running/network tools, project-root lock, no YOLO.
  'restricted',
  // `--record` is read as `=== true`; as a value flag it swallowed the task
  // (`wstack --record "fix it"` recorded nothing and ran nothing).
  'record',
  // Same class: switches read only as `=== true` that would otherwise take the
  // next token (`--vector-sync "task"`, `typesafe lint-conventions --staged x`).
  'vector-sync',
  'allow-all',
  'no-llm',
  'staged',
  'sweep',
  'n',
  // `wstack import-claude-code` switches.
  'apply',
  'overwrite',
  'enable-project-servers',
  'output-json',
  'metrics',
  'webui',
  // Retired surface: SimpleUI was replaced by VibeUI. Kept boolean so
  // `--simpleui foo` never swallows `foo`; see normalizeSurfaceAliases.
  'simpleui',
  'vibeui',
  // Retired with SimpleUI; accepted and reported as ignored.
  'full-auto',
  'open',
  // `wstack remote --keep`: leave the remote host running after disconnecting.
  'keep',
  'webui-require-token',
  'require-token',
  'no-check',
  'no-models-refresh',
  // Keeps the profile's own system prompt instead of the CLI Quick default;
  // headless runs also keep the tool coach. `wstack bench run` reads it too.
  'host-profile',
  'no-tool-coach',
  // (removed: 'director' and 'no-director' — Director Mode is always on)
  'no-autonomy',
  'no-menu',
  'no-hooks',
  'skip',
  'skip-index',
  'mouse',
  'ascii',
  'no-interactive',
  'token-saving-mode',
  'system-lite',
  'system-pro',
  'system-scout',
  'system-quick',
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
  // `wstack hq service install` toggles.
  'no-auto-update',
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
  // `wstack modeldiag eval [role] --quick`: as a value flag it swallowed the
  // role (`eval --quick coder` ran a full all-category eval, not a quick one).
  'quick',
  // Destructive-preview switch (`wstack chronicle prune --dry-run`). It is
  // boolean at every call site, and leaving it out let it consume the next
  // positional — on a command whose whole purpose is to NOT delete.
  'dry-run',
  // `wstack tools serve --allow-remote-callbacks`: a switch, never a value.
  'allow-remote-callbacks',
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
        const name = a.slice(2, eq);
        const value = a.slice(eq + 1);
        // Every switch is read as `=== true`: `--restricted=true` stored the
        // string and started unrestricted, `sandbox --dry-run=true` ran for real.
        const bool = BOOLEAN_FLAGS.has(name) ? value.trim().toLowerCase() : '';
        flags[name] = bool === 'true' ? true : bool === 'false' ? false : value;
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
      const expand: Record<string, string> = {
        v: 'verbose',
        y: 'yes',
        h: 'help',
        c: 'continue',
        r: 'resume',
      };
      const name = expand[short] ?? short;
      // Mirror the long-flag rule above: a short flag that is not a known
      // boolean owns the following token as its value (e.g. `auth local
      // -m <spec>`, `export -f json`). Forcing every short flag boolean let
      // the value fall through to `positional`, where downstream handlers
      // misread it as a subcommand argument.
      if (!BOOLEAN_FLAGS.has(name) && i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('-')) {
        flags[name] = argv[++i] ?? '';
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  normalizeSurfaceAliases(flags, positional);
  // Claude Code spells these both ways; accept the camelCase forms too.
  for (const [camel, kebab] of [
    ['disallowedTools', 'disallowed-tools'],
    ['allowedTools', 'allowed-tools'],
  ] as const) {
    if (flags[camel] !== undefined && flags[kebab] === undefined) flags[kebab] = flags[camel];
    delete flags[camel];
  }
  return { flags, positional };
}

/**
 * Keep the user-facing launch shapes equivalent:
 *   wstack --webui      == wstack webui
 *   wstack --vibeui     == wstack vibeui
 *   wstack --hq         == wstack hq / wstack hq serve
 *
 * HQ token management remains a real subcommand (`wstack hq token ...`), so
 * only the bare and explicit serve forms are normalized here.
 */
function normalizeSurfaceAliases(
  flags: Record<string, string | boolean>,
  positional: string[],
): void {
  // SimpleUI was retired and replaced by VibeUI. Old launch shapes still work:
  // they open VibeUI and `simpleui-retired` lets dispatch tell the user why.
  if (positional[0] === 'simpleui') {
    positional[0] = 'vibeui';
    flags['simpleui-retired'] = true;
  }
  if (flags['simpleui']) {
    delete flags['simpleui'];
    flags['vibeui'] = true;
    flags['simpleui-retired'] = true;
  }
  // VibeUI deliberately reuses the WebUI backend/runtime path. Keep its own
  // flag so dispatch can select the independent frontend build, while also
  // setting `webui` so every existing non-interactive surface guard applies.
  if (flags['vibeui']) flags['webui'] = true;

  const first = positional[0];
  if (first === 'vibeui') {
    flags[first] = true;
    flags['webui'] = true;
    positional.splice(0, 1);
    return;
  }
  if (first === 'webui') {
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
  alias?: string | undefined;
  label?: string | undefined;
  family?: import('@wrongstack/contracts/types').WireFamily | undefined;
  baseUrl?: string | undefined;
  envVars?: string[] | undefined;
  /**
   * `--audit [target]` — `true` for a bare flag (stdout), otherwise the
   * target: `'stdout'`, `'stderr'`, or a file path. Consumed by
   * `resolveAuditSink` in `auth-menu/auth-menu-audit.ts`.
   */
  audit?: boolean | string | undefined;
}

/** Parse `wstack auth <provider> [--label ...] [--family ...] [...]` flags. */
export function parseAuthFlags(args: string[]): AuthFlags {
  const out: AuthFlags = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    let key = a;
    let inlineVal: string | undefined;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq !== -1) {
      key = a.slice(0, eq);
      inlineVal = a.slice(eq + 1);
    }
    if (key === '--alias') {
      const next = args[i + 1];
      const v =
        inlineVal !== undefined
          ? inlineVal
          : next !== undefined && !next.startsWith('-')
            ? args[++i]
            : '';
      out.alias = v ?? '';
    } else if (key === '--label') {
      const v = inlineVal !== undefined ? inlineVal : args[++i];
      if (v) out.label = v;
    } else if (key === '--family') {
      const v = inlineVal !== undefined ? inlineVal : args[++i];
      if (v) out.family = v as AuthFlags['family'];
    } else if (key === '--base-url') {
      const v = inlineVal !== undefined ? inlineVal : args[++i];
      if (v) out.baseUrl = v;
    } else if (key === '--env') {
      const v = inlineVal !== undefined ? inlineVal : args[++i];
      if (v)
        out.envVars = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    } else if (key === '--audit') {
      // `--audit [target]` — bare means stdout (the documented default); a
      // following non-flag token is the target: `stdout`, `stderr`, or a file
      // path. `resolveAuditSink` (auth-menu/auth-menu-audit.ts) maps it.
      const next = args[i + 1];
      if (inlineVal !== undefined) {
        // `--audit=<target>`; an empty target is ignored, like `--label=`.
        if (inlineVal) out.audit = inlineVal;
      } else if (next === undefined || next.startsWith('-')) {
        out.audit = true;
      } else {
        out.audit = args[++i] ?? '';
      }
    } else if (a.startsWith('-')) {
      // Unknown flag (e.g. `--model`, `-m`, `--name`, `--audit`). Mirror
      // parseArgs: unless it is a known boolean, it owns the next token as
      // its value — consume it so the value cannot leak into `positional`.
      // The `auth local` handler reads positional[1] as the preset name,
      // and a leaked `--model <spec>` value made runAuthLocal hard-fail
      // with `Unknown local server "<spec>"`.
      const name = a.replace(/^-+/, '').split('=')[0] ?? '';
      const isBoolean = name === '' || BOOLEAN_FLAGS.has(name);
      if (
        !isBoolean &&
        inlineVal === undefined &&
        i + 1 < args.length &&
        !(args[i + 1] ?? '').startsWith('-')
      ) {
        i++;
      }
    } else {
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
 * All four value flags accept quoted values (`--model="gpt-4o"`); the
 * surrounding quotes are stripped. Without this, a habitually quoted id
 * flows into multiAgentHost.spawn() with the quote characters embedded.
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
    m = consume(/^(?:--provider|-p)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
    if (m) opts.provider = m[1] ?? m[2] ?? m[3];
    else {
      m = consume(/^(?:--model|-m)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
      if (m) opts.model = m[1] ?? m[2] ?? m[3];
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
