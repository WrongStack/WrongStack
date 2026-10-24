import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HookInput } from '@wrongstack/contracts/types/hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runShellHook, runShellHookDetailed } from '../../src/hooks/shell-executor.js';

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

  it('does not crash when a stdin-ignoring hook receives a payload larger than the pipe buffer', async () => {
    // Regression: child.stdin.end() had no 'error' listener, so a hook that
    // exits without reading stdin left the pending write against a closed
    // pipe (EPIPE/EOF) — an uncaught 'error' event that killed the whole
    // agent process instead of failing just this hook.
    const exit0 = write('exit0.mjs', 'process.exit(0);\n');
    const r = await runShellHook(
      { command: `node ${exit0}`, timeoutMs: 5_000 },
      input({ toolInput: { blob: 'B'.repeat(200_000) } }),
    );
    expect(r).toBeNull(); // exit 0 + no stdout -> no outcome, and no crash
  });
});

describe('runShellHook argument quoting', () => {
  // Prints its argv as the hook's additionalContext so the tests can read
  // exactly what the executable received.
  function argvScript(dirPath: string): string {
    fs.mkdirSync(dirPath, { recursive: true });
    const p = path.join(dirPath, 'argv.mjs');
    fs.writeFileSync(
      p,
      'console.log(JSON.stringify({ additionalContext: JSON.stringify(process.argv.slice(2)) }));\n',
    );
    return p;
  }

  async function argvOf(command: string): Promise<string[]> {
    const r = await runShellHookDetailed({ command, timeoutMs: 10_000 }, input());
    expect(r.failure).toBeUndefined();
    return JSON.parse((r.outcome as { additionalContext: string }).additionalContext);
  }

  it('runs a double-quoted script path that contains spaces', async () => {
    // Regression: the whitespace split handed node the literal `"C:\...` with
    // the quote characters, so every quoted path failed with MODULE_NOT_FOUND.
    const p = argvScript(path.join(dir, 'with space'));
    expect(await argvOf(`node "${p}" one`)).toEqual(['one']);
  });

  it('groups quoted arguments and leaves shell operators literal', async () => {
    const p = argvScript(path.join(dir, 'plain'));
    const argv = await argvOf(`node "${p}" "a b" 'c d' e "x\\"y" 'it"s' C:\\dir\\f && echo | x`);
    expect(argv).toEqual(['a b', 'c d', 'e', 'x"y', 'it"s', 'C:\\dir\\f', '&&', 'echo', '|', 'x']);
  });

  it('keeps backslashes in a double-quoted Windows path', async () => {
    const p = argvScript(path.join(dir, 'winpath'));
    expect(await argvOf(`node "${p}" "C:\\Program Files\\tool"`)).toEqual([
      'C:\\Program Files\\tool',
    ]);
  });

  it('passes an empty quoted argument through', async () => {
    const p = argvScript(path.join(dir, 'empty'));
    expect(await argvOf(`node "${p}" "" x`)).toEqual(['', 'x']);
  });

  it('rejects a command with an unterminated quote instead of guessing', async () => {
    const r = await runShellHookDetailed({ command: 'node "never closed' }, input());
    expect(r.failure).toEqual({
      kind: 'rejected',
      message: 'hook command has an unterminated quote',
    });
  });

  it('still judges the allowlist on the unquoted executable', async () => {
    const r = await runShellHookDetailed({ command: '"definitely-not-allowed" x' }, input());
    expect(r.failure?.kind).toBe('rejected');
  });
});

describe('runShellHook output decoding', () => {
  it('keeps a multi-byte character that arrives split across two stdout chunks', async () => {
    // Two writes 50 ms apart, cut inside the two-byte `ğ`. Decoding each chunk
    // on its own turned both halves into U+FFFD.
    const split = write(
      'split.cjs',
      [
        "const full = Buffer.from(JSON.stringify({ additionalContext: 'Türkçe şğ' }), 'utf8');",
        "const cut = full.lastIndexOf(Buffer.from('ğ', 'utf8')) + 1;",
        'process.stdin.resume();',
        "process.stdin.on('end', () => {",
        '  process.stdout.write(full.subarray(0, cut));',
        '  setTimeout(() => process.stdout.write(full.subarray(cut)), 50);',
        '});',
        '',
      ].join('\n'),
    );
    const r = await runShellHookDetailed({ command: `node "${split}"` }, input());
    expect(r.failure).toBeUndefined();
    expect((r.outcome as { additionalContext?: string } | null)?.additionalContext).toBe(
      'Türkçe şğ',
    );
  });
});
