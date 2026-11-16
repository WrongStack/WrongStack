/**
 * `wstack remote`: parsing the target, picking the build for the remote
 * machine, and the sh scripts run there (checked by running them with a real
 * POSIX shell where one is available).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTargetFor,
  parseProbe,
  parseRemoteTarget,
  probeScript,
  startScript,
  stopScript,
} from '../src/remote/remote-target.js';

describe('parseRemoteTarget', () => {
  it('reads scp-style and ssh:// targets', () => {
    expect(parseRemoteTarget('dev@box:/srv/app')).toEqual({
      destination: 'dev@box',
      path: '/srv/app',
    });
    expect(parseRemoteTarget('box:~/code')).toEqual({ destination: 'box', path: '~/code' });
    expect(parseRemoteTarget('ssh://dev@box:2222/srv/my%20app')).toEqual({
      destination: 'dev@box',
      port: 2222,
      path: '/srv/my app',
    });
  });

  it('refuses a host that ssh would read as an option (H-2)', () => {
    expect(() => parseRemoteTarget('-oProxyCommand=calc:/srv')).toThrow('cannot start with "-"');
    expect(() => parseRemoteTarget('ssh://-oProxyCommand=x@h/srv')).toThrow();
  });

  it('requires a host and a project directory', () => {
    expect(() => parseRemoteTarget('box')).toThrow('user@host:/path');
    expect(() => parseRemoteTarget('box:')).toThrow('user@host:/path');
    expect(() => parseRemoteTarget(':/srv')).toThrow('user@host:/path');
    expect(() => parseRemoteTarget('ssh://box')).toThrow('project directory');
  });
});

describe('buildTargetFor', () => {
  it('maps uname output and libc to a release build', () => {
    expect(buildTargetFor('Linux', 'x86_64', false)).toBe('bun-linux-x64');
    expect(buildTargetFor('Linux', 'aarch64', true)).toBe('bun-linux-arm64-musl');
    expect(buildTargetFor('Darwin', 'arm64', false)).toBe('bun-darwin-arm64');
  });

  it('refuses machines there is no build for', () => {
    expect(() => buildTargetFor('Linux', 'riscv64', false)).toThrow('riscv64');
    expect(() => buildTargetFor('FreeBSD', 'amd64', false)).toThrow('not supported');
  });
});

describe('parseProbe', () => {
  it('reads the machine, installed versions and a running server', () => {
    const probe = parseProbe(
      [
        'os=Linux',
        'arch=x86_64',
        'musl=1',
        'path=1',
        'version=1.0.0',
        'version=build-abc',
        'server={"pid":42,"port":3457,"version":"1.0.0"}',
        'token=t0k=en',
      ].join('\n'),
    );
    expect(probe).toEqual({
      os: 'Linux',
      arch: 'x86_64',
      musl: true,
      pathExists: true,
      versions: ['1.0.0', 'build-abc'],
      server: { pid: 42, port: 3457, version: '1.0.0', token: 't0k=en' },
    });
  });

  it('ignores a server line it cannot use', () => {
    expect(parseProbe('path=0\nserver={broken\ntoken=x').server).toBeUndefined();
    expect(parseProbe('server={"pid":1,"port":2,"version":"v"}').server).toBeUndefined();
  });
});

function posixShell(): string | undefined {
  for (const candidate of ['sh', 'C:\\Program Files\\Git\\bin\\sh.exe']) {
    try {
      execFileSync(candidate, ['-c', 'true'], { stdio: 'ignore', windowsHide: true });
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return undefined;
}

const sh = posixShell();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(sh)('the remote scripts in a real shell', () => {
  const run = (script: string, home: string) =>
    execFileSync(sh as string, ['-s'], {
      input: script,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      windowsHide: true,
    });

  it('probe reports the directory and no server; stop is a no-op without one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-remote-'));
    dirs.push(home);
    const project = path.join(home, `it's here`);
    fs.mkdirSync(project);
    const probe = parseProbe(run(probeScript(`~/it's here`), home));
    expect(probe.pathExists).toBe(true);
    expect(probe.server).toBeUndefined();
    expect(parseProbe(run(probeScript('~/missing'), home)).pathExists).toBe(false);
    expect(run(stopScript(`~/it's here`), home)).toBe('');
  });

  /** Where the scripts keep the state for `~/p` (same key recipe as the scripts). */
  const STATE_FOR_P = `servers="$HOME/.wrongstack/remote/servers"
mkdir -p "$servers"
key=$(printf '%s' "$(cd "$HOME/p" && pwd -P)" | cksum | tr ' ' '-')`;

  it('probe finds the state a start left and stop clears it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-remote-'));
    dirs.push(home);
    fs.mkdirSync(path.join(home, 'p'));
    const servers = path.join(home, '.wrongstack', 'remote', 'servers');
    // The shell itself stands in for a live server process.
    const script = `${STATE_FOR_P}
printf '{"pid":%s,"port":4000,"version":"9.9.9"}' "$$" > "$servers/$key.json"
printf 'tok' > "$servers/$key.token"
${probeScript('~/p')}`;
    expect(parseProbe(run(script, home)).server).toMatchObject({
      port: 4000,
      version: '9.9.9',
      token: 'tok',
    });
    run(
      `${STATE_FOR_P}\nprintf '{"pid":999999,"port":4000,"version":"x"}' > "$servers/$key.json"`,
      home,
    );
    expect(run(stopScript('~/p'), home)).toBe('stopped=1\n');
    expect(fs.readdirSync(servers)).toEqual([]);
  });

  // H-1 (security-check 2026-09-26): the state used to live in the project
  // directory, which another user (or the repository itself) can write. Whoever
  // wrote it chose the port the client tunnelled the browser to.
  it('ignores server state planted in the project directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-remote-'));
    dirs.push(home);
    const planted = path.join(home, 'p', '.wrongstack');
    fs.mkdirSync(planted, { recursive: true });
    const script = `printf '{"pid":%s,"port":4000,"version":"9.9.9"}' "$$" > "$HOME/p/.wrongstack/remote-webui.json"
printf 'tok' > "$HOME/p/.wrongstack/remote-webui.token"
${probeScript('~/p')}`;
    expect(parseProbe(run(script, home)).server).toBeUndefined();
  });

  /** A home with a fake build that behaves like the host with no provider set up. */
  function homeWithBuild(body: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wst-remote-'));
    dirs.push(home);
    fs.mkdirSync(path.join(home, 'p'));
    const bin = path.join(home, '.wrongstack', 'remote');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'wstack-t'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return home;
  }

  it.each([
    'No provider or model configured. Run `wstack auth`.',
    'Saved provider/model is no longer usable (provider "x" has no usable key).',
  ])('start falls back to setup mode when the host says: %s', (refusal) => {
    const home = homeWithBuild(`echo "$WEBUI_TOKEN $*" > "$HOME/args"
case "$*" in
  *--provider*) echo "WebUI running at http://127.0.0.1:3999"; exec sleep 30 ;;
  *) echo '${refusal}'; exit 2 ;;
esac`);
    const out = run(
      startScript({ path: '~/p', version: 't', token: 's3cret', preferredPort: 3456 }),
      home,
    );
    try {
      expect(out).toMatch(/^setup=1\nport=3999\npid=\d+\n$/);
      expect(fs.readFileSync(path.join(home, 'args'), 'utf8').trim()).toBe(
        's3cret --webui --host 127.0.0.1 --port 3456 --provider wrongstack-setup --model no-api-key',
      );
      expect(parseProbe(run(probeScript('~/p'), home)).server).toMatchObject({
        port: 3999,
        version: 't',
        token: 's3cret',
      });
    } finally {
      run(stopScript('~/p'), home);
    }
  });

  it('start reports why the host exited and leaves no token behind', () => {
    const home = homeWithBuild('echo "port 3456 is taken"; exit 1');
    let out = '';
    try {
      run(startScript({ path: '~/p', version: 't', token: 's3cret', preferredPort: 3456 }), home);
    } catch (err) {
      out = String((err as { stdout?: string }).stdout);
    }
    expect(out).toBe('error=exited\nlog=port 3456 is taken\n');
    const servers = path.join(home, '.wrongstack', 'remote', 'servers');
    expect(fs.readdirSync(servers).filter((name) => name.endsWith('.token'))).toEqual([]);
    expect(fs.existsSync(path.join(home, 'p', '.wrongstack'))).toBe(false);
  });

  it('throws a clean address error instead of raw URIError on malformed ssh:// percent-encoding', () => {
    expect(() => parseRemoteTarget('ssh://alice@example.com/my%ZZproj')).toThrow(
      'Not a valid ssh:// address',
    );
  });
});
