import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { resolveHqPasswordInput } from './hq-server/secret-input.js';
import type { SubcommandDeps, SubcommandHandler } from './subcommands/contracts.js';
import {
  detectUpdatePackageManager,
  detectUpdatePackageName,
} from './subcommands/handlers/update.js';

const SERVICE_NAME = 'wrongstack-hq.service';
const UPDATE_SERVICE_NAME = 'wrongstack-hq-update.service';
const UPDATE_TIMER_NAME = 'wrongstack-hq-update.timer';
const SYSTEMD_DIR = '/etc/systemd/system';
const ENV_DIR = '/etc/wrongstack';
const ENV_FILE = `${ENV_DIR}/hq.env`;
const UPDATE_SCRIPT = '/usr/local/libexec/wrongstack-hq-update';
const MANAGED_MARKER = 'Managed by WrongStack HQ service installer';

type ServerPackageManager = 'npm' | 'pnpm';

export interface HqServiceAssets {
  service: string;
  updateService: string;
  updateTimer: string;
  updateScript: string;
  environment: string;
}

export interface HqServiceAssetOptions {
  wstackBin: string;
  packageManager: ServerPackageManager;
  packageName: 'wrongstack' | '@wrongstack/cli';
  password: string;
  port: number;
  publicOrigin?: string | undefined;
  ipAllowlist?: string | undefined;
}

function unitQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('systemd values cannot contain line breaks or NUL');
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function envQuote(value: string): string {
  if (/[\r\n\0]/.test(value))
    throw new Error('HQ service secrets cannot contain line breaks or NUL');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  if (/\0/.test(value)) throw new Error('shell values cannot contain NUL');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderHqServiceAssets(options: HqServiceAssetOptions): HqServiceAssets {
  const bindHost = options.publicOrigin ? '127.0.0.1' : '0.0.0.0';
  const execStart = [
    unitQuote(options.wstackBin),
    'hq',
    'serve',
    '--host',
    bindHost,
    '--port',
    String(options.port),
    '--strict-port',
  ].join(' ');
  const service = `# ${MANAGED_MARKER}
[Unit]
Description=WrongStack HQ command center
Documentation=https://github.com/WrongStack/WrongStack
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
DynamicUser=yes
StateDirectory=wrongstack-hq
StateDirectoryMode=0700
WorkingDirectory=/var/lib/wrongstack-hq
Environment=NODE_ENV=production
Environment=HOME=/var/lib/wrongstack-hq
Environment=WRONGSTACK_HOME=/var/lib/wrongstack-hq
Environment=WRONGSTACK_HQ_DATA_DIR=/var/lib/wrongstack-hq/hq
Environment=WRONGSTACK_HQ_SUPPRESS_STARTUP_SECRETS=1
EnvironmentFile=${ENV_FILE}
ExecStartPre=/usr/bin/test -x ${unitQuote(options.wstackBin)}
ExecStart=${execStart}
Restart=always
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wrongstack-hq
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;

  const updateService = `# ${MANAGED_MARKER}
[Unit]
Description=Safely update WrongStack HQ
Documentation=https://github.com/WrongStack/WrongStack
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=root
CacheDirectory=wrongstack-hq-update
Environment=HOME=/var/cache/wrongstack-hq-update
ExecStart=${UPDATE_SCRIPT}
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
`;

  const updateTimer = `# ${MANAGED_MARKER}
[Unit]
Description=Daily WrongStack HQ self-update check

[Timer]
OnBootSec=15min
OnCalendar=*-*-* 04:17:00
RandomizedDelaySec=1h
Persistent=true
Unit=${UPDATE_SERVICE_NAME}

[Install]
WantedBy=timers.target
`;

  const rollback =
    options.packageManager === 'pnpm'
      ? `${shellQuote(options.packageManager)} add -g --ignore-scripts "${options.packageName}@$PREVIOUS_VERSION"`
      : `${shellQuote(options.packageManager)} install -g --ignore-scripts "${options.packageName}@$PREVIOUS_VERSION"`;
  const packageManagerEnvironment =
    options.packageManager === 'pnpm'
      ? `export PNPM_HOME=${shellQuote(path.dirname(options.wstackBin))}\n`
      : '';
  const updateScript = `#!/bin/sh
# ${MANAGED_MARKER}
set -eu

WSTACK_BIN=${shellQuote(options.wstackBin)}
PACKAGE_MANAGER=${shellQuote(options.packageManager)}
SERVICE=${shellQuote(SERVICE_NAME)}
export PATH=${shellQuote(`${path.dirname(options.wstackBin)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)}
${packageManagerEnvironment}

version_of() {
  "$WSTACK_BIN" --version 2>/dev/null | sed -n 's/^WrongStack \\([^ ]*\\).*/\\1/p' | head -n 1
}

CHECK_OUTPUT=$("$WSTACK_BIN" update --check-only --pm "$PACKAGE_MANAGER") || {
  printf '%s\\n' "$CHECK_OUTPUT" >&2
  exit 1
}
printf '%s\\n' "$CHECK_OUTPUT"
if ! printf '%s\\n' "$CHECK_OUTPUT" | grep -q '^Update available:'; then
  exit 0
fi

PREVIOUS_VERSION=$(version_of)
if [ -z "$PREVIOUS_VERSION" ] || [ "$PREVIOUS_VERSION" = "dev" ]; then
  echo "Cannot determine an installed release version; refusing unattended update." >&2
  exit 1
fi

SERVICE_STOPPED=0
ensure_started() {
  if [ "$SERVICE_STOPPED" -eq 1 ]; then
    systemctl start "$SERVICE" || true
  fi
}
trap ensure_started EXIT INT TERM

systemctl stop "$SERVICE"
SERVICE_STOPPED=1
if ! "$WSTACK_BIN" update --pm "$PACKAGE_MANAGER"; then
  echo "Update failed; reinstalling WrongStack $PREVIOUS_VERSION." >&2
  ${rollback}
  exit 1
fi

UPDATED_VERSION=$(version_of)
if [ -z "$UPDATED_VERSION" ] || [ "$UPDATED_VERSION" = "$PREVIOUS_VERSION" ]; then
  echo "Updated binary did not report a new release; rolling back." >&2
  ${rollback}
  exit 1
fi

systemctl start "$SERVICE"
SERVICE_STOPPED=0
sleep 10
if ! systemctl is-active --quiet "$SERVICE"; then
  echo "Updated HQ did not stay active; rolling back to $PREVIOUS_VERSION." >&2
  systemctl stop "$SERVICE" || true
  SERVICE_STOPPED=1
  ${rollback}
  systemctl start "$SERVICE"
  SERVICE_STOPPED=0
  sleep 5
  systemctl is-active --quiet "$SERVICE"
  exit 1
fi

echo "WrongStack HQ updated: $PREVIOUS_VERSION -> $UPDATED_VERSION"
`;

  const environment = [
    `# ${MANAGED_MARKER}`,
    `WRONGSTACK_HQ_PASSWORD=${envQuote(options.password)}`,
    'WRONGSTACK_HQ_BOOTSTRAP_PASSWORD_ONLY=1',
    ...(options.publicOrigin ? [`WRONGSTACK_HQ_PUBLIC_URL=${envQuote(options.publicOrigin)}`] : []),
    ...(options.ipAllowlist ? [`WRONGSTACK_HQ_ALLOWLIST=${envQuote(options.ipAllowlist)}`] : []),
  ].join('\n');

  return { service, updateService, updateTimer, updateScript, environment: `${environment}\n` };
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'pipe',
      windowsHide: true,
      env: buildChildEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function systemctl(args: string[], allowFailure = false): Promise<CommandResult> {
  const result = await runCommand('systemctl', args);
  if (!allowFailure && result.code !== 0) {
    throw new Error(result.stderr.trim() || `systemctl ${args.join(' ')} failed`);
  }
  return result;
}

async function writeManagedFile(file: string, content: string, mode: number): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode });
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, file);
}

async function hasForeignManagedTarget(file: string): Promise<boolean> {
  try {
    const content = await fs.readFile(file, 'utf8');
    return !content.includes(MANAGED_MARKER);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return undefined;
}

async function findSystemExecutable(name: string): Promise<string | undefined> {
  for (const directory of ['/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through system executable locations.
    }
  }
  return undefined;
}

function requireLinuxRoot(deps: Pick<SubcommandDeps, 'renderer'>): boolean {
  if (process.platform !== 'linux') {
    deps.renderer.writeError('HQ system service management is supported only on Linux/systemd.\n');
    return false;
  }
  if (process.getuid?.() !== 0) {
    deps.renderer.writeError('Run this command as root (for example with sudo).\n');
    return false;
  }
  return true;
}

function serviceHelp(deps: Pick<SubcommandDeps, 'renderer'>): void {
  deps.renderer.write(
    'Usage:\n' +
      '  sudo -E wstack hq service install [--port 3499] [--pm npm|pnpm] [--no-auto-update]\n' +
      '  wstack hq service status\n' +
      '  sudo wstack hq service update\n' +
      '  sudo wstack hq service uninstall\n\n' +
      'Install requires WRONGSTACK_HQ_PASSWORD (minimum 8 characters).\n' +
      'Options: --port <n>, --hq-allowlist <ip,cidr,...>, --pm npm|pnpm, ' +
      '--wstack-bin <path>, --no-auto-update, --force.\n',
  );
}

async function installService(deps: SubcommandDeps): Promise<number> {
  if (!requireLinuxRoot(deps)) return 1;
  let password: string | undefined;
  try {
    password = await resolveHqPasswordInput();
  } catch (cause) {
    deps.renderer.writeError(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  if (!password || password.length < 8) {
    deps.renderer.writeError(
      'Set WRONGSTACK_HQ_PASSWORD to at least 8 characters; it will be stored root-only.\n',
    );
    return 1;
  }
  const portValue = deps.flags?.['port'];
  const port = typeof portValue === 'string' ? Number(portValue) : 3499;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    deps.renderer.writeError('--port must be an integer between 1 and 65535.\n');
    return 1;
  }
  const requestedManager = deps.flags?.['pm'] ?? deps.flags?.['package-manager'];
  const detectedManager =
    typeof requestedManager === 'string' ? requestedManager : detectUpdatePackageManager();
  if (detectedManager !== 'npm' && detectedManager !== 'pnpm') {
    deps.renderer.writeError('HQ unattended updates support --pm npm or --pm pnpm.\n');
    return 1;
  }
  if (!(await findSystemExecutable(detectedManager))) {
    deps.renderer.writeError(
      `Could not find system-wide ${detectedManager}; unattended root updates cannot use a home-directory shim.\n`,
    );
    return 1;
  }
  const explicitBin = deps.flags?.['wstack-bin'];
  const wstackBin =
    typeof explicitBin === 'string' ? path.resolve(explicitBin) : await findExecutable('wstack');
  if (!wstackBin) {
    deps.renderer.writeError('Could not find a global wstack executable in PATH.\n');
    return 1;
  }
  const resolvedWstackBin = await fs.realpath(wstackBin).catch(() => wstackBin);
  if (
    resolvedWstackBin === '/root' ||
    resolvedWstackBin.startsWith('/root/') ||
    resolvedWstackBin.startsWith('/home/')
  ) {
    deps.renderer.writeError(
      'The HQ system service requires a system-wide wstack executable outside /root and /home. ' +
        'Install with `sudo npm install -g wrongstack` and retry.\n',
    );
    return 1;
  }
  const publicOriginValue =
    typeof deps.flags?.['hq-public-url'] === 'string'
      ? deps.flags['hq-public-url']
      : process.env.WRONGSTACK_HQ_PUBLIC_URL;
  let publicOrigin: string | undefined;
  if (publicOriginValue) {
    try {
      const parsed = new URL(publicOriginValue);
      if (parsed.protocol !== 'https:' || parsed.origin !== publicOriginValue.replace(/\/$/, '')) {
        throw new Error('not an exact HTTPS origin');
      }
      publicOrigin = parsed.origin;
    } catch {
      deps.renderer.writeError('--hq-public-url must be an exact HTTPS origin.\n');
      return 1;
    }
  }
  const allowlistValue =
    typeof deps.flags?.['hq-allowlist'] === 'string'
      ? deps.flags['hq-allowlist']
      : process.env.WRONGSTACK_HQ_ALLOWLIST;
  let ipAllowlist: string | undefined;
  if (allowlistValue !== undefined && allowlistValue.trim() !== '') {
    try {
      const { parseHqIpAllowlist } = await import('./hq-server/ip-allowlist.js');
      ipAllowlist = parseHqIpAllowlist(allowlistValue)?.join(',');
    } catch (cause) {
      deps.renderer.writeError(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
  }

  const assets = renderHqServiceAssets({
    wstackBin,
    packageManager: detectedManager,
    packageName: detectUpdatePackageName(),
    password,
    port,
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(ipAllowlist ? { ipAllowlist } : {}),
  });
  try {
    await fs.access('/run/systemd/system');
    const systemd = await systemctl(['--version'], true);
    if (systemd.code !== 0) throw new Error('systemctl is not operational');
  } catch {
    deps.renderer.writeError('This host is not running systemd; no service files were written.\n');
    return 1;
  }
  const managedTargets = [
    `${SYSTEMD_DIR}/${SERVICE_NAME}`,
    `${SYSTEMD_DIR}/${UPDATE_SERVICE_NAME}`,
    `${SYSTEMD_DIR}/${UPDATE_TIMER_NAME}`,
    UPDATE_SCRIPT,
    ENV_FILE,
  ];
  if (deps.flags?.['force'] !== true) {
    const foreign = [];
    for (const file of managedTargets) {
      if (await hasForeignManagedTarget(file)) foreign.push(file);
    }
    if (foreign.length > 0) {
      deps.renderer.writeError(
        `Refusing to overwrite files not managed by WrongStack:\n${foreign.map((file) => `  ${file}`).join('\n')}\nUse --force only after reviewing them.\n`,
      );
      return 1;
    }
  }
  await fs.mkdir(ENV_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(UPDATE_SCRIPT), { recursive: true, mode: 0o755 });
  await writeManagedFile(ENV_FILE, assets.environment, 0o600);
  await writeManagedFile(`${SYSTEMD_DIR}/${SERVICE_NAME}`, assets.service, 0o644);
  await writeManagedFile(`${SYSTEMD_DIR}/${UPDATE_SERVICE_NAME}`, assets.updateService, 0o644);
  await writeManagedFile(`${SYSTEMD_DIR}/${UPDATE_TIMER_NAME}`, assets.updateTimer, 0o644);
  await writeManagedFile(UPDATE_SCRIPT, assets.updateScript, 0o755);
  await systemctl(['daemon-reload']);
  await systemctl(['enable', SERVICE_NAME]);
  await systemctl(['restart', SERVICE_NAME]);
  if (deps.flags?.['no-auto-update'] === true) {
    await systemctl(['disable', '--now', UPDATE_TIMER_NAME], true);
  } else {
    await systemctl(['enable', '--now', UPDATE_TIMER_NAME]);
  }
  deps.renderer.write(
    `Installed ${SERVICE_NAME}; listening on ${publicOrigin ? '127.0.0.1' : '0.0.0.0'}:${port}, boot persistence and automatic restart are active.\n` +
      (ipAllowlist
        ? `Network allowlist is active (${ipAllowlist.split(',').length} configured rules + loopback).\n`
        : 'Network allowlist is disabled; password authentication remains active.\n') +
      (deps.flags?.['no-auto-update'] === true
        ? 'Automatic updates are disabled.\n'
        : `Automatic updates are scheduled by ${UPDATE_TIMER_NAME}.\n`),
  );
  return 0;
}

async function uninstallService(deps: SubcommandDeps): Promise<number> {
  if (!requireLinuxRoot(deps)) return 1;
  const targets = [
    `${SYSTEMD_DIR}/${SERVICE_NAME}`,
    `${SYSTEMD_DIR}/${UPDATE_SERVICE_NAME}`,
    `${SYSTEMD_DIR}/${UPDATE_TIMER_NAME}`,
    UPDATE_SCRIPT,
  ];
  const timerIsForeign = await hasForeignManagedTarget(`${SYSTEMD_DIR}/${UPDATE_TIMER_NAME}`);
  const serviceIsForeign = await hasForeignManagedTarget(`${SYSTEMD_DIR}/${SERVICE_NAME}`);
  if (!timerIsForeign) await systemctl(['disable', '--now', UPDATE_TIMER_NAME], true);
  if (!serviceIsForeign) await systemctl(['disable', '--now', SERVICE_NAME], true);
  const preserved: string[] = [];
  for (const file of targets) {
    if (await hasForeignManagedTarget(file)) {
      preserved.push(file);
      continue;
    }
    await fs.rm(file, { force: true });
  }
  await systemctl(['daemon-reload']);
  deps.renderer.write(
    `Removed WrongStack-managed HQ systemd files. Data and ${ENV_FILE} were preserved.\n`,
  );
  if (preserved.length > 0) {
    deps.renderer.write(
      `Preserved files not managed by WrongStack:\n${preserved.map((file) => `  ${file}`).join('\n')}\n`,
    );
  }
  return 0;
}

export const hqServiceCmd: SubcommandHandler = async (args, deps) => {
  const action = args[0];
  if (deps.flags?.['help'] === true || action === 'help' || !action) {
    serviceHelp(deps);
    return 0;
  }
  try {
    if (action === 'install') return await installService(deps);
    if (action === 'uninstall') return await uninstallService(deps);
    if (action === 'update') {
      if (!requireLinuxRoot(deps)) return 1;
      const result = await systemctl(['start', UPDATE_SERVICE_NAME]);
      if (result.stdout) deps.renderer.write(result.stdout);
      deps.renderer.write('HQ update check completed.\n');
      return 0;
    }
    if (action === 'status') {
      if (process.platform !== 'linux') {
        deps.renderer.writeError('HQ system service status is supported only on Linux/systemd.\n');
        return 1;
      }
      const result = await systemctl(
        ['status', SERVICE_NAME, UPDATE_TIMER_NAME, '--no-pager'],
        true,
      );
      deps.renderer.write(result.stdout || result.stderr);
      return result.code ?? 1;
    }
  } catch (cause) {
    deps.renderer.writeError(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  deps.renderer.writeError(`Unknown HQ service action: ${action}\n`);
  serviceHelp(deps);
  return 1;
};
