import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hostPortableSources,
  type PortableSources,
  portableDirectory,
  stagePortable,
} from '../scripts/portable';

const owned: string[] = [];
const WINDOWS = 'x86_64-pc-windows-msvc';
let sources: PortableSources;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wrongstack-portable-test-'));
  owned.push(dir);
  sources = hostPortableSources(dir, WINDOWS);
  mkdirSync(join(dir, 'src-tauri/target/release'), { recursive: true });
  mkdirSync(join(dir, 'binaries'));
  writeFileSync(sources.ui, 'ui-v1');
  writeFileSync(sources.engine, 'engine-v1');
  return dir;
}
afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('portable build updates', () => {
  it('stages new builds without replacing the engine or UI used by an open session', () => {
    const dir = fixture();
    const first = stagePortable(dir, sources);
    expect(stagePortable(dir, sources)).toBe(first);
    writeFileSync(sources.ui, 'ui-v2');
    writeFileSync(sources.engine, 'engine-v2');
    const next = stagePortable(dir, sources);
    expect(next).not.toBe(first);
    expect(portableDirectory(dir)).toBe(next);
    expect(readFileSync(join(first, 'wrongstack-engine.exe'), 'utf8')).toBe('engine-v1');
    expect(readFileSync(join(first, 'wrongstack-desktop-native.exe'), 'utf8')).toBe('ui-v1');
    expect(readFileSync(join(next, 'SHA256SUMS'), 'utf8')).toMatch(
      /^[a-f0-9]{64} {2}wrongstack-desktop-native.exe\n[a-f0-9]{64} {2}wrongstack-engine.exe\n$/,
    );
  });
  it('refuses a mutated artifact and keeps the last valid build selected', () => {
    const dir = fixture();
    const first = stagePortable(dir, sources);
    writeFileSync(join(first, 'wrongstack-engine.exe'), 'modified');
    expect(() => stagePortable(dir, sources)).toThrow('Portable artifact identity changed');
    expect(portableDirectory(dir)).toBe(first);
  });
  it('rejects paths outside the build store', () => {
    const dir = fixture();
    stagePortable(dir, sources);
    writeFileSync(
      join(dir, 'dist-native/latest.json'),
      JSON.stringify({ directory: '../private' }),
    );
    expect(() => portableDirectory(dir)).toThrow('Invalid portable build identity');
  });
  it('names the sidecar the way the Tauri bundler expects and strips the suffix off Windows', () => {
    const dir = fixture();
    expect(sources.engine).toBe(join(dir, 'binaries', `wrongstack-engine-${WINDOWS}.exe`));
    const mac = hostPortableSources(dir, 'aarch64-apple-darwin');
    expect(mac.engine).toBe(join(dir, 'binaries', 'wrongstack-engine-aarch64-apple-darwin'));
    expect(mac.ui).toBe(join(dir, 'src-tauri/target/release/wrongstack-desktop-native'));
    const linux = hostPortableSources(dir, 'x86_64-unknown-linux-gnu');
    writeFileSync(linux.ui, 'ui-linux');
    writeFileSync(linux.engine, 'engine-linux');
    const staged = stagePortable(dir, linux);
    expect(readFileSync(join(staged, 'SHA256SUMS'), 'utf8')).toMatch(
      /^[a-f0-9]{64} {2}wrongstack-desktop-native\n[a-f0-9]{64} {2}wrongstack-engine\n$/,
    );
  });
});
