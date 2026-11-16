import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapProfileName, resolveWstackPaths, safeProfileName } from '../src/wstack-paths.js';

// Windows reserves these ISO-8859-1 superscript digits in device names too:
// https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
const reserved = ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³'];
const fixture = path.resolve('.temp_files', 'profile-name-fixture');
const options = {
  projectRoot: path.join(fixture, 'project'),
  globalRoot: path.join(fixture, 'state'),
  userHome: path.join(fixture, 'home'),
};

describe('Windows reserved device names in profile paths', () => {
  it.each(reserved)('uses the established fallback for %s and its extensions', (base) => {
    const baseline = resolveWstackPaths({ ...options, profileName: 'default' });
    for (const name of [
      base,
      base.toLowerCase(),
      `${base}.json`,
      `${base.toLowerCase()}.tar.gz`,
      ` .${base}. `,
    ]) {
      expect(safeProfileName(name)).toBe('default');
      const resolved = resolveWstackPaths({ ...options, profileName: name });
      expect(resolved.profileName).toBe('default');
      expect(resolved.profileDir).toBe(baseline.profileDir);
      expect(resolved.profileConfig(name)).toBe(baseline.profileConfig('default'));
      expect(resolved.profileModeConfig(name)).toBe(baseline.profileModeConfig('default'));
      expect(resolved.profileStatuslineConfig(name)).toBe(
        baseline.profileStatuslineConfig('default'),
      );
      expect(resolved.profileProviderStatus(name)).toBe(baseline.profileProviderStatus('default'));
      expect(resolved.profileProviderAudit(name)).toBe(baseline.profileProviderAudit('default'));
      expect(resolved.profileUpdateCache(name)).toBe(baseline.profileUpdateCache('default'));
    }
  });

  it('applies the same rule to the active profile read from bootstrap metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-profile-device-'));
    try {
      for (const name of reserved) {
        fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ activeProfile: name }));
        expect(bootstrapProfileName(root)).toBe('default');
        expect(resolveWstackPaths({ ...options, globalRoot: root }).profileName).toBe('default');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['COM0', 'COM10', 'LPT0', 'LPT10', 'COM⁴', 'release¹', 'myCOM²', 'work'])(
    'preserves the ordinary Unicode profile %s',
    (name) => {
      expect(safeProfileName(name)).toBe(name);
      expect(resolveWstackPaths({ ...options, profileName: name }).profileName).toBe(name);
    },
  );

  it.each(['CON', 'nul.json', 'COM1', 'com9.tar.gz', 'LPT1', 'lpt9'])(
    'keeps rejecting the existing ASCII device name %s',
    (name) => expect(safeProfileName(name)).toBe('default'),
  );
});
