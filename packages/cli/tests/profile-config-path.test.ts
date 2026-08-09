import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@wrongstack/core/types';
import { bootstrapProfileName, resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { activeProfileConfigPath } from '../src/profile-config-path.js';

/**
 * "Which profile is active?" had three answers:
 *
 *  1. `core/utils/wstack-paths` — read `~/.wrongstack/config.json` from disk.
 *  2. `cli/profile-config-path` — read the live `Config` object.
 *  3. `cli/boot/tui-settings-adapter` — an inline cast plus `?? 'default'`,
 *     a hand copy of (2), directly under a comment promising the resolution
 *     was delegated to the canonical resolver.
 *
 * (1) and (2) shipped under the SAME NAME, `activeProfileName`, with different
 * signatures and different sources. They are not interchangeable: `/profile
 * use` writes the bootstrap file and requires a restart, while the settings
 * menu writes `activeProfile` into the profile's own config — so the two can
 * disagree within one session, and a caller autocompleting the wrong import
 * gets a plausible answer about a different profile.
 *
 * (3) now calls (2). (1) is renamed `bootstrapProfileName` so the source is in
 * the name. These tests pin both the behaviour and the fact that the two
 * remain distinct answers rather than one being quietly aliased to the other.
 */

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(bootstrap?: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-profile-'));
  roots.push(home);
  const globalRoot = path.join(home, '.wrongstack');
  fs.mkdirSync(globalRoot, { recursive: true });
  if (bootstrap) {
    fs.writeFileSync(path.join(globalRoot, 'config.json'), JSON.stringify(bootstrap), 'utf8');
  }
  return home;
}

describe('active profile resolution', () => {
  it('reads the live config, defaulting to "default"', () => {
    // Exercised through the exported resolver: the name reader itself is
    // module-private, because exporting it is what invited the third copy.
    const home = tempHome();
    const paths = resolveWstackPaths({ projectRoot: home, userHome: home });
    expect(activeProfileConfigPath(paths, { activeProfile: 'work' } as Config)).toBe(
      paths.profileConfig('work'),
    );
    expect(activeProfileConfigPath(paths, {} as Config)).toBe(paths.profileConfig('default'));
    // Whitespace-only is not a profile name.
    expect(activeProfileConfigPath(paths, { activeProfile: '   ' } as Config)).toBe(
      paths.profileConfig('default'),
    );
  });

  it('builds the profile config path from the live config', () => {
    const home = tempHome();
    const paths = resolveWstackPaths({ projectRoot: home, userHome: home });
    expect(activeProfileConfigPath(paths, { activeProfile: 'work' } as Config)).toBe(
      paths.profileConfig('work'),
    );
  });

  it('the bootstrap reader answers from disk, not from the live config', () => {
    const home = tempHome({ version: 1, activeProfile: 'from-disk' });
    const globalRoot = path.join(home, '.wrongstack');

    expect(bootstrapProfileName(globalRoot)).toBe('from-disk');
    // The live config says something else — and that is a legitimate state,
    // not a bug: the settings menu can change `activeProfile` without
    // rewriting the bootstrap.
    const paths = resolveWstackPaths({ projectRoot: home, userHome: home });
    expect(activeProfileConfigPath(paths, { activeProfile: 'from-session' } as Config)).toBe(
      paths.profileConfig('from-session'),
    );
  });

  it('a missing or corrupt bootstrap selects "default"', () => {
    const missing = tempHome();
    expect(bootstrapProfileName(path.join(missing, '.wrongstack'))).toBe('default');

    const corrupt = tempHome();
    fs.writeFileSync(path.join(corrupt, '.wrongstack', 'config.json'), '{ not json', 'utf8');
    expect(bootstrapProfileName(path.join(corrupt, '.wrongstack'))).toBe('default');
  });

  it('the bootstrap reader is not the live-config resolver', () => {
    // Aliasing one to the other would silently pick a winner for every caller.
    // They answer different questions from different sources.
    const home = tempHome({ version: 1, activeProfile: 'disk' });
    const paths = resolveWstackPaths({ projectRoot: home, userHome: home });
    expect(bootstrapProfileName(path.join(home, '.wrongstack'))).toBe('disk');
    expect(activeProfileConfigPath(paths, { activeProfile: 'live' } as Config)).toBe(
      paths.profileConfig('live'),
    );
  });
});
