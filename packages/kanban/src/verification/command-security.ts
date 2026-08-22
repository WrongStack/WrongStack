/** Maximum retained stdout or stderr for a spawned verification process. */
export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Collect child-process output without allowing a chatty process to exhaust RAM. */
export class BoundedProcessOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes = MAX_PROCESS_OUTPUT_BYTES) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.maxBytes - this.bytes;
    if (remaining > 0) {
      if (buffer.byteLength <= remaining) {
        this.chunks.push(buffer);
        this.bytes += buffer.byteLength;
      } else {
        this.chunks.push(Buffer.from(buffer.subarray(0, remaining)));
        this.bytes += remaining;
      }
    }
    if (buffer.byteLength > remaining) this.truncated = true;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  toString(): string {
    const output = Buffer.concat(this.chunks, this.bytes).toString('utf8');
    return this.truncated
      ? `${output}\n--- output truncated after ${this.maxBytes} bytes ---`
      : output;
  }
}

// ─── Command Allowlist ──────────────────────────────────────────────────────

/**
 * Regex that detects shell metacharacters used to chain multiple commands.
 *
 * Blocked operators:
 *   `&&`, `||` — command chaining
 *   `;`, `|`, `` ` `` — separator, pipe, command substitution
 *   `>`, `<`, `&` — redirections and backgrounding
 *   `$(` — command substitution
 *   `\n`, `\r` — newline / carriage return as command separators
 */
export const SHELL_OPERATOR_RE = /(?:&&|\|\||[;&<>|`\n\r]|\$[({])/;
export const ENV_EXPANSION_RE = /(?:\$[A-Za-z_]|%[^%\r\n]+%|![^!\r\n]+!)/;

/**
 * Commands permitted by default — read-only inspection only.
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = ['pwd', 'true', 'false', 'test'];

/** Commands explicitly blocked even when they would otherwise pass the allowlist. */
export const DEFAULT_BLOCKED_COMMANDS: readonly string[] = [
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'rmtree',
  'mk',
  'mkdir',
  'md',
  'mv',
  'move',
  'cp',
  'copy',
  'xcopy',
  'robocopy',
  'ren',
  'rename',
  'ln',
  'link',
  'mklink',
  'install',
  'touch',
  'kill',
  'taskkill',
  'pkill',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'chmod',
  'chown',
  'chgrp',
  'attrib',
  'cacls',
  'icacls',
  'format',
  'fdisk',
  'dd',
  'mkfs',
  'mount',
  'umount',
  'diskpart',
  'wget',
  'curl',
  'fetch',
  'nc',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'rsync',
  'ftp',
  'sftp',
  'sudo',
  'su',
  'runas',
  'doas',
  'sh',
  'bash',
  'zsh',
  'ksh',
  'dash',
  'ash',
  'cmd',
  'powershell',
  'pwsh',
  'apt',
  'apt-get',
  'dpkg',
  'rpm',
  'yum',
  'dnf',
  'pacman',
  'zypper',
  'brew',
  'port',
  'choco',
  'scoop',
  'winget',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'node',
  'make',
  'cmake',
  'gcc',
  'g++',
  'clang',
  'rustc',
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  '7z',
  'rar',
  'base64',
  'base32',
  'openssl',
  'gpg',
  'reg',
  'regedit',
  'sc',
  'net',
  'netsh',
  'vssadmin',
  'bcdedit',
  'invoke-webrequest',
  'iwr',
  'perl',
  'python',
  'python3',
  'ruby',
  'php',
  'lua',
  'tclsh',
  'find',
];

export interface CommandAllowlistConfig {
  allowedCommands?: readonly string[] | undefined;
  blockedCommands?: readonly string[] | undefined;
  allowAll?: boolean | undefined;
}

export function normalizeBaseCommand(token: string): string {
  return token
    .replace(/^.*[/\\]/, '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

export function buildAllowlist(config: CommandAllowlistConfig | undefined): {
  allow: Set<string>;
  block: Set<string>;
} {
  const allow = new Set(DEFAULT_ALLOWED_COMMANDS.map((c) => normalizeBaseCommand(c)));
  const block = new Set(DEFAULT_BLOCKED_COMMANDS.map((c) => normalizeBaseCommand(c)));
  if (config?.allowedCommands) {
    for (const cmd of config.allowedCommands) {
      if (cmd.startsWith('+')) {
        allow.add(normalizeBaseCommand(cmd.slice(1)));
      } else if (cmd.startsWith('-')) {
        allow.delete(normalizeBaseCommand(cmd.slice(1)));
      } else {
        allow.add(normalizeBaseCommand(cmd));
      }
    }
  }
  if (config?.blockedCommands) {
    for (const cmd of config.blockedCommands) {
      if (cmd.startsWith('+')) {
        block.delete(normalizeBaseCommand(cmd.slice(1)));
      } else {
        block.add(normalizeBaseCommand(cmd));
      }
    }
  }
  return { allow, block };
}

/** Parse a command string into an executable and argv without invoking a shell. */
export function parseCommandArguments(command: string): string[] | string {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
    } else {
      current += char;
      tokenStarted = true;
    }
  }

  if (quote) return 'Command contains an unterminated quoted argument.';
  if (tokenStarted) args.push(current);
  return args;
}

/** Extract the base executable name from a command string. */
export function extractBaseCommand(command: string): string {
  const parsed = parseCommandArguments(command);
  return typeof parsed === 'string' ? '' : normalizeBaseCommand(parsed[0] ?? '');
}

/** Validate a command string. Returns null if allowed, or an error message. */
export function validateCommand(
  command: string,
  config: {
    allow: Set<string>;
    block: Set<string>;
    allowAll: boolean;
    allowShellOperators?: boolean;
  },
): string | null {
  const base = extractBaseCommand(command);
  if (!base) return 'Empty command.';
  if (command.includes('\n') || command.includes('\r')) {
    return 'Command contains newline or carriage return characters which are not permitted.';
  }
  const testTarget = process.platform === 'win32' ? command.replaceAll('^', '') : command;
  if (!config.allowShellOperators && SHELL_OPERATOR_RE.test(testTarget)) {
    return 'Command contains shell operators (&&, ||, ;, |, &, >, <, backticks, $()) which are not permitted in the verifier.';
  }
  if (ENV_EXPANSION_RE.test(testTarget)) {
    return 'Command contains environment-variable expansion, which is not permitted in the verifier.';
  }
  if (config.block.has(base)) {
    return `Command "${base}" is blocked by the verifier security policy.`;
  }
  if (!config.allowAll && !config.allow.has(base)) {
    return `Command "${base}" is not in the verifier allowlist.`;
  }
  return null;
}
