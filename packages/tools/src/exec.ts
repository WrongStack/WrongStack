import { spawn } from 'node:child_process';
import type { Tool } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { buildChildEnv } from './_env.js';
import { createOutputSpool, spoolNote } from './_output-spool.js';
import { COMMAND_OUTPUT_MAX_BYTES, normalizeCommandOutput, safeResolveReal } from './_util.js';
import { getProcessRegistry, redactCommand } from './process-registry.js';
import {
  buildWin32CmdShimInvocation,
  resolveWin32Command,
} from './_win32-resolve.js';
import { detectDanger, type DangerAssessment } from './_danger-detect.js';

const isWin = process.platform === 'win32';

// Curated default allowlist of command NAMES the `exec` tool may run. Only the
// command name is gated (per-arg safety is the BLOCKED_ARG_PATTERNS denylist
// below + the per-call `confirm` permission). A prior version mapped each
// command to an allowed-args array, but those arrays were never enforced (dead
// code) — a plain Set is the honest shape.
//
// Extend/trim at runtime via `configureExecPolicy()` (wired from
// `config.tools.exec.{allow,deny}` at boot). `allow` is trusted-config-only;
// see the security note on ExecToolConfig.
const DEFAULT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // JS / TS toolchain
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'corepack', 'tsc', 'tsx', 'ts-node', 'vite', 'vitest', 'jest',
  'biome', 'eslint', 'prettier', 'turbo', 'nx', 'webpack', 'rollup',
  'parcel', 'next', 'astro', 'playwright', 'cypress',
  // version control
  'git',
  // Rust
  'cargo', 'rustc',
  // Go
  'go',
  // Python
  'python', 'python3', 'pip', 'pip3', 'pytest', 'ruff', 'mypy',
  'uv', 'uvx', 'poetry', 'hatch', 'tox',
  // Ruby
  'ruby', 'gem', 'bundle',
  // PHP
  'php', 'composer', 'phpunit',
  // JVM
  'java', 'javac', 'mvn', 'gradle', 'gradlew',
  // .NET
  'dotnet',
  // C / C++ / native build
  'make', 'cmake', 'ninja', 'clang', 'clang-cl', 'gcc', 'g++', 'link', 'msbuild',
  // containers / orchestration
  'docker', 'podman', 'kubectl',
  // network (read-only intent; destructive ops still blocked by BLOCKED_ARG_PATTERNS)
  'curl', 'wget',
  // common POSIX file/text utilities
  'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find',
  'echo', 'sort', 'uniq', 'sed', 'awk', 'mkdir', 'cp', 'mv', 'rm',
  'touch', 'tar',
  // Windows-native tooling (win32). All non-destructive binaries; per-arg
  // safety is still enforced by BLOCKED_ARG_PATTERNS + the destructive-ops
  // gate in bash-kill-guard.ts. `gh` is included even though it lives at
  // "C:\Program Files\GitHub CLI\gh.exe" — resolveWin32Command handles the
  // space in the path.
  'gh',
  'where', 'tasklist', 'systeminfo', 'wmic', 'sc',
  'netstat', 'ipconfig', 'nslookup', 'tracert', 'pathping',
  // Windows shell interpreters. Without these, `exec` cannot run cmd builtins
  // (`dir`, `type`, `copy`, …) or any PowerShell cmdlet on Windows — a major
  // gap since those are the platform's primary shells. Arbitrary execution
  // through `cmd /c …` / `powershell -c …` is NOT a new hole: the permission
  // policy reconstructs the full command line (shellCommandLineFromInput) and
  // still runs it through the YOLO destructive classifier, so a genuinely
  // destructive `cmd /c del /s /q C:\…` continues to require confirmation.
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  // [core] Extended default allowlist (added 4b3d18d1 + this commit). All
  // non-destructive, broadly-used dev binaries. Per-arg safety is still
  // enforced by BLOCKED_ARG_PATTERNS + bash-kill-guard.ts.
  // --- Archives & compression ---
  '7z', '7za', 'bzip2', 'gzip', 'xz', 'unzip', 'zip', 'gtar', 'bsdtar', 'star', 'pax', 'cpio',
  // --- Android / mobile dev ---
  'adb', 'fastboot', 'sdkmanager',
  // --- DevOps / config mgmt ---
  'ansible', 'ansible-playbook', 'ansible-vault', 'ansible-lint', 'ansible-galaxy', 'molecule',
  // --- Cloud CLIs ---
  'aws', 'aws-vault', 'awslocal', 'az', 'azcopy', 'gcloud', 'gsutil', 'doctl', 'linode-cli',
  // --- Native / C / C++ / linker tools ---
  'clang++', 'clang-format', 'clang-tidy', 'clangd', 'lld', 'lldb', 'ctest', 'gmake', 'meson', 'conan', 'vcpkg', 'cl', 'rc', 'mt', 'dumpbin', 'dotnet-format',
  // --- Image / media / binary tools ---
  'convert', 'ffmpeg', 'ffprobe', 'magick', 'gs', 'exiftool',
  // --- HTTP / fetch ---
  'wget2', 'aria2c', 'axel', 'httpie', 'hey', 'ab', 'wrk', 'http',
  // --- Diff / patch / merge ---
  'diff', 'diff3', 'patch', 'meld', 'kdiff3', 'kompare',
  // --- Encoding / file inspection ---
  'dos2unix', 'unix2dos', 'iconv', 'file', 'stat', 'xxd', 'hexdump', 'od', 'base64',
  // --- SSH / crypto / signing ---
  'ssh', 'ssh-add', 'ssh-keygen', 'ssh-keyscan', 'scp', 'sftp', 'rsync', 'gpg', 'gpg2', 'gpg-agent', 'openssl', 'step', 'keytool',
  // --- Search ---
  'egrep', 'fgrep', 'ag', 'ack', 'sift', 'ugrep', 'fd', 'fdfind', 'jq', 'yq', 'xq', 'fx', 'gron',
  // --- K8s / container ecosystem ---
  'kubectl.exe', 'kubeadm', 'kubelet', 'helm', 'k9s', 'kustomize', 'skaffold', 'tilt', 'minikube', 'kind', 'k3d', 'k3s',
  'docker-compose', 'buildah', 'skopeo', 'nerdctl', 'ctr', 'ctr.exe',
  // --- Databases ---
  'sqlite3', 'sqlite', 'psql', 'pg_dump', 'pg_restore', 'mysql', 'mysqladmin', 'mysqldump', 'mariadb', 'mariadb-dump',
  'redis-cli', 'redis-server', 'memcached', 'etcdctl', 'consul', 'vault', 'nomad',
  'mongosh', 'mongo', 'mongoexport', 'mongoimport', 'mongodump', 'mongorestore',
  // --- Windows extended (read-mostly ops) ---
  'taskkill', 'gpupdate', 'gpresult', 'hostname', 'whoami', 'who', 'net', 'net1',
  // --- VCS ecosystem ---
  'glab', 'hub', 'tea', 'git-lfs', 'tig', 'lazygit',
  // --- POSIX text utilities (extended; duplicates of pwd/ls/cat/head/tail/wc/
  //     grep/find/echo/awk/mkdir/cp/mv/rm/touch from the base list above are
  //     omitted — the Set is de-duplicated at runtime but a clean literal is
  //     easier to maintain) ---
  'gawk', 'tr', 'cut', 'paste', 'join', 'comm', 'expand', 'unexpand', 'fold', 'fmt', 'nl', 'pr', 'column', 'tsort',
  'tty', 'ul', 'units', 'factor', 'seq', 'shuf', 'look', 'yes', 'true', 'false', 'test', '[', 'printf',
  'env',
  'tree', 'locate', 'which', 'whereis', 'type', 'hash', 'pushd', 'popd', 'dirs', 'history', 'fc', 'jobs', 'bg', 'fg', 'wait',
  'ulimit', 'umask', 'nice', 'nohup', 'timeout', 'time', 'trap', 'exit', 'return', 'source', '.', 'alias', 'unalias',
  'set', 'unset', 'export', 'readonly', 'typeset', 'declare', 'local', 'eval', 'exec',
  // --- Process / system inspection ---
  'htop', 'top', 'atop', 'glances', 'iotop', 'nethogs', 'iftop', 'lsof', 'strace', 'ltrace', 'sysstat', 'vmstat', 'iostat', 'mpstat', 'sar',
  'free', 'df', 'du', 'mount', 'umount', 'lsblk', 'blkid',
  'kill', 'killall', 'pkill', 'pgrep', 'pidof', 'ps', 'ps.exe',
  // --- Network inspection ---
  'ip', 'ss', 'route', 'arp', 'arping', 'ping', 'ping6', 'hping3', 'mtr', 'tracepath', 'tcpdump', 'nmap', 'netcat', 'nc', 'ncat', 'socat',
  // --- Sync / backup ---
  'rclone', 'restic', 'borg', 'duplicati', 'duplicacy', 'syncthing', 'syncthing-cli',
  // --- Permissions / users / ACLs (POSIX) ---
  'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'groupmod', 'chown', 'chmod', 'chgrp', 'getfacl', 'setfacl', 'setcap', 'getcap',
  // --- Crypto / cert mgmt (extended) ---
  'certbot', 'mkcert', 'jarsigner',
  // --- Editors ---
  'subl', 'code', 'code-insiders', 'cursor', 'atom', 'nano', 'vim', 'nvim', 'vi', 'emacs', 'helix', 'hx', 'micro', 'jed', 'ed', 'ex', 'mg',
  // --- Terminal multiplexers ---
  'asciinema', 'script', 'scriptreplay', 'expect', 'screen', 'tmux', 'byobu', 'dtach', 'abduco',
  // --- Calculators / REPLs / scientific ---
  'bc', 'dc', 'calc', 'qalc', 'genius', 'octave', 'R', 'Rscript', 'julia', 'irb', 'pry', 'ghci', 'stack', 'cabal', 'ghc',
  // --- PHP / Lua / Perl / Ruby ecosystem (extended) ---
  'php8', 'php7', 'phpcs', 'phpcbf', 'phpmd', 'phpstan', 'psalm',
  'lua', 'lua5.1', 'lua5.2', 'lua5.3', 'lua5.4', 'luarocks',
  'perl', 'cpan', 'prove', 'plackup',
  'rake', 'rspec', 'jekyll', 'node-gyp', 'node-pre-gyp',
  // --- JS / TS toolchain (extended) ---
  'electron', 'electron-builder', 'electron-forge', 'vite-preview', 'swc', 'swc-cli', 'swcpack',
  'mocha', 'chai', 'jasmine', 'puppeteer', 'lighthouse',
  // --- Linters / formatters (extended) ---
  'tslint', 'stylelint', 'htmlhint', 'jshint', 'jslint', 'jscs',
  // --- Document conversion ---
  'pandoc', 'weasyprint', 'wkhtmltopdf', 'wkhtmltoimage', 'prince', 'mdp', 'markdown', 'multimarkdown', 'cmark', 'cmark-gfm',
  // --- Office / spreadsheet ---
  'soffice', 'libreoffice', 'unoconv', 'abiword', 'gnumeric',
  // --- Spell / grammar ---
  'aspell', 'hunspell', 'enchant', 'languagetool',
  // --- Source-highlight / diff tools ---
  'delta', 'bat', 'ccat', 'hl', 'highlight', 'source-highlight', 'ansifilter',
  // --- Job schedulers ---
  'pueue', 'task-spooler', 'ts', 'at', 'atd', 'anacron', 'fcron', 'cronie', 'systemd-run', 'systemd-cat',
  // --- Plotting / visualization ---
  'gnuplot', 'gnuplot-nox', 'veusz', 'scidavis', 'grace', 'xmgrace', 'labplot',
  // --- Security / recon (network + web) ---
  'masscan', 'zmap', 'rustscan', 'amass', 'subfinder', 'httpx', 'nuclei', 'naabu', 'katana', 'dnsx', 'assetfinder', 'findomain', 'gau', 'waybackurls', 'httprobe', 'meg', 'subjack', 'sublert', 'chaos',
]);

// The live, effective allowlist: DEFAULT ∪ config.allow − config.deny. Replaced
// wholesale by configureExecPolicy(); defaults until boot wires the config.
let allowedCommands: Set<string> = new Set(DEFAULT_ALLOWED_COMMANDS);

const normalizeCmd = (c: string): string => c.trim();

/**
 * Apply the configured exec command policy. Recomputes the effective allowlist
 * as `DEFAULT ∪ allow − deny`. Call once at boot from
 * `config.tools.exec.{allow,deny}`. Idempotent (always rebuilt from defaults).
 *
 * SECURITY: `allow` must originate from TRUSTED config only — the config loader
 * strips `tools.exec.allow` from the untrusted in-project repo config before it
 * reaches here. `deny` is safe from any source (it only narrows).
 */
export function configureExecPolicy(opts: { allow?: readonly string[] | undefined; deny?: readonly string[] | undefined } = {}): void {
  const next = new Set(DEFAULT_ALLOWED_COMMANDS);
  for (const c of opts.allow ?? []) {
    const n = normalizeCmd(c);
    if (n) next.add(n);
  }
  for (const c of opts.deny ?? []) next.delete(normalizeCmd(c));
  allowedCommands = next;
}

/** Reset the exec allowlist to the built-in defaults (tests / re-init). */
export function resetExecPolicy(): void {
  allowedCommands = new Set(DEFAULT_ALLOWED_COMMANDS);
}

// -----------------------------------------------------------------------
// Danger-detection bypass (config.tools.exec.danger.bypass)
// -----------------------------------------------------------------------

/**
 * Set of rule ids that should be skipped during danger detection. Wired
 * from `config.tools.exec.danger.bypass` at boot. Mirrors the
 * `allowedCommands` pattern above: defaults to empty, replaced wholesale
 * by `configureDangerBypass()`, reset by `resetDangerBypass()`.
 *
 * SECURITY: like `allow`, this is a per-rule weakening of the danger
 * gate. The boot path strips `tools.exec.danger.bypass` from in-project
 * repo config; only trusted config (user-global, system) sets it.
 */
let dangerBypass: ReadonlySet<string> = new Set();

/**
 * Apply the configured danger-bypass policy. Each id in `bypass` is
 * added to the effective skip set; duplicates are fine. Idempotent.
 *
 * Call once at boot from `config.tools.exec.danger.bypass`.
 */
export function configureDangerBypass(opts: { bypass?: readonly string[] | undefined } = {}): void {
  const next = new Set<string>();
  for (const id of opts.bypass ?? []) {
    const trimmed = id.trim();
    if (trimmed) next.add(trimmed);
  }
  dangerBypass = next;
}

/** Reset the danger-bypass set to empty (tests / re-init). */
export function resetDangerBypass(): void {
  dangerBypass = new Set();
}

/**
 * Read-only view of the active bypass set. `detectDanger()` takes a
 * `bypass` argument directly, so consumers should prefer passing this
 * rather than reading the set and matching themselves.
 */
export function getDangerBypass(): ReadonlySet<string> {
  return dangerBypass;
}

/** Whether `cmd` is currently in the effective exec allowlist. */
export function isExecCommandAllowed(cmd: string): boolean {
  return allowedCommands.has(normalizeCmd(cmd));
}

/** Snapshot of the effective allowlist (sorted) — for tests / diagnostics. */
export function getExecAllowlist(): string[] {
  return [...allowedCommands].sort();
}

const MAX_ARGS = 20;
// 200 KB — larger than bash's 32 KB cap. exec commands produce structured,
// predictable output (build logs, test results, git diffs) that the agent
// needs in full. 200 KB is safe for context windows ≥200K tokens while
// still preventing a rogue build from filling the context.
const MAX_OUTPUT = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;

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
    /^-C$/,
    /^-c$/,
    /^--config$/,
    /^-c=/,
    /^--config=/,
    /^--config-env=/,
  ],
  node: [],
  go: [],
  bun: [],
  docker: [],
  // find -exec/-ok/-execdir execute arbitrary commands
  find: [/^-exec$/, /^-exec;$/, /^-ok$/, /^-ok;$/, /^-execdir$/, /^-execdir;$/, /^-exec=/, /^-ok=/, /^-execdir=/],
  // rm -rf / is catastrophic — block absolute paths, home, dot-dirs,
  // and glob patterns that could expand to dangerous targets.
  // `rm -rf ./src/*` expands to project files; `rm -rf ../../` escapes upward;
  // `rm -rf /*` targets the filesystem root. All are blocked.
  rm: [/^\//, /^~\//, /^~$/, /^\.$/, /^\.\.$/, /\*$/, /\/$/, /\/\*$/, /\.\//],
  // npm/pnpm subcommands are checked separately below. Matching every arg here
  // over-blocked normal dev flows such as `pnpm vitest run ...`.
  npm: [],
  pnpm: [],
  npx: [],
};

// Subcommand verbs only make sense in subcommand position. Keep externally
// destructive actions blocked there without rejecting harmless downstream args
// named "run", "publish", etc. passed to test runners or build tools.
const BLOCKED_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  docker: new Set(['push']),
  podman: new Set(['push']),
  npm: new Set(['publish', 'deploy']),
  pnpm: new Set(['publish', 'deploy']),
  yarn: new Set(['publish']),
};

const BLOCKED_SUBCOMMAND_SEQUENCES: Record<string, readonly (readonly string[])[]> = {
  yarn: [['npm', 'publish']],
};

function firstSubcommand(args: string[]): string | null {
  for (const arg of args) {
    if (arg === '--') return null;
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

function subcommandArgs(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg === '--') break;
    if (!arg.startsWith('-')) out.push(arg);
  }
  return out;
}

function validateArgs(cmd: string, args: string[]): string | null {
  const blockedSubcommands = BLOCKED_SUBCOMMANDS[cmd];
  const subcommand = firstSubcommand(args);
  if (blockedSubcommands && subcommand && blockedSubcommands.has(subcommand)) {
    return `Blocked subcommand "${subcommand}" for command "${cmd}"`;
  }

  const blockedSequences = BLOCKED_SUBCOMMAND_SEQUENCES[cmd];
  if (blockedSequences) {
    const actual = subcommandArgs(args);
    const blocked = blockedSequences.find((seq) => seq.every((part, idx) => actual[idx] === part));
    if (blocked) return `Blocked subcommand "${blocked.join(' ')}" for command "${cmd}"`;
  }

  const blocked = BLOCKED_ARG_PATTERNS[cmd];
  if (!blocked) return null;

  for (const arg of args) {
    for (const pattern of blocked) {
      if (pattern.test(arg)) {
        return `Blocked argument "${arg}" for command "${cmd}" (matches security pattern ${pattern})`;
      }
    }
  }
  return null;
}

interface ExecInput {
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  timeout?: number | undefined;
}

interface ExecOutput {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  allowed: boolean;
  /**
   * Heuristic danger assessment of the (cmd, args) pair. Populated for every
   * call (not just blocked ones) so the UI/TUI can render a banner when the
   * level is 'caution' or 'destructive'. See `_danger-detect.ts` for the
   * rule set.
   *
   * Pre-execution error returns (allowlist miss, circuit breaker, etc.)
   * report `level: 'safe'` because the command never actually ran; the UI
   * should surface the error separately and not also a danger warning.
   */
  danger: DangerAssessment;
}

const SAFE_DANGER: DangerAssessment = { level: 'safe', reasons: [] };

export const execTool: Tool<ExecInput, ExecOutput> = {
  name: 'exec',
  category: 'Shell',
  description:
    'Execute a **whitelisted, restricted set of commands** with strict argument validation. ' +
    'This is the **preferred and safer** alternative to the `bash` tool for running development tools (node, npm, pnpm, tsc, git, tests, linters, etc.). ' +
    'It prevents arbitrary command injection and limits what the model can do.',
  usageHint:
    'PREFERRED SHELL TOOL for most cases.\n\n' +
    'Use this instead of `bash` whenever possible.\n' +
    '- `command` must be in the allowlist. Defaults cover JS (node/npm/pnpm/yarn/bun/deno/tsc/vitest/eslint/biome), Go (`go build`/`go test`), Rust (cargo), Python (python/pip), Ruby (gem/bundle), JVM (java/mvn/gradle), .NET (dotnet), native (make/cmake), and git. Users can extend it via `tools.exec.allow` in config.\n' +
    '- Arguments are passed as a clean array (no shell interpretation).\n' +
    '- `cwd` is validated to stay inside the project.\n' +
    '- If a command is not allowlisted, the error explains how to add it; for one-off arbitrary commands, fall back to `bash` (with strong justification).\n' +
    'This tool significantly reduces the risk compared to full shell access.',
  permission: 'confirm',
  mutating: true,
  riskTier: 'standard',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  capabilities: ['shell.restricted'],
  icon: 'terminal',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The base command to run. Must be in the internal allowlist (e.g. "node", "pnpm", "git", "tsc").',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments passed to the command. Passed as an array (no shell parsing).',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Must resolve inside the project root.',
      },
      timeout: {
        type: 'integer',
        description: 'Per-command timeout in milliseconds.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    const registry = getProcessRegistry();
    if (!registry.canProceed) {
      return {
        command: input.command,
        args: input.args ?? [],
        stdout: '',
        stderr: 'Circuit breaker is open — too many consecutive failures. Use /kill reset to recover.',
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger: SAFE_DANGER,
      };
    }

    const cmd = input.command.trim();
    if (!cmd)
      return {
        command: cmd,
        args: [],
        stdout: '',
        stderr: 'Empty command',
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger: SAFE_DANGER,
      };

    if (!isExecCommandAllowed(cmd)) {
      return {
        command: cmd,
        args: input.args ?? [],
        stdout: '',
        stderr:
          `Command "${cmd}" not in allowlist. ` +
          `Add it to your ~/.wrongstack/config.json under "tools": { "exec": { "allow": ["${cmd}"] } }, ` +
          `or use the bash tool for one-off arbitrary commands.`,
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger: SAFE_DANGER,
      };
    }

    const args = (input.args ?? []).slice(0, MAX_ARGS);
    const timeout = Math.max(1, Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));

    // Heuristic danger assessment. Computed once here, attached to every
    // return from this point on (including error returns) so the UI can
    // render a banner for 'caution' / 'destructive' levels. The `bypass`
    // argument is wired from `config.tools.exec.danger.bypass` (see
    // `configureDangerBypass`); rule ids in that set are skipped.
    const danger: DangerAssessment = detectDanger(cmd, args, dangerBypass);

    // Validate args against per-command security patterns
    const argError = validateArgs(cmd, args);
    if (argError) {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: argError,
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger,
      };
    }

    let cwd: string;
    try {
      // Resolve cwd inside the project root and verify realpath containment so
      // an in-project symlink cannot redirect allowlisted commands outside.
      cwd = input.cwd ? await safeResolveReal(input.cwd, ctx) : await safeResolveReal(ctx.cwd, ctx);
    } catch {
      return {
        command: cmd,
        args,
        stdout: '',
        stderr: `cwd "${input.cwd ?? ctx.cwd}" resolves outside project root`,
        exitCode: 1,
        truncated: false,
        allowed: false,
        danger,
      };
    }
    const signal = opts.signal;

    return runCommand(cmd, args, cwd, timeout, signal, ctx.session?.id, danger);
  },
};

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  sessionId: string | undefined,
  danger: DangerAssessment,
): Promise<ExecOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const resolvedOnce = { value: false };
    const finish = (result: ExecOutput): void => {
      // Guard against double-resolve: 'error' and 'close' can both fire for
      // the same abort (Node's abort path emits both), and resolving twice
      // is a no-op but the extra work (normalizeCommandOutput, registry
      // bookkeeping, spool finalize) is wasted. First writer wins.
      if (resolvedOnce.value) return;
      resolvedOnce.value = true;
      resolve(result);
    };
    const startedAt = Date.now();
    // Full-output spool (stdout+stderr interleaved as they arrive): the
    // in-memory buffers keep only the first MAX_OUTPUT bytes; the spool
    // captures everything on disk and the result points at the file.
    const spool = createOutputSpool({ tool: `exec-${cmd}`, thresholdBytes: MAX_OUTPUT });

    // On Windows, .cmd/.bat files are not natively executable by CreateProcess.
    // resolveWin32Command() finds the full path, then the shim helper launches
    // it through cmd.exe without Node's deprecated shell+args path.
    const resolved = resolveWin32Command(cmd);
    const needsShell = isWin && (resolved.endsWith('.cmd') || resolved.endsWith('.bat'));
    const shim = needsShell ? buildWin32CmdShimInvocation(resolved, args) : null;
    const spawnCmd = shim?.command ?? resolved;
    const spawnArgs = shim?.args ?? args;

    // Wrap the entire spawn lifecycle in try/catch so a synchronous throw
    // (bad argv, ENOENT for missing binary, ERR_INVALID_ARG_TYPE for bad
    // signal, etc.) resolves the promise with an error response instead
    // of producing an unhandled rejection. Without this guard the
    // promise executor itself can throw, which Node treats as an
    // unhandled rejection and surfaces in process.on('unhandledRejection').
    let child: ReturnType<typeof spawn>;
    try {
      // On Windows the abort signal is handled manually below: Node's built-in
      // handling kills only the direct child, orphaning grandchildren (vitest
      // forks, dev servers, anything under a .cmd shim) that keep the inherited
      // stdio pipes open. registry.kill() tree-kills via taskkill instead.
      child = spawn(spawnCmd, spawnArgs, {
        cwd,
        env: buildChildEnv(sessionId),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(isWin ? {} : { signal }),
        ...(shim ? { windowsVerbatimArguments: shim.windowsVerbatimArguments } : {}),
      });
    } catch (err) {
      // spawn() can throw synchronously — e.g. ERR_INVALID_ARG_TYPE for a
      // malformed `signal`, or for some Node versions ENOENT when the binary
      // isn't on PATH. Convert to a graceful result so the tool caller
      // sees a structured error instead of an unhandled rejection that
      // would crash the host.
      spool.finalize();
      finish({
        command: cmd,
        args,
        stdout: '',
        stderr: `spawn failed: ${toErrorMessage(err)}`,
        exitCode: 1,
        truncated: false,
        allowed: true,
        danger,
      });
      return;
    }

    // Attach the 'error' listener IMMEDIATELY after spawn, BEFORE any other
    // async setup (process registry call, setTimeout, abort listener). The
    // Node EventEmitter contract is that an 'error' event with no listener
    // rethrows on nextTick and crashes the entire process — this is the
    // exact failure mode issue #99 describes. Attach first, then do the
    // bookkeeping, so an abort / ENOENT / EPIPE that fires between spawn
    // and the rest of setup still has a listener attached.
    child.on('error', (err) => {
      // Distinguish an abort from a true spawn failure so the caller can
      // tell "the user cancelled this" apart from "the binary is missing".
      // The signal passed to spawn() is an AbortSignal; Node internally
      // converts the abort into an AbortError with `code: 'ABORT_ERR'`.
      const isAbort = err && (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
      const stderrText = isAbort ? `Aborted: ${err.message}` : err.message;
      clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      registry.afterCall(Date.now() - startedAt, true);
      spool.finalize();
      finish({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout),
        stderr: stderrText,
        exitCode: isAbort ? 124 : 1,
        truncated: Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES,
        allowed: true,
        danger,
      });
    });

    const registry = getProcessRegistry();
    const pid = child.pid;
    if (typeof pid === 'number') {
      const fullCommand = `${cmd} ${args.join(' ')}`;
      registry.register({ pid, name: 'exec', command: redactCommand(fullCommand), startedAt: Date.now(), sessionId, child });
    }

    const timer = setTimeout(() => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid);
      else child.kill('SIGTERM');
    }, timeout);

    const onAbort = () => {
      killed = true;
      if (typeof pid === 'number') registry.kill(pid, { force: true });
      else child.kill('SIGTERM');
    };
    if (isWin) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stdout.length < MAX_OUTPUT) stdout += text;
      spool.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (stderr.length < MAX_OUTPUT) stderr += text;
      spool.write(text);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (isWin) signal.removeEventListener('abort', onAbort);
      if (typeof pid === 'number') registry.unregister(pid);
      const durationMs = Date.now() - startedAt;
      const exitCode = killed ? 124 : (code ?? 1);
      registry.afterCall(durationMs, exitCode !== 0);
      const spooled = spool.finalize();
      finish({
        command: cmd,
        args,
        stdout: normalizeCommandOutput(stdout) + (spooled ? spoolNote(spooled) : ''),
        stderr: normalizeCommandOutput(stderr),
        exitCode,
        truncated:
          Buffer.byteLength(stdout, 'utf8') > COMMAND_OUTPUT_MAX_BYTES ||
          Buffer.byteLength(stderr, 'utf8') > COMMAND_OUTPUT_MAX_BYTES,
        allowed: true,
        danger,
      });
    });
  });
}
