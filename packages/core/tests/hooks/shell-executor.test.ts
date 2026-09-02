import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runShellHook } from '../../src/hooks/shell-executor.js';
import type { HookInput } from '../../src/types/hooks.js';

// Temp scripts run via `node` (on PATH) so we avoid inline cross-shell quoting.
let dir: string;
const scripts: Record<string, string> = {};

function write(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-hook-'));
  scripts.block = write('block.mjs', 'process.exit(2);\n');
  scripts.json = write(
    'json.mjs',
    "console.log(JSON.stringify({ additionalContext: 'from-hook' }));\n",
  );
  scripts.echo = write(
    'echo.mjs',
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d||'{}');console.log(JSON.stringify({additionalContext:o.toolName||'none'}));});\n",
  );
  scripts.plain = write('plain.mjs', "console.log('not json at all');\n");
  scripts.sleep = write('sleep.mjs', 'setTimeout(() => process.exit(0), 2000);\n');
});

afterAll(() => {
  // Best-effort: the timeout test may leave a short-lived grandchild holding
  // `dir` as its cwd on Windows (EPERM on rmSync). Temp files are OS-cleaned.
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function input(extra: Partial<HookInput> = {}): HookInput {
  return { event: 'PostToolUse', toolName: 'bash', cwd: dir, ...extra };
}

describe('runShellHook', () => {
  it('treats exit code 2 as a block', async () => {
    const r = await runShellHook({ command: `node ${scripts.block}` }, input());
    expect(r?.decision).toBe('block');
  });

  it('parses a JSON HookOutcome from stdout', async () => {
    const r = await runShellHook({ command: `node ${scripts.json}` }, input());
    expect(r?.additionalContext).toBe('from-hook');
  });

  it('feeds the HookInput JSON to stdin', async () => {
    const r = await runShellHook({ command: `node ${scripts.echo}` }, input({ toolName: 'edit' }));
    expect(r?.additionalContext).toBe('edit');
  });

  it('returns null for non-JSON stdout', async () => {
    const r = await runShellHook({ command: `node "${scripts.plain}"` }, input());
    expect(r).toBeNull();
  });

  it('returns null (and kills) on timeout', async () => {
    const r = await runShellHook({ command: `node "${scripts.sleep}"`, timeoutMs: 150 }, input());
    expect(r).toBeNull();
  });

  it('returns null when the command cannot run', async () => {
    const r = await runShellHook({ command: 'definitely-not-a-real-binary-xyz --nope' }, input());
    expect(r).toBeNull();
  });
});
