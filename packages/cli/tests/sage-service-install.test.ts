import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installWrongMemory,
  runSageServiceCommand,
  type ServiceIo,
} from '../src/subcommands/handlers/sage-service.js';
import type { SubcommandDeps } from '../src/subcommands/contracts.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const BODY: Record<string, string> = {
  'wrongmemory-windows-x64.exe': 'cli-bytes',
  'wrongmemoryd-windows-x64.exe': 'daemon-bytes',
  'wrongmemory-linux-x64': 'linux-cli-bytes',
  'wrongmemoryd-linux-x64': 'linux-daemon-bytes',
  'wrongmemory-darwin-arm64': 'mac-cli-bytes',
  'wrongmemoryd-darwin-arm64': 'mac-daemon-bytes',
};

function fakeIo(options: {
  sums?: string;
  digest?: (name: string) => string | undefined;
  status?: number;
}): ServiceIo & { ran: Array<{ exe: string; args: string[]; staged: string[] }> } {
  const ran: Array<{ exe: string; args: string[]; staged: string[] }> = [];
  const url = (name: string) => `https://example.invalid/${name}`;
  return {
    ran,
    fetchRelease: async () => ({
      tag_name: 'v0.2.0',
      assets: [
        ...Object.keys(BODY).map((name) => ({
          name,
          browser_download_url: url(name),
          digest: options.digest?.(name),
        })),
        { name: 'SHA256SUMS', browser_download_url: url('SHA256SUMS') },
      ],
    }),
    downloadText: async () =>
      options.sums ??
      Object.entries(BODY)
        .map(([n, b]) => `${sha(b)}  ${n}`)
        .join('\n'),
    download: async (u, file) => {
      const body = BODY[u.split('/').pop()!]!;
      writeFileSync(file, body);
      return sha(body);
    },
    run: (exe, args) => {
      const dir = path.dirname(exe);
      ran.push({
        exe,
        args,
        staged: (exe.endsWith('.exe')
          ? ['wrongmemory.exe', 'wrongmemoryd.exe']
          : ['wrongmemory', 'wrongmemoryd']
        ).map((f) =>
          existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '',
        ),
      });
      const status = options.status ?? 0;
      return {
        status,
        stdout: status === 0 ? JSON.stringify({ prefix: 'C:\\x\\WrongMemory\\bin' }) : '',
        stderr: status === 0 ? '' : 'daemon running',
      };
    },
  };
}

const win = { platform: 'win32' as const, arch: 'x64' };

describe('installWrongMemory', () => {
  it("stages both checksum-verified executables and runs WrongMemory's own installer", async () => {
    const io = fakeIo({ digest: (n) => `sha256:${sha(BODY[n]!)}` });
    const report = await installWrongMemory({ ...win, stopDaemon: false, io });
    expect(report).toMatchObject({
      source: 'WrongStack/wrongmemory@v0.2.0',
      prefix: 'C:\\x\\WrongMemory\\bin',
    });
    expect(io.ran).toHaveLength(1);
    expect(path.basename(io.ran[0]!.exe)).toBe('wrongmemory.exe');
    expect(io.ran[0]!.args).toEqual(['install', '--json']);
    expect(io.ran[0]!.staged).toEqual(['cli-bytes', 'daemon-bytes']);
    // The staging directory is removed afterwards.
    expect(existsSync(path.dirname(io.ran[0]!.exe))).toBe(false);
  });

  it('refuses a download that does not match SHA256SUMS, before installing', async () => {
    const io = fakeIo({ sums: `${'0'.repeat(64)}  wrongmemory-windows-x64.exe` });
    await expect(installWrongMemory({ ...win, stopDaemon: false, io })).rejects.toThrow(
      /checksum does not match the release SHA256SUMS/,
    );
    expect(io.ran).toHaveLength(0);
  });

  it('refuses a download that does not match the digest GitHub recorded', async () => {
    const io = fakeIo({ digest: () => `sha256:${'f'.repeat(64)}` });
    await expect(installWrongMemory({ ...win, stopDaemon: false, io })).rejects.toThrow(
      /digest GitHub recorded/,
    );
    expect(io.ran).toHaveLength(0);
  });

  it('explains a running daemon and passes --stop-daemon when asked', async () => {
    await expect(
      installWrongMemory({ ...win, stopDaemon: false, io: fakeIo({ status: 6 }) }),
    ).rejects.toThrow(/--stop-daemon/);
    const io = fakeIo({});
    await installWrongMemory({ ...win, stopDaemon: true, io });
    expect(io.ran[0]!.args).toEqual(['install', '--json', '--stop-daemon']);
  });

  it('installs the Linux x64 and macOS arm64 assets under their Unix names', async () => {
    for (const [platform, arch, cli, daemon] of [
      ['linux', 'x64', 'linux-cli-bytes', 'linux-daemon-bytes'],
      ['darwin', 'arm64', 'mac-cli-bytes', 'mac-daemon-bytes'],
    ] as const) {
      const io = fakeIo({ digest: (n) => `sha256:${sha(BODY[n]!)}` });
      await installWrongMemory({ platform, arch, stopDaemon: false, io });
      expect(io.ran).toHaveLength(1);
      expect(path.basename(io.ran[0]!.exe)).toBe('wrongmemory');
      expect(io.ran[0]!.staged).toEqual([cli, daemon]);
    }
  });

  it('checks the Unix assets against SHA256SUMS too', async () => {
    const io = fakeIo({ sums: `${'0'.repeat(64)}  wrongmemory-linux-x64` });
    await expect(
      installWrongMemory({ platform: 'linux', arch: 'x64', stopDaemon: false, io }),
    ).rejects.toThrow(/checksum does not match the release SHA256SUMS/);
    expect(io.ran).toHaveLength(0);
  });

  it('refuses platforms WrongMemory does not ship for', async () => {
    for (const [platform, arch] of [
      ['linux', 'arm64'],
      ['darwin', 'x64'],
      ['win32', 'arm64'],
    ] as const) {
      await expect(
        installWrongMemory({ platform, arch, stopDaemon: false, io: fakeIo({}) }),
      ).rejects.toThrow(/Windows x64, Linux x64 and macOS arm64/);
    }
  });
});

const SHIPPED = ['win32-x64', 'linux-x64', 'darwin-arm64'].includes(
  `${process.platform}-${process.arch}`,
);

describe.skipIf(!SHIPPED)('wstack sage service install: the memory service mode', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A local build directory (`--from`), a profile config path and deps. */
  const setup = (profileContent?: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wm-install-cmd-'));
    dirs.push(dir);
    const build = path.join(dir, 'build');
    const profileDir = path.join(dir, 'profile');
    const profile = path.join(profileDir, 'config.json');
    const suffix = process.platform === 'win32' ? '.exe' : '';
    mkdirSync(build, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    for (const exe of ['wrongmemory', 'wrongmemoryd']) {
      writeFileSync(path.join(build, `${exe}${suffix}`), 'bytes');
    }
    if (profileContent !== undefined) writeFileSync(profile, profileContent);
    const write = vi.fn();
    const deps = {
      config: {},
      renderer: { write, writeError: vi.fn() },
      paths: { profileConfig: () => profile },
      projectRoot: dir,
      cwd: dir,
      userHome: dir,
    } as never as SubcommandDeps;
    const output = () => write.mock.calls.map((c) => String(c[0])).join('');
    const read = () => JSON.parse(readFileSync(profile, 'utf8'));
    return { build, profile, profileDir, deps, output, read, io: fakeIo({}) };
  };

  it('makes WrongMemory the memory service of a profile without a mode, keeping its other settings', async () => {
    const t = setup(
      JSON.stringify({
        model: 'm',
        Sage: { storage: { directory: '.wrongstack/memories' }, service: { startPolicy: 'never' } },
      }),
    );
    expect(await runSageServiceCommand(['install', '--from', t.build], t.deps, t.io)).toBe(0);
    expect(t.io.ran).toHaveLength(1);
    expect(t.read()).toEqual({
      model: 'm',
      Sage: {
        storage: { directory: '.wrongstack/memories' },
        service: { startPolicy: 'never', mode: 'wrongmemory' },
      },
    });
    // The previous content is kept as a config backup.
    expect(JSON.parse(readFileSync(`${t.profile}.last`, 'utf8'))).toMatchObject({ model: 'm' });
    expect(t.output()).toContain(`SAGE memory service: wrongmemory (set in ${t.profile})`);
  });

  it('creates the profile config when there is none yet', async () => {
    const t = setup();
    expect(await runSageServiceCommand(['install', '--from', t.build], t.deps, t.io)).toBe(0);
    expect(t.read()).toEqual({ Sage: { service: { mode: 'wrongmemory' } } });
  });

  it('never overwrites a mode the profile chose, local included, and leaves the file untouched', async () => {
    for (const mode of ['local', 'auto', 'wrongmemory']) {
      const text = JSON.stringify({ Sage: { service: { mode } } });
      const t = setup(text);
      const before = statSync(t.profile).mtimeMs;
      expect(
        await runSageServiceCommand(['install', '--from', t.build, '--json'], t.deps, t.io),
      ).toBe(0);
      expect(JSON.parse(t.output())).toMatchObject({
        mode: { mode, changed: false, configFile: t.profile },
      });
      expect(readFileSync(t.profile, 'utf8')).toBe(text);
      expect(statSync(t.profile).mtimeMs).toBe(before);
      expect(readdirSync(t.profileDir)).toEqual(['config.json']);
    }
  });

  it('leaves the config alone with --keep-mode', async () => {
    const t = setup();
    expect(
      await runSageServiceCommand(['install', '--from', t.build, '--keep-mode'], t.deps, t.io),
    ).toBe(0);
    expect(existsSync(t.profile)).toBe(false);
    expect(t.output()).toContain('Next: wstack sage service use wrongmemory');
  });

  it('reports a corrupt profile config without overwriting it or failing the finished install', async () => {
    const t = setup('{ not json');
    expect(await runSageServiceCommand(['install', '--from', t.build], t.deps, t.io)).toBe(0);
    expect(t.io.ran).toHaveLength(1);
    expect(readFileSync(t.profile, 'utf8')).toBe('{ not json');
    expect(t.output()).toMatch(/SAGE memory service not changed: .*not valid JSON/);
  });

  it('does not touch the config when the install fails', async () => {
    const t = setup();
    expect(
      await runSageServiceCommand(['install', '--from', t.build], t.deps, fakeIo({ status: 1 })),
    ).toBe(1);
    expect(existsSync(t.profile)).toBe(false);
  });
});
