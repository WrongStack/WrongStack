import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubcommandDeps } from '../src/subcommands/contracts.js';
import { configExportCmd, configImportCmd } from '../src/subcommands/handlers/config-transfer.js';

let dir: string;
let profilePath: string;

/** Identity-heavy config: everything a portable export must NOT carry. */
const fullConfig = {
  version: 1,
  activeProfile: 'default',
  provider: 'p1',
  model: 'm1',
  providers: { p1: { apiKeys: [{ label: 'default', apiKey: 'secret-key' }] } },
  mcpServers: { context7: { url: 'https://mcp.example/mcp' } },
  fallbackProfiles: { default: ['p1/m1'] },
  fallbackModels: ['p1/m1'],
  favoriteModels: ['p1/m1'],
  modelMatrix: { git: { fallbackProfile: 'balanced' } },
  context: { softThreshold: 0.42, myCustom: 'keep-me' },
  tools: { maxIterations: 7, nextsteps: { enabled: true } },
  autonomy: { autoProceedDelayMs: 99_999 },
  yolo: false,
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wstack-config-transfer-'));
  profilePath = path.join(dir, 'profile-config.json');
  writeFileSync(profilePath, JSON.stringify(fullConfig));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await import('node:fs/promises').then((fsp) =>
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
  );
});

function makeDeps(overrides: Partial<Record<string, unknown>> = {}): SubcommandDeps {
  return {
    config: fullConfig,
    renderer: { write: vi.fn(), writeError: vi.fn() },
    reader: {} as never,
    modelsRegistry: {} as never,
    paths: { profileConfig: () => profilePath } as never,
    vault: {} as never,
    cwd: dir,
    projectRoot: dir,
    userHome: dir,
    ...overrides,
  } as never as SubcommandDeps;
}

describe('wstack config-export', () => {
  it('writes wstack-config.json with behavior sections only', async () => {
    const deps = makeDeps();
    const code = await configExportCmd([], deps);
    expect(code).toBe(0);

    const exported = JSON.parse(readFileSync(path.join(dir, 'wstack-config.json'), 'utf8'));
    expect(exported.kind).toBe('wstack-config');
    expect(exported.profile).toBe('default');
    // Behavior sections carried.
    expect(exported.settings.context.softThreshold).toBe(0.42);
    expect(exported.settings.tools.maxIterations).toBe(7);
    expect(exported.settings.autonomy.autoProceedDelayMs).toBe(99_999);
    expect(exported.settings.yolo).toBe(false);
    // Identity and routing data structurally excluded.
    expect(exported.settings.provider).toBeUndefined();
    expect(exported.settings.model).toBeUndefined();
    expect(exported.settings.providers).toBeUndefined();
    expect(exported.settings.mcpServers).toBeUndefined();
    expect(exported.settings.fallbackProfiles).toBeUndefined();
    expect(exported.settings.fallbackModels).toBeUndefined();
    expect(exported.settings.favoriteModels).toBeUndefined();
    expect(exported.settings.modelMatrix).toBeUndefined();
    expect(JSON.stringify(exported)).not.toContain('secret-key');
    // Screen output carries the same safety note.
    const out = vi
      .mocked(deps.renderer.write)
      .mock.calls.map((c) => String(c[0]))
      .join('');
    expect(stripAnsi(out)).toContain('No providers, API keys, fallbacks');
  });
});

describe('wstack config-import', () => {
  it('fails loudly on a file that is not a wstack export', async () => {
    writeFileSync(path.join(dir, 'wstack-config.json'), JSON.stringify({ hello: 1 }));
    const deps = makeDeps();
    const code = await configImportCmd([], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalled();
  });

  it('applies behavior settings over the profile and keeps identity', async () => {
    writeFileSync(
      path.join(dir, 'wstack-config.json'),
      JSON.stringify({
        kind: 'wstack-config',
        version: 1,
        settings: {
          context: { softThreshold: 0.75 },
          tools: { maxIterations: 0 },
          autonomy: { autoProceedMaxIterations: 0, autoProceedDelayMs: 15_000 },
          yolo: true,
          // Malicious/foreign keys must be ignored on import too.
          providers: { evil: { apiKey: 'nope' } },
          fallbackProfiles: { default: ['evil/model'] },
        },
      }),
    );
    const deps = makeDeps();
    const code = await configImportCmd([], deps);
    expect(code).toBe(0);

    const cfg = JSON.parse(readFileSync(profilePath, 'utf8'));
    // Behavior settings applied (file values win over existing profile values).
    expect(cfg.context.softThreshold).toBe(0.75);
    expect(cfg.tools.maxIterations).toBe(0);
    expect(cfg.autonomy.autoProceedMaxIterations).toBe(0);
    expect(cfg.autonomy.autoProceedDelayMs).toBe(15_000);
    expect(cfg.yolo).toBe(true);
    // Extension keys inside sections survive the merge.
    expect(cfg.context.myCustom).toBe('keep-me');
    expect(cfg.tools.nextsteps.enabled).toBe(true);
    // Identity untouched; foreign keys never applied.
    expect(cfg.provider).toBe('p1');
    expect(cfg.providers.p1.apiKeys[0].apiKey).toBe('secret-key');
    expect(cfg.fallbackProfiles.default).toEqual(['p1/m1']);
    expect(cfg.fallbackModels).toEqual(['p1/m1']);
    expect(cfg.providers.evil).toBeUndefined();
    expect(cfg.modelMatrix.git.fallbackProfile).toBe('balanced');
  });

  it('reports nothing-to-import for exports without known sections', async () => {
    writeFileSync(
      path.join(dir, 'wstack-config.json'),
      JSON.stringify({ kind: 'wstack-config', version: 1, settings: { unknownKey: 1 } }),
    );
    const deps = makeDeps();
    const code = await configImportCmd([], deps);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(profilePath, 'utf8'));
    expect(cfg.unknownKey).toBeUndefined();
  });
});
