import * as os from 'node:os';
import * as path from 'node:path';
import { wstackGlobalRoot } from '../utils/wstack-paths.js';

/**
 * Basenames under the wstack global root that constitute WrongStack's own
 * trusted state. Duplicated from permission-helpers.ts to avoid a circular
 * import (permission-helpers imports getInputString from yolo-risk).
 * Keep in sync with AGENT_STATE_SENSITIVE_BASENAMES.
 */
const PROTECTED_STATE_BASENAMES =
  /^(?:config\.json|config\.local\.json|trust\.json|auth\.json|\.key)$/i;

// Best-effort heuristic detection of destructive shell commands — NOT a
// complete security boundary. Static analysis of shell strings is inherently defeatable
// by obfuscation: env-variable indirection (`$RM -rf /`), quote-splitting
// (`r''m`), base64/eval pipes, command substitution, and aliases all evade
// these patterns. This is one defense-in-depth layer behind the permission
// policy; treat a miss here as expected, not a hole to be plugged with
// ever-more-clever regexes.
//
// CALIBRATION: this gate catches high-impact local/remote side effects that
// should not run solely because a model saw text in untrusted tool output:
// project-escaping or catastrophic recursive deletes, VCS history rewrites,
// public publishes/deploys, cluster-wide deletes, disk/system wipes, and
// network-fetch-then-execute patterns. Harmless reads, normal build/test
// commands, and in-project cleanups stay frictionless.
const CATASTROPHIC_PATTERNS: RegExp[] = [
  /\b(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|newfs)\b/i, // make a filesystem — wipes a partition
  /\bformat\s+[A-Za-z]:/i, // format C: — wipes a Windows volume
  /\bdiskpart\b/i, // Windows partition editor
  /\bdd\b[^|]*\bof=(?:\/dev\/|\\\\[.?]\\)/i, // dd writing straight to a raw device
  />\s*\/dev\/(?:sd|hd|nvme|disk|mapper|vd)/i, // redirect into a raw block device
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // classic fork bomb
];

const HIGH_IMPACT_PATTERNS: RegExp[] = [
  /\b(?:curl|wget|fetch|httpie|http|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|pwsh|powershell|iex|Invoke-Expression)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]{0,120}-(?:enc|encodedcommand)\b/i,
  /\b(?:shutdown|reboot)\b/i,
];

// Top-level locations whose *recursive* deletion is catastrophic (the whole
// filesystem, a system directory, or the user's home). Deleting a file or a
// nested subdirectory *inside* one of these is NOT catastrophic — only the root
// directory itself.
const CATASTROPHIC_POSIX_ROOTS = new Set([
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/var',
  '/boot',
  '/dev',
  '/sys',
  '/proc',
  '/opt',
  '/root',
  '/home',
  '/srv',
  '/run',
  '/system',
  '/library',
  '/applications',
  '/users',
]);
const CATASTROPHIC_WIN_SUBDIRS = new Set([
  'windows',
  'system32',
  'winnt',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
]);

const SHELL_OPERATORS = new Set(['&&', '||', '|', ';', '>', '>>', '<', '2>', '2>>']);

export function getInputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function pathLooksInsideProject(rawPath: string, projectRoot: string | undefined): boolean {
  if (!projectRoot) return false;
  // A leading ~ is the home directory, never the project root. Without this,
  // path.resolve() treats "~/cache" as a relative path *inside* the project
  // (there is no shell tilde-expansion here), masking an escape like `rm -rf ~/cache`.
  if (rawPath === '~' || rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return false;
  const resolved = path.resolve(projectRoot, rawPath);
  const relative = path.relative(projectRoot, resolved);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function tokenizeShell(command: string): string[] {
  return (
    command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? []
  );
}

function commandSegment(tokens: string[], start: number): string[] {
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
function flagLetters(args: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const arg of args) {
    if (/^-[a-zA-Z]+$/.test(arg)) {
      for (const ch of arg.replace(/^-+/, '')) seen.add(ch.toLowerCase());
    } else if (arg === '--recursive') {
      seen.add('r');
    } else if (arg === '--force') {
      seen.add('f');
    }
  }
  return seen;
}

function hasRecursiveForceDelete(command: string, projectRoot: string | undefined): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]?.toLowerCase();
    if (!token) continue;

    if (token === 'rm' || token === 'rmdir') {
      const args = commandSegment(tokens, i + 1);
      const letters = flagLetters(args);
      const recursiveForce = letters.has('r') && letters.has('f');
      if (recursiveForce) {
        const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
        if (targets.length > 0 && targets.every((target) => target.trim().length === 0)) {
          continue;
        }
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }

    if (token === 'remove-item' || token === 'ri') {
      const args = commandSegment(tokens, i + 1).map((arg) => arg.toLowerCase());
      const recurse = args.some((arg) => arg === '-recurse' || arg === '-r');
      const force = args.some((arg) => arg === '-force' || arg === '-f');
      if (recurse && force && !args.includes('-whatif')) {
        const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }

    if (token === 'rd' || token === 'rmdir') {
      const args = commandSegment(tokens, i + 1).map((arg) => arg.toLowerCase());
      if (args.includes('/s')) {
        const targets = args.filter(
          (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
        );
        if (targets.length === 0) return true;
        if (targets.some(isCatastrophicDeleteTarget)) return true;
        if (targets.some((target) => !pathLooksInsideProject(target, projectRoot))) return true;
      }
    }
  }
  return false;
}

function hasGitHistoryRewrite(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue;
    const args = commandSegment(tokens, i + 1);
    if (
      args.includes('reset') &&
      args.some((arg) => arg === '--hard' || arg.startsWith('--hard='))
    ) {
      return true;
    }
    const cleanIdx = args.indexOf('clean');
    if (cleanIdx >= 0) {
      const cleanArgs = args.slice(cleanIdx + 1);
      if (
        cleanArgs.some((arg) => arg === '-f' || arg === '--force' || /^-[a-z]*f[a-z]*$/i.test(arg))
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
            arg === '--force' ||
            arg === '--force-with-lease' ||
            arg.startsWith('--force=') ||
            arg.startsWith('--force-with-lease='),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasExternalPublish(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const cmd = tokens[i];
    if (!cmd) continue;
    const args = commandSegment(tokens, i + 1);
    if (
      ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) &&
      (args.includes('publish') || args.includes('deploy'))
    ) {
      return true;
    }
    if (cmd === 'cargo' && (args.includes('publish') || args.includes('yank'))) return true;
    if ((cmd === 'docker' || cmd === 'podman') && args.includes('push')) return true;
    if (cmd === 'kubectl') {
      const deleteIdx = args.indexOf('delete');
      if (deleteIdx >= 0 && (args[deleteIdx + 1] === 'namespace' || args[deleteIdx + 1] === 'ns')) {
        return true;
      }
      if (args.includes('drain')) return true;
    }
  }
  return false;
}

function hasFindExec(command: string): boolean {
  const tokens = tokenizeShell(command).map((token) => token.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'find') continue;
    const args = commandSegment(tokens, i + 1);
    if (args.some((arg) => arg === '-exec' || arg === '-ok' || arg === '-execdir')) return true;
  }
  return false;
}

/**
 * True only when a delete TARGET is a whole-filesystem / whole-disk / whole-home
 * / system-directory wipe — the catastrophic case. A few files, a nested
 * subdirectory, or an arbitrary sibling directory outside the project are all
 * recoverable-scale and return false (frictionless under YOLO).
 */
function isCatastrophicDeleteTarget(rawTarget: string): boolean {
  const t = rawTarget.replace(/^['"]|['"]$/g, '').trim();
  if (!t) return false;
  // Wipe the current directory wholesale.
  if (t === '*' || t === '.' || t === './' || t === '.\\' || t === './*' || t === '.\\*')
    return true;
  // Strip a trailing `/*` / `\*` glob and any trailing separators so `/etc/`,
  // `/etc/*`, `~/`, `C:\*` collapse onto their root form. An all-separators
  // target ("/", "/*") collapses to '' → the filesystem root.
  const s = t.replace(/[\\/]\*+$/, '').replace(/[\\/]+$/, '');
  if (s === '') return true; // "/", "/*" → filesystem root
  if (s === '~' || /^\$HOME$/i.test(s) || /^%USERPROFILE%$/i.test(s)) return true; // home
  if (/^[A-Za-z]:$/.test(s)) return true; // Windows drive root: C:, C:\, C:\*
  const norm = s.toLowerCase().replace(/\\/g, '/');
  if (CATASTROPHIC_POSIX_ROOTS.has(norm)) return true; // /etc, /usr, /home, …
  const win = norm.match(/^[a-z]:\/([^/]+)$/); // C:\Windows, C:\Users, … (top level only)
  if (win?.[1] && CATASTROPHIC_WIN_SUBDIRS.has(win[1])) return true;
  return false;
}

function hasCatastrophicDelete(command: string): boolean {
  const tokens = tokenizeShell(command);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]?.toLowerCase();
    if (!token) continue;

    // POSIX rm -rf / Remove-Item -Recurse-style recursive force delete.
    if (token === 'rm') {
      const args = tokens.slice(i + 1);
      const recursiveOrForce = args.some(
        (arg) =>
          /^-[^-]*[rf]/i.test(arg) ||
          arg === '--recursive' ||
          arg === '--force' ||
          arg === '--no-preserve-root',
      );
      if (!recursiveOrForce) continue;
      const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
      // `rm -rf` with no operand is a whole-cwd wipe intent.
      if (targets.length === 0) return true;
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    if (token === 'remove-item' || token === 'ri') {
      const args = tokens.slice(i + 1);
      const recursive = args.some((arg) => {
        const a = arg.toLowerCase();
        return a === '-recurse' || a === '-force';
      });
      if (!recursive) continue;
      const targets = args.filter((arg) => !arg.startsWith('-') && !SHELL_OPERATORS.has(arg));
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    // Windows rmdir /s and del/erase — flags use a leading slash, so a path is
    // any non-flag token (and on Windows paths use backslashes/drive letters,
    // never a leading slash).
    if (token === 'rmdir' || token === 'rd') {
      const args = tokens.slice(i + 1);
      const recursive = args.some((arg) => arg.toLowerCase() === '/s');
      if (!recursive) continue;
      const targets = args.filter(
        (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
      );
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }

    if (token === 'del' || token === 'erase') {
      const args = tokens.slice(i + 1);
      const targets = args.filter(
        (arg) => !arg.startsWith('-') && !arg.startsWith('/') && !SHELL_OPERATORS.has(arg),
      );
      if (targets.some(isCatastrophicDeleteTarget)) return true;
    }
  }
  return false;
}

/**
 * Best-effort detection of a shell command that writes to WrongStack's own
 * trusted state files (trust.json, config.local.json, auth.json, .key) via
 * redirection (`>`, `>>`), `tee`, `cp`/`mv`, or heredoc — even when the
 * command itself isn't "destructive" in the catastrophic sense. A write to
 * these files can disable every future confirmation prompt or inject code
 * execution at boot, so it must never be silently auto-approved under YOLO.
 *
 * Like every heuristic in this module, this is defeatable by obfuscation
 * (env-var indirection, eval, base64). It is a defense-in-depth layer, not
 * a security boundary.
 */
function hasWriteToAgentStateRoot(command: string): boolean {
  // Strategy: extract every plausible file-path token from the command, then
  // check each against isProtectedAgentStatePath. We scan:
  // 1. Redirection targets: `> path`, `>> path`
  // 2. `tee path` / `tee -a path`
  // 3. `cp src dst` / `mv src dst` — the last non-flag argument
  // 4. Heredoc-less `cat > path` patterns (covered by #1)
  const tokens = tokenizeShell(command);

  // 1. Redirection targets — `>` or `>>` followed by a path.
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t === '>' || t === '>>') {
      const target = tokens[i + 1];
      if (target && looksLikeAgentStateTarget(target)) return true;
    }
  }

  // 2. `tee` target — first non-flag argument after `tee`.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]?.toLowerCase();
    if (t === 'tee') {
      for (let j = i + 1; j < tokens.length; j++) {
        const arg = tokens[j];
        if (!arg || arg.startsWith('-')) continue;
        if (SHELL_OPERATORS.has(arg)) break;
        if (looksLikeAgentStateTarget(arg)) return true;
        break; // first non-flag arg is the target
      }
    }
  }

  // 3. `cp src dst` / `mv src dst` — if the destination (last non-flag arg)
  //    resolves into the agent state root.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]?.toLowerCase();
    if (t === 'cp' || t === 'copy' || t === 'mv' || t === 'move') {
      const args = commandSegment(tokens, i + 1);
      // The last non-flag, non-operator argument is the destination.
      const dst = args.filter((a) => !a.startsWith('-') && !SHELL_OPERATORS.has(a)).pop();
      if (dst && looksLikeAgentStateTarget(dst)) return true;
    }
  }

  return false;
}

/**
 * Quick check: does the token look like it could resolve into the wstack
 * global root, and does its basename match a protected file? We delegate the
 * full path resolution to isProtectedAgentStatePath, but we pre-filter on
 * the path containing `.wrongstack` or starting with `~/.wrongstack` so we
 * don't call realpath on every token in every command.
 */
function looksLikeAgentStateTarget(rawPath: string): boolean {
  // Expand ~ to the home directory for the comparison.
  const expanded = rawPath.replace(/^~([\\/])/, (_, sep) => `${os.homedir()}${sep}`);
  const resolved = path.resolve(expanded);
  // Fast lexical pre-filter: must contain `.wrongstack` or match the wstack
  // global root prefix.
  const rootStr = wstackGlobalRoot();
  const resolvedNorm = resolved.replace(/\\/g, '/').toLowerCase();
  const rootNorm = path.resolve(rootStr).replace(/\\/g, '/').toLowerCase();
  if (!resolvedNorm.startsWith(rootNorm) && !resolvedNorm.includes('.wrongstack')) {
    return false;
  }
  // Check basename against the protected list (inlined to avoid a circular
  // import with permission-helpers.ts).
  return PROTECTED_STATE_BASENAMES.test(path.basename(resolved));
}

/**
 * Best-effort detection of a *catastrophic* shell command — system-/disk-/
 * home-wide, effectively irreversible destruction, OR a write to WrongStack's
 * own trusted state files that could disable security boundaries.
 * `projectRoot` is accepted for signature stability but is intentionally
 * unused for catastrophic targets (they are absolute). It is not used for
 * state-root detection either (those paths are resolved absolutely).
 */
export function isClearlyDestructiveBashCommand(
  command: string,
  projectRoot: string | undefined,
): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (hasRecursiveForceDelete(trimmed, projectRoot)) return true;
  if (hasGitHistoryRewrite(trimmed)) return true;
  if (hasExternalPublish(trimmed)) return true;
  if (hasFindExec(trimmed)) return true;
  if (hasCatastrophicDelete(trimmed)) return true;
  if (hasWriteToAgentStateRoot(trimmed)) return true;
  if (CATASTROPHIC_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (HIGH_IMPACT_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return false;
}

/**
 * Environment variables that hold a credential for some OTHER service.
 *
 * Not a general "looks like a secret" list — `MYLLM_API_KEY` must stay usable,
 * because naming the env var that supplies a provider's key is the entire point
 * of `provider_manage`. These are the well-known names where attaching them to
 * a NEW provider means pointing an existing credential at a new destination.
 */
const WELL_KNOWN_CREDENTIAL_ENV_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'PERPLEXITY_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GITLAB_TOKEN',
  'SLACK_TOKEN',
  'STRIPE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN',
  'WRONGSTACK_VAULT_PASSPHRASE',
]);

/**
 * True when a tool call would bind a well-known third-party credential to a
 * provider endpoint.
 *
 * `provider_manage` lets the model create a provider, choose its `baseUrl`
 * (validated for scheme only — no host allowlist) and name the environment
 * variables its key is read from. Nothing claims `ANTHROPIC_API_KEY` on a stock
 * install, so `rejectBorrowedEnvVars` — which only rejects names another
 * provider already lists — let it through. Combined with the sibling
 * `fallback_chain_manage` / `leader_model_set` tools in the same bundle, that is
 * a complete "send my real key to a host I chose" primitive, reachable by
 * prompt injection.
 *
 * The tool stays usable: this only forces the decision back to the human rather
 * than letting YOLO auto-approve it.
 */
export function attachesWellKnownCredential(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const envVars = (input as Record<string, unknown>)['envVars'];
  if (!Array.isArray(envVars)) return false;
  return envVars.some(
    (name) => typeof name === 'string' && WELL_KNOWN_CREDENTIAL_ENV_VARS.has(name.toUpperCase()),
  );
}
