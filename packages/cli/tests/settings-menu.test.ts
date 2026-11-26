/**
 * Unit tests for the helpers exported from `settings-menu.ts` that have no
 * dedicated test file yet. Today that is just `deriveFsAccessPair` -- the
 * single source of truth for the inverse `allowOutsideProjectRoot` /
 * `restrictToProjectRoot` pair, consumed by the TUI settings picker,
 * the `/settings fs-access` slash command, and the cli-main live-apply
 * path.
 *
 * Behavior is regression-tested in tui-settings-adapter.test.ts and
 * slash-settings.test.ts; this file exercises the helper directly so a
 * regression in the precedence rules shows up at the source rather than
 * as a symptom in a consumer.
 */
import { listInProjectDeniedPaths } from '@wrongstack/core/storage';
import { describe, expect, it } from 'vitest';
import {
  deriveFsAccessPair,
  filterSafeForProject,
  resolveActualTarget,
  resolvePersistPath,
} from '../src/settings-menu.js';

describe('profile persistence routing', () => {
  const root = '/home/test/.wrongstack/config.json';
  const profile = '/home/test/.wrongstack/profiles/default/config.json';
  const project = '/repo/.wrongstack/config.json';

  function deps(scope: 'global' | 'project' = 'global') {
    return {
      profileConfigPath: profile,
      inProjectConfigPath: project,
      configStore: { get: () => ({ configScope: scope }) },
    } as never;
  }

  it('never resolves a user-settings write to the root bootstrap', () => {
    expect(resolvePersistPath(deps())).toBe(profile);
    expect(resolvePersistPath({ ...(deps('project') as object), forceGlobal: true } as never)).toBe(
      profile,
    );
    expect(resolveActualTarget(deps(), { configScope: 'global' }, root)).toBe(profile);
  });

  it('still supports explicitly project-scoped safe settings', () => {
    expect(resolvePersistPath(deps('project'))).toBe(project);
  });
});

describe('project config write boundary', () => {
  it('matches the loader trust boundary for top-level and nested operator settings', () => {
    const source = {
      version: 1,
      provider: 'attacker-endpoint',
      model: 'safe-model',
      yolo: true,
      themePreset: 'catppuccin',
      modelTiers: { enabled: true },
      autonomy: { autoProceedDelayMs: 1000, defaultMode: 'eternal', yolo: true },
      features: { memory: true, allowOutsideProjectRoot: true, pluginsTrust: false },
      tools: {
        disabledTools: ['safe-to-share'],
        restrictToProjectRoot: false,
        maxIterations: 100000,
        exec: { allow: ['evil'], deny: ['rm'] },
      },
    };

    const safe = filterSafeForProject(source);

    expect(safe).not.toHaveProperty('provider');
    expect(safe).not.toHaveProperty('yolo');
    expect(safe).toMatchObject({
      version: 1,
      model: 'safe-model',
      themePreset: 'catppuccin',
      modelTiers: { enabled: true },
      autonomy: { autoProceedDelayMs: 1000 },
      features: { memory: true },
      tools: { disabledTools: ['safe-to-share'], exec: { deny: ['rm'] } },
    });
    expect(safe).not.toHaveProperty('autonomy.defaultMode');
    expect(safe).not.toHaveProperty('autonomy.yolo');
    expect(safe).not.toHaveProperty('features.allowOutsideProjectRoot');
    expect(safe).not.toHaveProperty('features.pluginsTrust');
    expect(safe).not.toHaveProperty('tools.restrictToProjectRoot');
    expect(safe).not.toHaveProperty('tools.maxIterations');
    expect(safe).not.toHaveProperty('tools.exec.allow');
    expect(source.autonomy.defaultMode).toBe('eternal');
  });

  it('strips every nested path the loader denies, so the two boundaries cannot drift', () => {
    const denied = listInProjectDeniedPaths();
    // Spot-check entries a hand-kept copy once missed.
    expect(denied).toEqual(
      expect.arrayContaining([
        'autonomy.nextSteps',
        'tools.sandbox.image',
        'tools.sandbox.backend',
      ]),
    );
    for (const dotted of denied) {
      const source: Record<string, unknown> = {};
      let cursor = source;
      const parts = dotted.split('.');
      for (const part of parts.slice(0, -1)) {
        const next: Record<string, unknown> = {};
        cursor[part] = next;
        cursor = next;
      }
      cursor[parts.at(-1)!] = 'repo-set';
      expect(filterSafeForProject(source), dotted).not.toHaveProperty(dotted);
    }
  });

  it('keeps the display-only keys the loader allows in a project config', () => {
    // A project-scope write rewrites the whole file through this filter, so a
    // key the loader accepts but the filter lacks is deleted by any /settings change.
    const safe = filterSafeForProject({ icons: 'ascii', startupAnnounce: false });
    expect(safe).toEqual({ icons: 'ascii', startupAnnounce: false });
  });
});

describe('deriveFsAccessPair', () => {
  it('returns undefined when neither field is set', () => {
    expect(deriveFsAccessPair({})).toBeUndefined();
    expect(deriveFsAccessPair({ allowOutsideProjectRoot: undefined })).toBeUndefined();
    expect(deriveFsAccessPair({ restrictFsToRoot: undefined })).toBeUndefined();
  });

  it('derives restrictToProjectRoot as the inverse when only allow is set', () => {
    expect(deriveFsAccessPair({ allowOutsideProjectRoot: true })).toEqual({
      allowOutsideProjectRoot: true,
      restrictToProjectRoot: false,
    });
    expect(deriveFsAccessPair({ allowOutsideProjectRoot: false })).toEqual({
      allowOutsideProjectRoot: false,
      restrictToProjectRoot: true,
    });
  });

  it('derives allowOutsideProjectRoot as the inverse when only restrict is set', () => {
    expect(deriveFsAccessPair({ restrictFsToRoot: true })).toEqual({
      allowOutsideProjectRoot: false,
      restrictToProjectRoot: true,
    });
    expect(deriveFsAccessPair({ restrictFsToRoot: false })).toEqual({
      allowOutsideProjectRoot: true,
      restrictToProjectRoot: false,
    });
  });

  it('prefers allowOutsideProjectRoot when both fields are set (defensive)', () => {
    // The picker should not produce this state, but if a defensive code
    // path does, the contract is: allowOutsideProjectRoot is the source
    // of truth and the resulting restrictToProjectRoot is its inverse.
    // This must NOT use restrictFsToRoot, even if it is the more
    // permissive-looking value.
    expect(deriveFsAccessPair({ allowOutsideProjectRoot: false, restrictFsToRoot: false })).toEqual(
      {
        allowOutsideProjectRoot: false,
        restrictToProjectRoot: true,
      },
    );
    expect(deriveFsAccessPair({ allowOutsideProjectRoot: true, restrictFsToRoot: true })).toEqual({
      allowOutsideProjectRoot: true,
      restrictToProjectRoot: false,
    });
  });

  it('treats explicit false and true distinctly from undefined', () => {
    // The picker uses `s.allowOutsideProjectRoot !== undefined` as the
    // trigger, so an explicit `false` must win over an undefined
    // `restrictFsToRoot` on the same input. This guards against a
    // future refactor that switches to a truthy check.
    expect(deriveFsAccessPair({ allowOutsideProjectRoot: false })).toEqual({
      allowOutsideProjectRoot: false,
      restrictToProjectRoot: true,
    });
    expect(deriveFsAccessPair({ restrictFsToRoot: false })).toEqual({
      allowOutsideProjectRoot: true,
      restrictToProjectRoot: false,
    });
  });
});
