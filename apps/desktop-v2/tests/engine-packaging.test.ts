import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildAssetPack } from '../../../scripts/build-binaries.mjs';
import {
  createEngineEntry,
  ENGINE_TARGETS,
  engineSidecarPath,
  engineTargetForTriple,
} from '../scripts/build-engine.mjs';

describe('native engine standalone bootstrap', () => {
  it('keeps real daemon/script dispatch while selecting the desktop backend and local asset pack', () => {
    const canonical = readFileSync(
      new URL('../../../scripts/binary/entry.mjs', import.meta.url),
      'utf8',
    );
    const entry = createEngineEntry(canonical);
    expect(entry).toContain("await import('../engine/main.ts')");
    expect(entry).toContain(
      "await import('../../../packages/core/dist/session-catalog/project-server.js')",
    );
    expect(entry).toContain("'./assets.pack'");
    expect(entry).toContain("BUN_BE_BUN: '1'");
    expect(entry).not.toContain("await import('../../packages/cli/dist/index.js')");
  });
  it('rejects a changed canonical entry instead of silently producing a CLI sidecar', () => {
    expect(() => createEngineEntry('export {};')).toThrow(/bootstrap contract changed/);
  });
  it('packs only the selected runtime assets using the canonical extraction format', () => {
    const destination = mkdtempSync(join(tmpdir(), 'wrongstack-engine-pack-'));
    try {
      const id = buildAssetPack({ assets: { core: ['package.json'] }, destination });
      const raw = gunzipSync(readFileSync(join(destination, 'assets.pack')));
      expect(raw.subarray(0, 6).toString()).toBe('WSPK1\n');
      const length = raw.readUInt32LE(6);
      const index = JSON.parse(raw.subarray(10, 10 + length).toString());
      expect(index.map((file: [string, number]) => file[0])).toEqual(['core/package.json']);
      expect(JSON.parse(raw.subarray(10 + length).toString()).name).toBe('@wrongstack/core');
      expect(id).toMatch(/^[a-f0-9]{12}$/);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe('desktop installer bundle', () => {
  const overlay = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.bundle.conf.json', import.meta.url), 'utf8'),
  );
  it('ships one installer per OS with the engine bundled inside it', () => {
    expect(overlay.bundle.active).toBe(true);
    expect(overlay.bundle.externalBin).toEqual(['../binaries/wrongstack-engine']);
    // AppImage is excluded on purpose: its mount disappears when the window closes, while the
    // session host and its engines keep running from that path.
    expect(overlay.bundle.targets).toEqual(['nsis', 'app', 'dmg', 'deb', 'rpm']);
    expect(overlay.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(overlay.bundle.icon).toEqual(
      expect.arrayContaining(['icons/icon.icns', 'icons/icon.ico']),
    );
  });
  // #440: Tauri signs the engine with the hardened runtime. Without allow-jit, JavaScriptCore
  // loses its JIT, turns SharedArrayBuffer off, and the engine dies at boot on macOS.
  it('signs the macOS engine with the entitlements a Bun executable needs', () => {
    expect(overlay.bundle.macOS.entitlements).toBe('./Entitlements.plist');
    const plist = readFileSync(new URL('../src-tauri/Entitlements.plist', import.meta.url), 'utf8');
    const granted = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]);
    expect(granted).toEqual(
      expect.arrayContaining([
        'com.apple.security.cs.allow-jit',
        'com.apple.security.cs.allow-unsigned-executable-memory',
        'com.apple.security.cs.disable-library-validation',
      ]),
    );
    expect(granted).not.toContain('com.apple.security.cs.allow-dyld-environment-variables');
  });
  it('boots the signed engine from inside the macOS app in CI', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/desktop.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('codesign -d --entitlements - --xml "$engine"');
    expect(workflow).toContain('find "$PWD/apps/desktop-v2/src-tauri/target/release/bundle/macos"');
    expect(workflow).toContain('"$engine" --port "$port"');
  });
  it.each([
    ['<true/>', 0],
    ['<false/>', 1],
    ['<string>true</string>', 1],
    ['<integer>1</integer>', 1],
    ['', 1],
  ])('validates the signed JIT entitlement value %s in CI', (value, expectedStatus) => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/desktop.yml', import.meta.url),
      'utf8',
    );
    const command = workflow.match(/python3 -c '([^']+)'/);
    expect(
      command,
      'CI must parse the signed entitlements, not just search for the key',
    ).not.toBeNull();
    if (!command) return;
    const entry = value ? `<key>com.apple.security.cs.allow-jit</key>${value}` : '';
    const result = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-c', command[1]],
      {
        input: `<?xml version="1.0"?><plist version="1.0"><dict>${entry}</dict></plist>`,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(expectedStatus);
  });
  it('keeps the base config unbundled so development never needs a compiled engine', () => {
    const base = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    );
    expect(base.bundle.active).toBe(false);
    expect(base.bundle.externalBin).toBeUndefined();
  });
  it('builds the sidecar under the name Tauri resolves for every supported desktop target', () => {
    expect(Object.values(ENGINE_TARGETS)).toEqual([
      'x86_64-pc-windows-msvc',
      'aarch64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]);
    for (const [target, triple] of Object.entries(ENGINE_TARGETS)) {
      expect(engineTargetForTriple(triple)).toBe(target);
      const file = engineSidecarPath(triple, '/app');
      expect(file.replaceAll('\\', '/')).toBe(
        `/app/binaries/wrongstack-engine-${triple}${triple.includes('-windows-') ? '.exe' : ''}`,
      );
    }
    expect(() => engineTargetForTriple('x86_64-unknown-freebsd')).toThrow(/no engine target/);
  });
});
