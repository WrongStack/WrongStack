import { describe, expect, it } from 'vitest';
import { type DesktopHost, locateDesktop } from '../src/desktop/desktop-locate.js';
import {
  detectLinuxPackageFormat,
  readInstalledDesktopVersion,
  readWindowsInstallRecord,
} from '../src/desktop/desktop-system.js';

interface FakeMachine {
  platform: NodeJS.Platform;
  files?: string[];
  dirs?: string[];
  texts?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  installLocation?: string;
}

function host(machine: FakeMachine): DesktopHost {
  const texts = machine.texts ?? {};
  const files = new Set([...(machine.files ?? []), ...Object.keys(texts)]);
  const dirs = new Set(machine.dirs ?? []);
  const win = machine.platform === 'win32';
  return {
    platform: machine.platform,
    env: machine.env ?? {},
    cwd: machine.cwd ?? (win ? 'C:\\work' : '/work'),
    homeDir: machine.homeDir ?? (win ? 'C:\\Users\\ada' : '/home/ada'),
    isFile: (file) => files.has(file),
    isDirectory: (dir) => dirs.has(dir),
    readText: (file) => texts[file],
    ...(machine.installLocation !== undefined
      ? { windowsInstallLocation: () => machine.installLocation }
      : {}),
  };
}

const WIN_LOCAL = 'C:\\Users\\ada\\AppData\\Local';
const WIN_DEFAULT = `${WIN_LOCAL}\\WrongStack Desktop`;
const MAC_APP = '/Applications/WrongStack Desktop.app';
const MAC_EXE = `${MAC_APP}/Contents/MacOS`;

describe('locateDesktop — installed copies per platform', () => {
  it('Windows: finds the per-user NSIS install with its engine beside it', () => {
    const location = locateDesktop(
      host({
        platform: 'win32',
        env: { LOCALAPPDATA: WIN_LOCAL },
        files: [
          `${WIN_DEFAULT}\\wrongstack-desktop-native.exe`,
          `${WIN_DEFAULT}\\wrongstack-engine.exe`,
        ],
      }),
    );
    expect(location).toEqual({
      status: 'found',
      install: {
        source: 'installed',
        app: `${WIN_DEFAULT}\\wrongstack-desktop-native.exe`,
        engine: `${WIN_DEFAULT}\\wrongstack-engine.exe`,
      },
    });
  });

  it('Windows: the recorded InstallLocation wins over the default directory', () => {
    const custom = 'D:\\Apps\\WSD';
    const location = locateDesktop(
      host({
        platform: 'win32',
        env: { LOCALAPPDATA: WIN_LOCAL },
        installLocation: custom,
        files: [
          `${custom}\\wrongstack-desktop-native.exe`,
          `${custom}\\wrongstack-engine.exe`,
          `${WIN_DEFAULT}\\wrongstack-desktop-native.exe`,
          `${WIN_DEFAULT}\\wrongstack-engine.exe`,
        ],
      }),
    );
    expect(location.status).toBe('found');
    if (location.status === 'found')
      expect(location.install.app).toBe(`${custom}\\wrongstack-desktop-native.exe`);
  });

  it('Windows: without LOCALAPPDATA the default falls under the home directory', () => {
    const location = locateDesktop(host({ platform: 'win32' }));
    expect(location.status === 'not-installed' && location.searched[0]).toBe(
      `${WIN_DEFAULT}\\wrongstack-desktop-native.exe`,
    );
  });

  it('macOS: opens the .app bundle and checks the engine inside Contents/MacOS', () => {
    const location = locateDesktop(
      host({
        platform: 'darwin',
        files: [`${MAC_EXE}/wrongstack-desktop-native`, `${MAC_EXE}/wrongstack-engine`],
      }),
    );
    expect(location).toEqual({
      status: 'found',
      install: {
        source: 'installed',
        app: `${MAC_EXE}/wrongstack-desktop-native`,
        engine: `${MAC_EXE}/wrongstack-engine`,
        bundle: MAC_APP,
      },
    });
  });

  it('macOS: falls back to ~/Applications', () => {
    const userApp = '/Users/ada/Applications/WrongStack Desktop.app';
    const location = locateDesktop(
      host({
        platform: 'darwin',
        homeDir: '/Users/ada',
        files: [
          `${userApp}/Contents/MacOS/wrongstack-desktop-native`,
          `${userApp}/Contents/MacOS/wrongstack-engine`,
        ],
      }),
    );
    expect(location.status === 'found' && location.install.bundle).toBe(userApp);
  });

  it('Linux: the deb/rpm layout in /usr/bin', () => {
    const location = locateDesktop(
      host({
        platform: 'linux',
        files: ['/usr/bin/wrongstack-desktop-native', '/usr/bin/wrongstack-engine'],
      }),
    );
    expect(location).toEqual({
      status: 'found',
      install: {
        source: 'installed',
        app: '/usr/bin/wrongstack-desktop-native',
        engine: '/usr/bin/wrongstack-engine',
      },
    });
  });

  it('reports every searched path when nothing is installed', () => {
    const location = locateDesktop(host({ platform: 'linux' }));
    expect(location).toEqual({
      status: 'not-installed',
      searched: ['/usr/bin/wrongstack-desktop-native'],
    });
  });
});

describe('locateDesktop — the engine must sit beside the application', () => {
  it('refuses an installed copy whose engine is missing instead of skipping to another copy', () => {
    const location = locateDesktop(
      host({
        platform: 'win32',
        env: { LOCALAPPDATA: WIN_LOCAL },
        cwd: 'C:\\repo',
        files: [
          `${WIN_DEFAULT}\\wrongstack-desktop-native.exe`,
          // A complete portable copy exists too; it must not be picked silently.
          'C:\\repo\\apps\\desktop-v2\\dist-native\\aaaaaaaaaaaa-bbbbbbbbbbbb\\wrongstack-desktop-native.exe',
          'C:\\repo\\apps\\desktop-v2\\dist-native\\aaaaaaaaaaaa-bbbbbbbbbbbb\\wrongstack-engine.exe',
        ],
        texts: {
          'C:\\repo\\apps\\desktop-v2\\dist-native\\latest.json':
            '{"directory":"aaaaaaaaaaaa-bbbbbbbbbbbb"}',
        },
      }),
    );
    expect(location).toEqual({
      status: 'engine-missing',
      install: {
        source: 'installed',
        app: `${WIN_DEFAULT}\\wrongstack-desktop-native.exe`,
        engine: `${WIN_DEFAULT}\\wrongstack-engine.exe`,
      },
    });
  });

  it('an engine elsewhere (not beside the app) does not count', () => {
    const location = locateDesktop(
      host({
        platform: 'linux',
        files: ['/usr/bin/wrongstack-desktop-native', '/usr/local/bin/wrongstack-engine'],
      }),
    );
    expect(location.status).toBe('engine-missing');
  });
});

describe('locateDesktop — override and portable copies', () => {
  it('WRONGSTACK_DESKTOP_APP comes first and may name the directory', () => {
    const location = locateDesktop(
      host({
        platform: 'linux',
        env: { WRONGSTACK_DESKTOP_APP: '/opt/wsd' },
        dirs: ['/opt/wsd'],
        files: [
          '/opt/wsd/wrongstack-desktop-native',
          '/opt/wsd/wrongstack-engine',
          '/usr/bin/wrongstack-desktop-native',
          '/usr/bin/wrongstack-engine',
        ],
      }),
    );
    expect(location).toEqual({
      status: 'found',
      install: {
        source: 'override',
        app: '/opt/wsd/wrongstack-desktop-native',
        engine: '/opt/wsd/wrongstack-engine',
      },
    });
  });

  it('a relative override resolves against the working directory; a .app names the bundle on macOS', () => {
    const location = locateDesktop(
      host({
        platform: 'darwin',
        cwd: '/Users/ada/build',
        env: { WRONGSTACK_DESKTOP_APP: 'out/WrongStack Desktop.app' },
        files: [
          '/Users/ada/build/out/WrongStack Desktop.app/Contents/MacOS/wrongstack-desktop-native',
          '/Users/ada/build/out/WrongStack Desktop.app/Contents/MacOS/wrongstack-engine',
        ],
      }),
    );
    expect(location.status === 'found' && location.install.bundle).toBe(
      '/Users/ada/build/out/WrongStack Desktop.app',
    );
  });

  it('an override that points at nothing says so instead of opening the installed copy', () => {
    const location = locateDesktop(
      host({
        platform: 'linux',
        env: { WRONGSTACK_DESKTOP_APP: '/nope/app' },
        files: ['/usr/bin/wrongstack-desktop-native', '/usr/bin/wrongstack-engine'],
      }),
    );
    expect(location.status).toBe('not-installed');
    if (location.status === 'not-installed') {
      expect(location.problem).toContain('WRONGSTACK_DESKTOP_APP');
      expect(location.problem).toContain('/nope/app');
    }
  });

  it('inside a checkout, the portable build latest.json names is used from a nested directory', () => {
    const portable = '/repo/apps/desktop-v2/dist-native/0123456789ab-cdef01234567';
    const location = locateDesktop(
      host({
        platform: 'linux',
        cwd: '/repo/packages/cli',
        texts: {
          '/repo/apps/desktop-v2/dist-native/latest.json':
            '{ "directory": "0123456789ab-cdef01234567" }',
        },
        files: [`${portable}/wrongstack-desktop-native`, `${portable}/wrongstack-engine`],
      }),
    );
    expect(location).toEqual({
      status: 'found',
      install: {
        source: 'portable',
        app: `${portable}/wrongstack-desktop-native`,
        engine: `${portable}/wrongstack-engine`,
      },
    });
  });

  it('ignores a latest.json whose directory is not a portable build id', () => {
    const location = locateDesktop(
      host({
        platform: 'linux',
        cwd: '/repo',
        texts: { '/repo/apps/desktop-v2/dist-native/latest.json': '{"directory":"../../etc"}' },
        files: ['/etc/wrongstack-desktop-native', '/etc/wrongstack-engine'],
      }),
    );
    expect(location.status).toBe('not-installed');
  });
});

describe('installed version and package format', () => {
  it('reads the HKCU uninstall entry the NSIS installer wrote, quotes removed', () => {
    const queries: string[][] = [];
    const values = readWindowsInstallRecord({ SystemRoot: 'C:\\Windows' }, (command, args) => {
      queries.push([command, ...args]);
      return [
        '',
        'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WrongStack Desktop',
        '    DisplayName    REG_SZ    WrongStack Desktop',
        '    DisplayVersion    REG_SZ    1.4.2',
        '    InstallLocation    REG_SZ    "C:\\Users\\ada\\AppData\\Local\\WrongStack Desktop"',
        '',
      ].join('\r\n');
    });
    expect(queries).toEqual([
      [
        'C:\\Windows\\System32\\reg.exe',
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WrongStack Desktop',
      ],
    ]);
    if (!values) throw new Error('expected a record');
    expect(values.get('DisplayVersion')).toBe('1.4.2');
    expect(values.get('InstallLocation')).toBe(
      'C:\\Users\\ada\\AppData\\Local\\WrongStack Desktop',
    );
  });

  it('reads the version from the Windows record and from the macOS Info.plist', () => {
    const winHost = host({ platform: 'win32' });
    const install = { source: 'installed' as const, app: 'C:\\x\\a.exe', engine: 'C:\\x\\e.exe' };
    expect(
      readInstalledDesktopVersion(install, winHost, () => new Map([['DisplayVersion', '1.4.2']])),
    ).toBe('1.4.2');

    const plist =
      '<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n  <string>1.3.0</string></dict></plist>';
    const macHost = host({
      platform: 'darwin',
      texts: { [`${MAC_APP}/Contents/Info.plist`]: plist },
    });
    expect(
      readInstalledDesktopVersion(
        {
          source: 'installed',
          app: `${MAC_EXE}/wrongstack-desktop-native`,
          engine: '',
          bundle: MAC_APP,
        },
        macHost,
      ),
    ).toBe('1.3.0');
  });

  it('portable and override copies have no recorded version', () => {
    expect(
      readInstalledDesktopVersion(
        { source: 'portable', app: '/r/a', engine: '/r/e' },
        host({ platform: 'linux' }),
      ),
    ).toBeUndefined();
  });

  it('picks deb on a dpkg system, rpm on an rpm system, nothing otherwise', () => {
    expect(
      detectLinuxPackageFormat(
        host({
          platform: 'linux',
          env: { PATH: '/usr/local/bin:/usr/bin' },
          files: ['/usr/bin/dpkg', '/usr/bin/rpm'],
        }),
      ),
    ).toBe('deb');
    expect(
      detectLinuxPackageFormat(
        host({ platform: 'linux', env: { PATH: '/usr/bin' }, files: ['/usr/bin/rpm'] }),
      ),
    ).toBe('rpm');
    expect(
      detectLinuxPackageFormat(host({ platform: 'linux', env: { PATH: '/usr/bin' } })),
    ).toBeUndefined();
  });
});
