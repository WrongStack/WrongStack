import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const VERIFIER_SOURCE = readFileSync(resolve(here, '../../goal/src/project-verifier.ts'), 'utf8');
const HANDLER_SOURCE = readFileSync(resolve(here, '../src/server/goal-ws-handler.ts'), 'utf8');
const RUN_SOURCE = readFileSync(resolve(here, '../src/server/goal-run.ts'), 'utf8');

describe('Goal project verifier — shared host hardening', () => {
  it('is the single verifier used by the WebUI Goal host', () => {
    expect(HANDLER_SOURCE).toContain('startGoalRun(this.goalRunHost(), payload, resumeGraph)');
    expect(RUN_SOURCE).toContain('verifyGoalProject({');
    expect(HANDLER_SOURCE).not.toContain("import('node:child_process')");
    expect(RUN_SOURCE).not.toContain("import('node:child_process')");
  });

  it('uses the hardened cross-platform subprocess contract', () => {
    expect(VERIFIER_SOURCE).toContain('buildWin32CmdShimInvocation');
    expect(VERIFIER_SOURCE).toContain('windowsHide: true');
    expect(VERIFIER_SOURCE).toContain('buildChildEnv()');
    expect(VERIFIER_SOURCE).toContain('maxBuffer: 8 * 1024 * 1024');
    // The step timeout kills the whole tree: execFile's own `timeout` only
    // reached cmd.exe, leaving the hung script running behind the shim.
    expect(VERIFIER_SOURCE).toContain('treeKill(child)');
    expect(VERIFIER_SOURCE).toContain('}, timeoutMs);');
  });

  it('runs only discovered package scripts through a structured package-manager invocation', () => {
    expect(VERIFIER_SOURCE).toContain("const args = ['run', step]");
    expect(VERIFIER_SOURCE).toContain("options.steps ?? ['typecheck', 'lint']");
    expect(VERIFIER_SOURCE).not.toContain('shell: true');
  });

  it('fails closed when an enabled script cannot run', () => {
    expect(VERIFIER_SOURCE).toContain('if (!err)');
    expect(VERIFIER_SOURCE).toContain('ok: false');
    expect(VERIFIER_SOURCE).toContain('could not complete');
  });
});
