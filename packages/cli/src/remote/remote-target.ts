/**
 * The pure half of `wstack remote`: where to connect, which build the remote
 * machine needs, and the POSIX sh scripts run there. No process is started
 * here, so all of it is testable without an SSH server.
 *
 * @module remote/remote-target
 */

export interface RemoteTarget {
  /** What `ssh` connects to: `user@host`, `host`, or a `~/.ssh/config` alias. */
  destination: string;
  port?: number | undefined;
  /** Project directory on the remote machine. */
  path: string;
}

/**
 * `user@host:/path`, `host:~/path`, or `ssh://user@host:2222/path`. The path
 * is required: it is the remote project the agent works in.
 */
export function parseRemoteTarget(input: string): RemoteTarget {
  const target = parseRemoteTargetText(input);
  // ssh reads a destination that starts with `-` as an option
  // (`-oProxyCommand=…` runs a local command). The spawn also passes `--`;
  // refusing it here gives a clear error instead of a confusing one (H-2).
  if (target.destination.startsWith('-')) {
    throw new Error(`A remote host cannot start with "-" (got ${target.destination})`);
  }
  return target;
}

function parseRemoteTargetText(input: string): RemoteTarget {
  const text = input.trim();
  if (text.startsWith('ssh://')) {
    let url: URL;
    let user: string;
    let path: string;
    try {
      url = new URL(text);
      user = url.username ? `${decodeURIComponent(url.username)}@` : '';
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new Error(`Not a valid ssh:// address: ${text}`);
    }
    if (!url.hostname || !path || path === '/') {
      throw new Error(`Give the remote project directory: ssh://user@host/path (got ${text})`);
    }
    return {
      destination: `${user}${url.hostname}`,
      ...(url.port ? { port: Number(url.port) } : {}),
      path,
    };
  }
  const colon = text.indexOf(':');
  const destination = colon > 0 ? text.slice(0, colon) : '';
  const path = colon > 0 ? text.slice(colon + 1) : '';
  if (!destination || !path || /\s/.test(destination)) {
    throw new Error(`Give the remote as user@host:/path/to/project (got ${text || 'nothing'})`);
  }
  return { destination, path };
}

/** One argument for a POSIX shell, single-quoted. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A remote path as a shell word: `~` and `~/…` expand to the remote home,
 * everything else is taken literally.
 */
function shPath(path: string): string {
  if (path === '~') return '"$HOME"';
  if (path.startsWith('~/')) return `"$HOME"/${shQuote(path.slice(2))}`;
  return shQuote(path);
}

/**
 * The build for a machine, from `uname -s`, `uname -m` and whether its libc is
 * musl. Windows hosts are not supported: the remote scripts are POSIX sh.
 */
export function buildTargetFor(os: string, arch: string, musl: boolean): string {
  const system = os.trim().toLowerCase();
  const machine = arch.trim().toLowerCase();
  const cpu =
    machine === 'x86_64' || machine === 'amd64'
      ? 'x64'
      : machine === 'aarch64' || machine === 'arm64'
        ? 'arm64'
        : undefined;
  if (!cpu) throw new Error(`No WrongStack build for a ${arch} remote machine.`);
  if (system === 'linux') return `bun-linux-${cpu}${musl ? '-musl' : ''}`;
  if (system === 'darwin') return `bun-darwin-${cpu}`;
  throw new Error(`Remote machines running ${os} are not supported (Linux and macOS are).`);
}

/** Where WrongStack keeps its builds on the remote machine, by version. */
const REMOTE_BIN_DIR = '"$HOME"/.wrongstack/remote';

/**
 * Sets `state`, `token_file` and `log` for the project at `path`.
 *
 * They live under the remote user's own `~/.wrongstack/remote/servers`, keyed
 * by the project's canonical path — not in the project directory. A project
 * directory can be shared with other users (or be a checkout of someone
 * else's repository), and whoever could write `.wrongstack/remote-webui.json`
 * there chose which loopback port this client tunnelled the user's browser to:
 * a fake "first-time setup" WebUI collecting the provider key (H-1,
 * security-check 2026-09-26). `cksum` is POSIX; `sha256sum` is not everywhere.
 */
function stateScript(path: string): string {
  return `dir=${shPath(path)}
abs=$(cd "$dir" 2>/dev/null && pwd -P) || abs=
key=$(printf '%s' "$abs" | cksum | tr ' ' '-')
state_dir=${REMOTE_BIN_DIR}/servers
state="$state_dir/$key.json"
token_file="$state_dir/$key.token"
log="$state_dir/$key.log"`;
}

export interface ProbeResult {
  os: string;
  arch: string;
  musl: boolean;
  pathExists: boolean;
  /** Versions already installed under `~/.wrongstack/remote`. */
  versions: string[];
  /** A server a previous run left running for this path. */
  server?: { pid: number; port: number; version: string; token: string } | undefined;
}

/** Reports the machine, the project path, the builds present and a running server. */
export function probeScript(path: string): string {
  return `set -u
printf 'os=%s\\n' "$(uname -s 2>/dev/null)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null)"
if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl=1; else echo musl=0; fi
${stateScript(path)}
if [ -d "$dir" ]; then echo path=1; else echo path=0; fi
for f in ${REMOTE_BIN_DIR}/wstack-*; do
  [ -x "$f" ] && printf 'version=%s\\n' "\${f##*/wstack-}"
done
if [ -n "$abs" ] && [ -f "$state" ] && [ -f "$token_file" ]; then
  pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$state")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    printf 'server=%s\\n' "$(tr -d '\\n' < "$state")"
    printf 'token=%s\\n' "$(cat "$token_file")"
  fi
fi
`;
}

export function parseProbe(output: string): ProbeResult {
  const values = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    values.set(key, [...(values.get(key) ?? []), line.slice(eq + 1)]);
  }
  const one = (key: string) => values.get(key)?.[0] ?? '';
  let server: ProbeResult['server'];
  try {
    const state = JSON.parse(one('server') || 'null') as {
      pid?: unknown;
      port?: unknown;
      version?: unknown;
    } | null;
    const token = one('token');
    if (
      state &&
      typeof state.pid === 'number' &&
      typeof state.port === 'number' &&
      typeof state.version === 'string' &&
      token
    ) {
      server = { pid: state.pid, port: state.port, version: state.version, token };
    }
  } catch {
    server = undefined;
  }
  return {
    os: one('os'),
    arch: one('arch'),
    musl: one('musl') === '1',
    pathExists: one('path') === '1',
    versions: values.get('version') ?? [],
    ...(server ? { server } : {}),
  };
}

/** The remote file a version's build lives in. */
function remoteBinaryPath(version: string): string {
  return `${REMOTE_BIN_DIR}/${shQuote(`wstack-${version}`)}`;
}

/**
 * Receives a build on stdin, makes it executable, and prints its SHA-256 so
 * the caller can compare it with what it sent. Run with `sh -c`.
 */
export function installScript(version: string): string {
  const target = remoteBinaryPath(version);
  return `set -eu
mkdir -p ${REMOTE_BIN_DIR}
chmod 700 ${REMOTE_BIN_DIR}
part=${REMOTE_BIN_DIR}/.upload-$$
cat > "$part"
chmod 700 "$part"
sum=$( (sha256sum "$part" 2>/dev/null || shasum -a 256 "$part") | cut -d' ' -f1)
mv -f "$part" ${target}
echo "sha256=$sum"
`;
}

/** What the WebUI host prints when it has no provider it can use. */
const NO_PROVIDER = ['No provider or model configured', 'Saved provider/model is no longer usable'];

/**
 * Starts the WebUI host for `path` detached from the SSH session (a dropped
 * connection must not end it), bound to the remote loopback only, and waits
 * for it to report its port. The token travels inside this script, which is
 * sent on stdin: it never appears on a command line another user can see.
 *
 * A remote machine WrongStack has not been set up on has no provider it can
 * use; the host is then started in setup mode, and one is chosen in the WebUI.
 */
export function startScript(options: {
  path: string;
  version: string;
  token: string;
  preferredPort: number;
}): string {
  const bin = remoteBinaryPath(options.version);
  return `set -u
umask 077
${stateScript(options.path)}
cd "$dir" || { echo error=path; exit 3; }
mkdir -p "$state_dir"
chmod 700 "$state_dir"
printf '%s' ${shQuote(options.token)} > "$token_file"
export WEBUI_TOKEN=${shQuote(options.token)}
launch() {
  : > "$log"
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid ${bin} --webui --host 127.0.0.1 --port ${options.preferredPort} "$@" > "$log" 2>&1 < /dev/null &
  else
    nohup ${bin} --webui --host 127.0.0.1 --port ${options.preferredPort} "$@" > "$log" 2>&1 < /dev/null &
  fi
  pid=$!
}
# 0: running and "port" is set, 1: the host exited, 2: no port in time.
await_port() {
  i=0
  while [ "$i" -lt 240 ]; do
    port=$(sed -n 's/.*WebUI running.*127\\.0\\.0\\.1:\\([0-9][0-9]*\\).*/\\1/p' "$log" | head -n 1)
    [ -n "$port" ] && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.5
    i=$((i + 1))
  done
  return 2
}
launch
await_port
status=$?
if [ "$status" -eq 1 ] && grep -q ${NO_PROVIDER.map((line) => `-e ${shQuote(line)}`).join(' ')} "$log"; then
  echo setup=1
  launch --provider wrongstack-setup --model no-api-key
  await_port
  status=$?
fi
if [ "$status" -eq 0 ]; then
  printf '{"pid":%s,"port":%s,"version":"%s"}\\n' "$pid" "$port" ${shQuote(options.version)} > "$state"
  echo "port=$port"
  echo "pid=$pid"
  exit 0
fi
rm -f "$token_file"
if [ "$status" -eq 1 ]; then
  echo error=exited
  tail -n 30 "$log" | sed 's/^/log=/'
  exit 4
fi
kill "$pid" 2>/dev/null
echo error=timeout
exit 5
`;
}

/** Stops the server a start left for `path`, if it is still running. */
export function stopScript(path: string): string {
  return `set -u
${stateScript(path)}
[ -n "$abs" ] && [ -f "$state" ] || exit 0
pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$state")
[ -n "$pid" ] && kill "$pid" 2>/dev/null
rm -f "$state" "$token_file"
echo stopped=1
`;
}
