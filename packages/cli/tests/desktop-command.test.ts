import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { handleHelpVersionShortCircuit } from '../src/boot/short-circuit-flags.js';
import { launchDesktop, windowsStartCommand } from '../src/desktop/desktop-launch.js';
import type { DesktopInstall, DesktopLocation } from '../src/desktop/desktop-locate.js';
import {
  argsAfterDesktop,
  type DesktopSystem,
  runDesktopCommand,
} from '../src/subcommands/handlers/desktop.js';

const INSTALL: DesktopInstall = {
  source: 'installed',
  app: '/usr/bin/wrongstack-desktop-native',
  engine: '/usr/bin/wrongstack-engine',
};

function fakeSystem(overrides: Partial<DesktopSystem> = {}): DesktopSystem & {
  calls: string[];
} {
  const calls: string[] = [];
  const system: DesktopSystem = {
    platform: 'linux',
    arch: 'x64',
    cliVersion: '1.5.0',
    downloadDir: '/home/ada/.wrongstack/downloads/desktop',
    locate: (): DesktopLocation => ({ status: 'found', install: INSTALL }),
    installedVersion: () => undefined,
    launch: async (install) => {
      calls.push(`launch ${install.app}`);
    },
    linuxFormat: () => 'deb',
    download: async ({ version, assetName, dir }) => {
      calls.push(`download v${version} ${assetName}`);
      return `${dir}/${assetName}`;
    },
    runWindowsInstaller: async (setup, silent) => {
      calls.push(`setup ${setup}${silent ? ' /S' : ''}`);
      return 0;
    },
    openDiskImage: async (dmg) => {
      calls.push(`open ${dmg}`);
      return 0;
    },
    ...overrides,
  };
  return Object.assign(system, { calls });
}

async function run(args: string[], system: DesktopSystem): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await runDesktopCommand(args, {
    renderer: {
      write: (s: string) => {
        out += s;
      },
    },
    system,
  });
  return { code, out };
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('wstack desktop — arguments', () => {
  it('reads the raw argv after `desktop`, keeping --version <x> as a value', async () => {
    const system = fakeSystem();
    const args = argsAfterDesktop(['--verbose', 'desktop', 'install', '--version', '1.4.0']);
    expect((await run(args, system)).code).toBe(0);
    expect((await run(['update', '--version=v1.6.0', '--silent'], system)).code).toBe(0);
    expect(system.calls).toEqual([
      'download v1.4.0 wrongstack-desktop-1.4.0-linux-x64.deb',
      'download v1.6.0 wrongstack-desktop-1.6.0-linux-x64.deb',
    ]);
  });

  it('`--version <x>` after `desktop` is not the global version switch', async () => {
    expect(
      await handleHelpVersionShortCircuit(['desktop', 'install', '--version', '1.4.0']),
    ).toBeNull();
  });

  it.each([
    [['launch'], /Unknown desktop command: launch/],
    [['--force'], /Unknown desktop option: --force/],
    [['install', '--version'], /--version needs a release version/],
    [['install', '--version', 'latest'], /Not a release version: latest/],
    [['path', '--silent'], /install` and `update` only/],
    [['install', 'update'], /Unexpected argument: update/],
  ])('rejects %j as a usage error', async (args, message) => {
    const system = fakeSystem();
    const { code, out } = await run(args, system);
    expect(code).toBe(2);
    expect(out).toMatch(message);
    expect(out).toContain('Usage: wstack desktop');
    expect(system.calls).toEqual([]);
  });

  it('--help prints the usage without touching the system', async () => {
    const system = fakeSystem();
    const { code, out } = await run(['install', '--help'], system);
    expect(code).toBe(0);
    expect(out).toMatch(/^Usage: wstack desktop/);
    expect(system.calls).toEqual([]);
  });
});

describe('wstack desktop — open and path', () => {
  it('launches the located copy and returns', async () => {
    const system = fakeSystem();
    const { code, out } = await run([], system);
    expect(code).toBe(0);
    expect(system.calls).toEqual([`launch ${INSTALL.app}`]);
    expect(out).toContain('Opened WrongStack Desktop');
  });

  it('refuses to open a copy whose engine is missing', async () => {
    const system = fakeSystem({ locate: () => ({ status: 'engine-missing', install: INSTALL }) });
    const { code, out } = await run([], system);
    expect(code).toBe(1);
    expect(system.calls).toEqual([]);
    expect(out).toContain('/usr/bin/wrongstack-engine is missing');
    expect(out).toContain('wstack desktop install');
  });

  it('prints the install hint when nothing is installed', async () => {
    const system = fakeSystem({ locate: () => ({ status: 'not-installed', searched: [] }) });
    const { code, out } = await run([], system);
    expect(code).toBe(1);
    expect(out).toBe(
      'WrongStack Desktop is not installed.\nInstall it with: wstack desktop install\n',
    );
  });

  it('path prints both files, and flags a missing engine', async () => {
    const ok = await run(['path'], fakeSystem());
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(
      `app:    ${INSTALL.app}\nengine: ${INSTALL.engine}\nsource: installed\n`,
    );

    const broken = await run(
      ['path'],
      fakeSystem({ locate: () => ({ status: 'engine-missing', install: INSTALL }) }),
    );
    expect(broken.code).toBe(1);
    expect(broken.out).toContain(`engine: ${INSTALL.engine} (missing)`);
  });
});

describe('wstack desktop install', () => {
  it('Linux: downloads the verified package and prints the sudo command instead of running it', async () => {
    const system = fakeSystem();
    const { code, out } = await run(['install'], system);
    expect(code).toBe(0);
    expect(system.calls).toEqual(['download v1.5.0 wrongstack-desktop-1.5.0-linux-x64.deb']);
    expect(out).toContain(
      'sudo apt install /home/ada/.wrongstack/downloads/desktop/wrongstack-desktop-1.5.0-linux-x64.deb',
    );
  });

  it('Linux rpm systems get dnf, and a path with spaces is quoted', async () => {
    const system = fakeSystem({ linuxFormat: () => 'rpm', downloadDir: '/home/a b/dl' });
    const { out } = await run(['install', '--version', '1.4.0'], system);
    expect(system.calls).toEqual(['download v1.4.0 wrongstack-desktop-1.4.0-linux-x64.rpm']);
    expect(out).toContain("sudo dnf install '/home/a b/dl/wrongstack-desktop-1.4.0-linux-x64.rpm'");
  });

  it('Linux without dpkg or rpm downloads nothing', async () => {
    const system = fakeSystem({ linuxFormat: () => undefined });
    const { code, out } = await run(['install'], system);
    expect(code).toBe(1);
    expect(system.calls).toEqual([]);
    expect(out).toContain('releases/tag/v1.5.0');
  });

  it('Windows: runs the setup, /S only with --silent', async () => {
    const system = fakeSystem({ platform: 'win32', arch: 'arm64', downloadDir: 'C:\\dl' });
    expect((await run(['install'], system)).code).toBe(0);
    expect((await run(['install', '--silent'], system)).code).toBe(0);
    expect(system.calls).toEqual([
      'download v1.5.0 wrongstack-desktop-1.5.0-windows-arm64-setup.exe',
      'setup C:\\dl/wrongstack-desktop-1.5.0-windows-arm64-setup.exe',
      'download v1.5.0 wrongstack-desktop-1.5.0-windows-arm64-setup.exe',
      'setup C:\\dl/wrongstack-desktop-1.5.0-windows-arm64-setup.exe /S',
    ]);
  });

  it('Windows: a failing installer fails the command', async () => {
    const system = fakeSystem({ platform: 'win32', runWindowsInstaller: async () => 2 });
    const { code, out } = await run(['install'], system);
    expect(code).toBe(1);
    expect(out).toContain('exited with code 2');
  });

  it('macOS: opens the disk image and explains the drag to Applications', async () => {
    const system = fakeSystem({ platform: 'darwin', arch: 'arm64' });
    const { code, out } = await run(['install'], system);
    expect(code).toBe(0);
    expect(system.calls[1]).toMatch(/^open .*wrongstack-desktop-1\.5\.0-macos-arm64\.dmg$/);
    expect(out).toContain('Applications');
  });

  it('a refused download (checksum) installs nothing', async () => {
    const runWindowsInstaller = vi.fn(async () => 0);
    const system = fakeSystem({
      platform: 'win32',
      download: async () => {
        throw new Error('x does not match DESKTOP-SHA256SUMS');
      },
      runWindowsInstaller,
    });
    const { code, out } = await run(['install'], system);
    expect(code).toBe(1);
    expect(out).toContain('does not match DESKTOP-SHA256SUMS');
    expect(runWindowsInstaller).not.toHaveBeenCalled();
  });

  it('a dev build without a release version asks for --version', async () => {
    const system = fakeSystem({ cliVersion: 'dev' });
    const { code, out } = await run(['install'], system);
    expect(code).toBe(2);
    expect(out).toContain('pass --version <x>');
  });
});

describe('wstack desktop update', () => {
  it('does nothing when the installed copy is current', async () => {
    const system = fakeSystem({ installedVersion: () => '1.5.0' });
    const { code, out } = await run(['update'], system);
    expect(code).toBe(0);
    expect(system.calls).toEqual([]);
    expect(out).toContain('v1.5.0 is up to date');
  });

  it('installs when the installed copy is older', async () => {
    const system = fakeSystem({ installedVersion: () => '1.4.9' });
    const { out } = await run(['update'], system);
    expect(system.calls).toEqual(['download v1.5.0 wrongstack-desktop-1.5.0-linux-x64.deb']);
    expect(out).toContain('Updating WrongStack Desktop v1.4.9 to v1.5.0');
  });

  it('reinstalls with a note when the version cannot be read, or the engine is missing', async () => {
    const unknown = await run(['update'], fakeSystem());
    expect(unknown.out).toContain('Could not read the version');
    const broken = fakeSystem({
      installedVersion: () => '1.5.0',
      locate: () => ({ status: 'engine-missing', install: INSTALL }),
    });
    const repaired = await run(['update'], broken);
    expect(repaired.out).toContain('no engine beside it; reinstalling');
    expect(broken.calls).toHaveLength(1);
  });
});

describe('launchDesktop', () => {
  function fakeChild() {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    setImmediate(() => child.emit('spawn'));
    return child;
  }

  it('Windows starts the GUI through a hidden, detached cmd start with its own quoting', async () => {
    const children: Array<ReturnType<typeof fakeChild>> = [];
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    const app = 'C:\\Users\\ada\\AppData\\Local\\WrongStack Desktop\\wrongstack-desktop-native.exe';
    await launchDesktop({ ...INSTALL, app }, 'win32', {
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      WRONGSTACK_NODE_ENV_DEFAULTED: '1',
      NODE_ENV: 'production',
      KEEP: 'yes',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(args).toEqual(['/d', '/c', 'start', '""', `"${app}"`]);
    expect(options).toMatchObject({
      cwd: 'C:\\Users\\ada\\AppData\\Local\\WrongStack Desktop',
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      env: { KEEP: 'yes' },
    });
    // The NODE_ENV default this CLI injected for itself does not reach the app.
    expect(options.env).not.toHaveProperty('NODE_ENV');
    expect(children[0]?.unref).toHaveBeenCalled();
  });

  it('macOS opens the bundle; Linux runs the executable', async () => {
    spawnMock.mockImplementation(() => fakeChild());
    await launchDesktop(
      { ...INSTALL, bundle: '/Applications/WrongStack Desktop.app' },
      'darwin',
      {},
    );
    await launchDesktop(INSTALL, 'linux', {});
    expect(spawnMock.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['open', ['/Applications/WrongStack Desktop.app']],
      [INSTALL.app, []],
    ]);
  });

  it('rejects when the program cannot be started', async () => {
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    });
    await expect(launchDesktop(INSTALL, 'linux', {})).rejects.toThrow('ENOENT');
  });

  it('builds the installer command with /wait, and refuses paths cmd.exe would rewrite', () => {
    expect(windowsStartCommand('C:\\dl\\setup.exe', { wait: true, args: ['/S'] }).args).toEqual([
      '/d',
      '/c',
      'start',
      '""',
      '/wait',
      '"C:\\dl\\setup.exe"',
      '/S',
    ]);
    expect(() => windowsStartCommand('C:\\%TEMP%\\x.exe')).toThrow(/cmd\.exe would rewrite/);
  });
});
