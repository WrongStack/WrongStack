import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectUpdaterArtifacts,
  createUpdaterManifest,
  verifyUpdaterSignature,
} from '../../../scripts/desktop-updater.mjs';

const directory = mkdtempSync(join(tmpdir(), 'wrongstack-updater-signatures-'));
const app = fileURLToPath(new URL('../', import.meta.url));
const version = '9.8.7';
let publicKey: string;
let signature: string;
const payload = Buffer.from('owned updater payload fixture');
const sign = (args: string[], env = process.env) => {
  const result = spawnSync(process.execPath, ['--bun', 'run', 'tauri', 'signer', ...args], {
    cwd: app,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  // Never include signer stdout in an assertion: key generation can print a private key.
  expect(result.status, result.stderr).toBe(0);
};
beforeAll(() => {
  const key = join(directory, 'fixture.key');
  sign(['generate', '--ci', '--write-keys', key]);
  publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  const file = join(directory, 'payload');
  writeFileSync(file, payload);
  sign(['sign', '--app-version', version, file], {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY_PATH: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  });
  signature = readFileSync(`${file}.sig`, 'utf8').trim();
}, 60_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('signed desktop updater publication', () => {
  it('verifies an actual Tauri CLI signature and rejects altered bytes, version and trusted comment', () => {
    expect(() => verifyUpdaterSignature(payload, signature, publicKey, version)).not.toThrow();
    expect(() =>
      verifyUpdaterSignature(Buffer.from('tampered'), signature, publicKey, version),
    ).toThrow();
    expect(() => verifyUpdaterSignature(payload, signature, publicKey, '9.8.8')).toThrow(/version/);
    const altered = Buffer.from(
      Buffer.from(signature, 'base64').toString().replace('version:9.8.7', 'version:9.8.8'),
    ).toString('base64');
    expect(() => verifyUpdaterSignature(payload, altered, publicKey, '9.8.8')).toThrow(
      /verification/,
    );
  });
  it('copies signed macOS archives unchanged and refuses missing signatures', () => {
    const bundle = join(directory, 'bundle');
    mkdirSync(join(bundle, 'macos'), { recursive: true });
    writeFileSync(join(bundle, 'macos', 'WrongStack.app.tar.gz'), payload);
    expect(() => collectUpdaterArtifacts(bundle, directory, 'macos-x64', version)).toThrow();
    writeFileSync(join(bundle, 'macos', 'WrongStack.app.tar.gz.sig'), signature);
    const copied = collectUpdaterArtifacts(bundle, directory, 'macos-x64', version);
    expect(copied).toHaveLength(2);
    expect(readFileSync(join(directory, copied[0]!))).toEqual(payload);
    expect(collectUpdaterArtifacts(bundle, directory, 'linux-x64', version)).toEqual([]);
  });
  it('requires all four signed platforms and uses tag-specific payload URLs', () => {
    const output = join(directory, 'publication');
    mkdirSync(output);
    expect(() =>
      createUpdaterManifest(output, version, 'WrongStack/WrongStack', publicKey),
    ).toThrow();
    for (const [label, suffix] of [
      ['windows-x64', '-setup.exe'],
      ['windows-arm64', '-setup.exe'],
      ['macos-x64', '.app.tar.gz'],
      ['macos-arm64', '.app.tar.gz'],
    ]) {
      const name = `wrongstack-desktop-${version}-${label}${suffix}`;
      writeFileSync(join(output, name), payload);
      writeFileSync(join(output, `${name}.sig`), signature);
    }
    const manifest = createUpdaterManifest(output, version, 'WrongStack/WrongStack', publicKey);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'darwin-aarch64',
      'darwin-x86_64',
      'windows-aarch64',
      'windows-x86_64',
    ]);
    expect(manifest.platforms['windows-x86_64']?.url).toBe(
      'https://github.com/WrongStack/WrongStack/releases/download/v9.8.7/wrongstack-desktop-9.8.7-windows-x64-setup.exe',
    );
    writeFileSync(join(output, `wrongstack-desktop-${version}-windows-x64-setup.exe`), 'tampered');
    expect(() =>
      createUpdaterManifest(output, version, 'WrongStack/WrongStack', publicKey),
    ).toThrow(/verification/);
  });
});
