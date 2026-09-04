/**
 * Build a sanitized child-process environment.
 *
 * The bash/exec tools and MCP stdio transports execute LLM-generated or
 * configured commands. The parent process carries provider API keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), VCS tokens (GITHUB_TOKEN),
 * and cloud credentials. Forwarding those to a child is an exfiltration
 * vector even with `permission: 'confirm'` — a compromised MCP server
 * or a cleverly composed shell pipeline can leak secrets.
 *
 * Strategy: copy a small, explicit allowlist of variables that real builds
 * need, then copy anything else that does NOT look secret-bearing. This
 * preserves user-friendly behavior (locale, terminal, npm config) while
 * blocking the obvious leak channels. Two value-side guards back up the
 * name-based filter:
 *   - any value carrying an embedded URI credential (`scheme://user:pass@host`,
 *     e.g. `DATABASE_URL`/`REDIS_URL`/`*_DSN`) is dropped (WS-01);
 *   - `NODE_OPTIONS` is forwarded but with module-preload directives
 *     (`--require`/`--import`/`--loader`) stripped so a parent-set value can't
 *     inject code into node children (WS-02).
 *
 * Override with `WRONGSTACK_CHILD_ENV_PASSTHROUGH=1` to forward the full
 * parent environment unchanged (opt-in for advanced users who understand
 * the risk).
 */

const ALLOWED_KEYS = new Set<string>([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'OLDPWD',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PUBLIC',
  'PATHEXT',
]);

// Substring match against env-var names (case-insensitive). Bias toward
// false-positives — a missing var is recoverable, an exfiltrated key is not.
// Only consulted for vars NOT on the curated allowlist; PWD/PASSWD-style
// false positives there are avoided by checking allowlist first.
const SECRET_NAME_PARTS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  // WRONGSTACK_VAULT_PASSPHRASE is the vault KEK. Without this entry it matched
  // no rule here and fell through to the `WRONGSTACK_` prefix allow-rule, so the
  // key that protects the credential vault was forwarded to every child process
  // — including the agent's own exec/bash tools and MCP stdio servers (WS-033).
  'PASSPHRASE',
  'AUTH',
  'CRED',
  'BEARER',
  'COOKIE',
  'PRIVATE',
];

function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  for (const p of SECRET_NAME_PARTS) {
    if (upper.includes(p)) return true;
  }
  // KEY is tricky — PUBLIC_KEY is fine to forward but most _KEY vars are
  // secrets. Require word boundary so KEYBOARD_LAYOUT etc. are not flagged.
  if (/(?:^|_)KEY(?:$|_|S$)/i.test(upper)) return true;
  if (/API[_-]?KEY/i.test(upper)) return true;
  if (/ACCESS[_-]?KEY/i.test(upper)) return true;
  if (/SESSION[_-]?ID/i.test(upper) === false && /SESSION/i.test(upper)) {
    // SESSION_ID is metadata (we set our own); other SESSION_* often holds
    // session cookies. Be conservative.
    return true;
  }
  return false;
}

/**
 * Value-side secret detection (WS-01). The name-based `looksSecret` filter
 * misses connection-string variables whose NAME is innocuous but whose VALUE
 * embeds a password — e.g. `DATABASE_URL=postgres://user:pass@host`,
 * `REDIS_URL=redis://:pass@host`, `MONGO_URI`, `AMQP_URL`, `*_DSN`. Forwarding
 * these to a child (bash/exec/MCP server) leaks the embedded credential.
 *
 * Matches a URI userinfo component that contains a password, i.e.
 * `scheme://[user]:<password>@host`. Deliberately precise: a credential-free
 * URL (`https://api.example.com`, `https://user@host` with no password) is NOT
 * matched, so non-secret `*_URL` knobs (registries, endpoints) still forward.
 */
function valueHasEmbeddedCredential(value: string): boolean {
  // scheme:// then optional user, a ':' , a non-empty password, then '@'.
  // Userinfo chars stop at '/', whitespace, ':' (separator) and '@'.
  return /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i.test(value);
}

/**
 * Code-injection directives that turn `NODE_OPTIONS` into an RCE channel by
 * preloading an arbitrary module into every node child process (WS-02).
 */
const NODE_OPTIONS_INJECTION_FLAG = /^(?:--require|-r|--import|--loader|--experimental-loader)$/;
const NODE_OPTIONS_INJECTION_FLAG_EQ = /^(?:--require|-r|--import|--loader|--experimental-loader)=/;

/**
 * Strip module-preload directives from a `NODE_OPTIONS` value while preserving
 * benign flags (`--no-warnings`, `--max-old-space-size=…`, etc.). Handles both
 * the `--require=./x.js` and space-separated `--require ./x.js` forms. Returns
 * the sanitized string (possibly empty).
 */
export function sanitizeNodeOptions(value: string): string {
  const tokens = value.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (NODE_OPTIONS_INJECTION_FLAG_EQ.test(tok)) continue; // --require=./x
    if (NODE_OPTIONS_INJECTION_FLAG.test(tok)) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) {
        i++; // also drop the following path token (--require ./x)
      }
      continue;
    }
    kept.push(tok);
  }
  return kept.join(' ');
}

export interface BuildChildEnvOptions {
  /** Session ID to inject as WRONGSTACK_SESSION_ID. */
  sessionId?: string | undefined;
  /** Additional env vars to merge (takes priority over filtered parent env). */
  extra?: NodeJS.ProcessEnv | undefined;
}

/**
 * Commit identity applied to every git-touching child process via the
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars. Env-var identity outranks
 * every `git config` layer (repo/global/system), so commits made by any
 * tool (git tool, bash/exec, worktree manager, plugins) carry this
 * name/email without touching the user's git config — hand-made commits
 * in a normal terminal are unaffected.
 */
export interface GitIdentity {
  name?: string | undefined;
  email?: string | undefined;
}

let gitIdentity: GitIdentity | null = null;

/**
 * Set (or clear with `null`) the git commit identity injected by
 * `buildChildEnv()`. Wired at boot from the user-level `config.git.identity`
 * (the config loader strips `git` from repo-committed in-project configs —
 * identity spoofing must not be repo-controllable) and re-applied at runtime
 * by the `/gitid` slash command.
 */
export function configureChildEnvGitIdentity(identity: GitIdentity | null | undefined): void {
  const name = identity?.name?.trim();
  const email = identity?.email?.trim();
  gitIdentity = name || email ? { name: name || undefined, email: email || undefined } : null;
}

/** Current configured git identity, or null when none is set. */
export function getChildEnvGitIdentity(): Readonly<GitIdentity> | null {
  return gitIdentity;
}

/**
 * Build a filtered child-process environment suitable for bash, exec, and
 * MCP server subprocesses. Strips API keys, tokens, and other credentials
 * while preserving system/tooling variables.
 */
export function buildChildEnv(optsOrSessionId?: BuildChildEnvOptions | string): NodeJS.ProcessEnv {
  const opts: BuildChildEnvOptions =
    typeof optsOrSessionId === 'string' ? { sessionId: optsOrSessionId } : (optsOrSessionId ?? {});

  // WRONGSTACK_CHILD_ENV_PASSTHROUGH may NOT be set via config file.
  // It is a privileged override that opt-outs the entire credential filter
  // and must only be set by the operator's shell environment (real env var,
  // not something a config file injects into process.env). Config-file
  // sources do NOT go through process.env — only the actual shell environment
  // does — so checking Object.prototype.hasOwnProperty.call(process.env, ...)
  // is sufficient to exclude config-driven values.
  const hasOwn = Object.hasOwn(process.env, 'WRONGSTACK_CHILD_ENV_PASSTHROUGH');
  const legacyHasOwn = Object.hasOwn(process.env, 'WRONGSTACK_BASH_ENV_PASSTHROUGH');
  const passthrough =
    (hasOwn && process.env['WRONGSTACK_CHILD_ENV_PASSTHROUGH'] === '1') ||
    (legacyHasOwn && process.env['WRONGSTACK_BASH_ENV_PASSTHROUGH'] === '1');
  if (passthrough && !process.env['CI']) {
    console.warn(
      '[agent] WARNING: WRONGSTACK_*_ENV_PASSTHROUGH=1 is active —\n' +
        '  all parent env vars (including API keys) forwarded to child processes.\n' +
        '  Do not use on shared or multi-tenant systems.',
    );
  }
  const out: NodeJS.ProcessEnv = {};

  // The CLI entry defaults NODE_ENV=production (so React/Ink resolve their
  // production builds — see cli-main) and marks the injection with this
  // flag. The injected value must NOT reach children: NODE_ENV=production
  // makes `pnpm install` skip devDependencies and flips test-runner
  // behavior. Strip both vars whenever the flag says wrongstack set them —
  // a NODE_ENV genuinely exported by the operator's shell (flag absent)
  // is forwarded unchanged. Applies in passthrough mode too: passthrough
  // means "the operator's real environment", which this value is not.
  const nodeEnvDefaulted = process.env['WRONGSTACK_NODE_ENV_DEFAULTED'] === '1';

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (nodeEnvDefaulted && (k === 'NODE_ENV' || k === 'WRONGSTACK_NODE_ENV_DEFAULTED')) continue;
    if (passthrough) {
      out[k] = v;
      continue;
    }
    const upper = k.toUpperCase();
    // 0. Strip any value with an embedded URI credential (user:pass@host),
    //    regardless of the variable name (WS-01). Applied before the allowlist
    //    so even a "system" name carrying a connection string is caught.
    if (valueHasEmbeddedCredential(v)) continue;
    // 1. Forward names on the explicit allowlist — these are well-known
    //    non-secret system variables (PATH, HOME, LANG, ...).
    if (ALLOWED_KEYS.has(upper)) {
      out[k] = v;
      continue;
    }
    // 2. Strip anything that looks like a secret.
    if (looksSecret(upper)) continue;
    // NODE_OPTIONS is forwarded (builds rely on flags like --no-warnings) but
    // module-preload directives (--require/--import/--loader) are stripped —
    // they would let a parent-set NODE_OPTIONS inject code into every node
    // child (WS-02 defense-in-depth).
    if (upper === 'NODE_OPTIONS') {
      const sanitized = sanitizeNodeOptions(v);
      if (sanitized) out[k] = sanitized;
      continue;
    }
    // 3. Forward tooling-prefixed vars that builds commonly need, unless
    //    they already failed the secret check above.
    if (
      upper.startsWith('NODE_') ||
      upper.startsWith('NPM_') ||
      upper.startsWith('PNPM_') ||
      upper.startsWith('YARN_') ||
      upper.startsWith('GIT_') ||
      upper.startsWith('CI') ||
      upper.startsWith('XDG_') ||
      // Our own non-secret knobs (WRONGSTACK_HOME, WRONGSTACK_SESSION_ID, …).
      // Secrets never live in WRONGSTACK_* env vars (they're in the encrypted
      // vault). Forwarding keeps child wstack processes — e.g. ones spawned
      // by the test suite — inside the same redirected global root.
      upper.startsWith('WRONGSTACK_') ||
      upper === 'EDITOR' ||
      upper === 'VISUAL' ||
      upper === 'PAGER'
    ) {
      out[k] = v;
    }
  }

  // Configured commit identity. Applied in passthrough mode too — it is the
  // operator's explicit intent, not a parent-env leak. Placed BEFORE the
  // extras merge so a caller-provided GIT_* override still wins.
  if (gitIdentity) {
    if (gitIdentity.name) {
      out['GIT_AUTHOR_NAME'] = gitIdentity.name;
      out['GIT_COMMITTER_NAME'] = gitIdentity.name;
    }
    if (gitIdentity.email) {
      out['GIT_AUTHOR_EMAIL'] = gitIdentity.email;
      out['GIT_COMMITTER_EMAIL'] = gitIdentity.email;
    }
  }

  // Merge explicit extras AFTER filtering. Callers MUST treat `opts.extra`
  // as a small, user-authored allowlist (e.g. MCP server tokens, LSP env
  // overrides from config). Do NOT pass `process.env` or any object derived
  // from it — that would defeat the parent-env scrub above. The secret
  // filter is intentionally skipped here so legitimate secret-bearing
  // tokens the user explicitly configured can still reach the child.
  if (opts.extra) {
    Object.assign(out, opts.extra);
  }

  if (opts.sessionId) out['WRONGSTACK_SESSION_ID'] = opts.sessionId.replace(/\\/g, '/');
  return out;
}
