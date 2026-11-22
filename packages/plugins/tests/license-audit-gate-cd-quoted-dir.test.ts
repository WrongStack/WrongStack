/**
 * Regression: the audit must follow a `cd` whose target is a QUOTED path —
 * including one containing spaces.
 *
 * `auditTargets` exists because "a disallowed package installed into a
 * sub-package passed whenever the root held an allowed copy". Its `cd` target
 * was parsed with `(\S+)`, so `cd "sub pkg"` never matched: the directory
 * stayed at the root and the root's (allowed) copy was audited instead of the
 * copy the install actually created.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin from '../src/license-audit-gate/index.js';

type HookInput = { toolName?: string; toolInput?: unknown };
type HookResult = { decision?: 'block'; reason?: string } | void;
type Hook = (input: HookInput) => HookResult;

let root: string;
let hook: Hook;

function installInto(dir: string, license: string): void {
  const pkgDir = join(root, dir, 'node_modules', 'evil');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'evil', version: '1.0.0', license }),
  );
}

const run = (command: string): boolean =>
  (hook({ toolName: 'bash', toolInput: { command, cwd: root } }) as HookResult)?.decision ===
  'block';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'license-cd-'));
  installInto('', 'MIT'); // allowed copy at the root
  installInto('sub pkg', 'GPL-3.0'); // install target: quoted path WITH a space
  installInto('subpkg', 'GPL-3.0'); // same, quoted without a space
  const api = {
    config: {
      extensions: {
        'license-audit-gate': { enabled: true, block: true, allowedLicenses: ['MIT'] },
      },
    },
    registerHook: (_event: string, _tools: string, fn: Hook) => {
      hook = fn;
      return () => {};
    },
    tools: { register: () => {} },
    log: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    metrics: { counter: () => {} },
  };
  (plugin as unknown as { setup: (a: unknown) => void }).setup(api);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('license-audit-gate cd target parsing', () => {
  it('audits a quoted cd target that contains a space', () => {
    expect(run('cd "sub pkg" && npm i evil')).toBe(true);
  });

  it('keeps the unquoted and single-quoted spellings working', () => {
    expect(run('cd subpkg && npm i evil')).toBe(true);
    expect(run("cd 'subpkg' && npm i evil")).toBe(true);
  });

  it('still audits the root when the command does not cd', () => {
    expect(run('npm i evil')).toBe(false);
  });
});
