import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultConfigLoader } from '../../src/storage/config-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

describe('Config.features defaults', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-feat-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('defaults all feature flags to on when no overrides', async () => {
    const paths = resolveWstackPaths({
      userHome: tmp,
      projectRoot: tmp,
      globalRoot: path.join(tmp, '.wrongstack'),
    });
    const loader = new DefaultConfigLoader({ paths });
    const cfg = await loader.load({
      cliFlags: { provider: 'anthropic', model: 'claude-test' },
    });
    expect(cfg.features).toEqual({
      mcp: true,
      plugins: true,
      memory: true,
      modelsRegistry: true,
      skills: true,
      prompts: true,
      // Default is 'auto' — the prompt builder resolves it from the model's
      // context window; consumers without that context use the medium baseline.
      tokenSavingMode: 'auto',
      // Zero-config must be CONFINED. This assertion previously pinned `true`,
      // which locked in the insecure default rather than catching it (WS-075).
      allowOutsideProjectRoot: false,
    });
    expect(cfg.skills?.mode).toBe('progressive');
  });

  it('zero-config filesystem confinement is on, and both halves agree', async () => {
    // The two config keys are one switch. They lived in the same defaults object
    // declaring opposite intents, and the `??` precedence in wiring/session.ts
    // silently resolved it in favour of the permissive half. Pin the invariant
    // itself so the halves cannot drift apart again.
    const paths = resolveWstackPaths({
      userHome: tmp,
      projectRoot: tmp,
      globalRoot: path.join(tmp, '.wrongstack'),
    });
    const loader = new DefaultConfigLoader({ paths });
    const cfg = await loader.load({
      cliFlags: { provider: 'anthropic', model: 'claude-test' },
    });
    expect(cfg.features.allowOutsideProjectRoot).toBe(false);
    expect(cfg.tools.restrictToProjectRoot).toBe(true);
    expect(cfg.features.allowOutsideProjectRoot).toBe(!cfg.tools.restrictToProjectRoot);
  });

  it('--no-features patch turns every subsystem off', async () => {
    const paths = resolveWstackPaths({
      userHome: tmp,
      projectRoot: tmp,
      globalRoot: path.join(tmp, '.wrongstack'),
    });
    const loader = new DefaultConfigLoader({ paths });
    const cfg = await loader.load({
      cliFlags: {
        provider: 'anthropic',
        model: 'claude-test',
        features: {
          mcp: false,
          plugins: false,
          memory: false,
          modelsRegistry: false,
          skills: false,
        },
      },
    });
    expect(cfg.features.mcp).toBe(false);
    expect(cfg.features.plugins).toBe(false);
    expect(cfg.features.memory).toBe(false);
    expect(cfg.features.modelsRegistry).toBe(false);
    expect(cfg.features.skills).toBe(false);
  });

  it('config-file features merge with CLI overrides (CLI wins)', async () => {
    const paths = resolveWstackPaths({
      userHome: tmp,
      projectRoot: tmp,
      globalRoot: path.join(tmp, '.wrongstack'),
    });
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.wrongstack', 'config.json'),
      JSON.stringify({
        version: 1,
        provider: 'anthropic',
        model: 'claude-test',
        features: { mcp: false, plugins: true },
      }),
    );
    const loader = new DefaultConfigLoader({ paths });
    const cfg = await loader.load({
      cliFlags: { features: { mcp: true, plugins: false } as never },
    });
    expect(cfg.features.mcp).toBe(true); // CLI override
    expect(cfg.features.plugins).toBe(false); // CLI override
    expect(cfg.features.memory).toBe(true); // default kept
  });
});
