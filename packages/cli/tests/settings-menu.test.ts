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
import { describe, expect, it } from 'vitest';
import {
  deriveFsAccessPair,
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
    expect(resolvePersistPath({ ...(deps('project') as object), forceGlobal: true } as never)).toBe(profile);
    expect(resolveActualTarget(deps(), { configScope: 'global' }, root)).toBe(profile);
  });

  it('still supports explicitly project-scoped safe settings', () => {
    expect(resolvePersistPath(deps('project'))).toBe(project);
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
    expect(
      deriveFsAccessPair({ allowOutsideProjectRoot: false, restrictFsToRoot: false }),
    ).toEqual({
      allowOutsideProjectRoot: false,
      restrictToProjectRoot: true,
    });
    expect(
      deriveFsAccessPair({ allowOutsideProjectRoot: true, restrictFsToRoot: true }),
    ).toEqual({
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
