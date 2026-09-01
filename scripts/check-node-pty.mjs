#!/usr/bin/env node
/**
 * node-pty prebuilt installation smoke check.
 *
 * Verifies that the optional `node-pty` dependency resolves, its native
 * binary loads for the current Node ABI, and a real pty.spawn() can
 * produce output. This catches a class of bugs that the rest of the
 * CI suite misses:
 *
 *   - pnpm dropping optional deps on Node 22/24 (see PR-018b: `optionalDependencies`
 *     were silently skipped because `allowBuilds: { node-pty: false }` in
 *     pnpm-workspace.yaml blocked the prebuild-install script).
 *   - Microsoft publishing a prebuilt for the Node major version on
 *     windows-x64 but not the actual ABI patch level (the 1.1.0 line's
 *     pre-NAPI prebuilds stopped at Node 22, which is why f651b229 moved to
 *     1.2.0-beta.14). Re-pinned to stable 1.1.0 in the security-report
 *     Phase-4 pass (2026-09-01): verified empirically — the 1.1.0 prebuild
 *     resolves and passes this smoke check on Node 24.13 / ABI 137 / win32
 *     with no compile step, so the prerelease channel is no longer needed.
 *   - Dist/ artifacts referencing node-pty by path but the symlink
 *     missing in `packages/<pkg>/node_modules/node-pty`.
 *
 * Run: node scripts/check-node-pty.mjs
 *
 * Exit 0 = node-pty is loadable and a pty can be spawned.
 * Exit 1 = any check failed (with a human-readable cause).
 *
 * Designed to run on ubuntu-latest and windows-latest in CI (Node 22
 * matrix). Does NOT require a TTY; spawns cmd.exe on Windows, /bin/sh
 * on Linux/macOS, and writes a synthetic command, expecting echo back.
 */

const PLATFORM = process.platform;
const NODE = process.version;
const MODULES_VERSION = process.versions.modules;

// Pick a shell that always exists on each platform and exits quickly.
// /bin/sh on POSIX, cmd.exe on Windows. Avoids /bin/bash which is
// sometimes missing on stripped CI images.
const SHELL = PLATFORM === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
// A command that produces a single, distinctive line of output and
// exits. /c on cmd.exe means "run this command then exit". On POSIX,
// `printf` is POSIX-mandated and prints without the trailing newline
// surprises of `echo`.
const SENTINEL = 'node-pty-smoke-' + Date.now().toString(36);
const COMMAND = PLATFORM === 'win32' ? `echo ${SENTINEL}` : `printf '%s\\n' ${SENTINEL}`;
const SHELL_ARGS = PLATFORM === 'win32' ? ['/d', '/s', '/c', COMMAND] : ['-c', COMMAND];

const checks = [
  {
    name: 'Node version',
    pass: NODE.startsWith('v'),
    detail: `running ${NODE} (ABI ${MODULES_VERSION}) on ${PLATFORM}`,
  },
  {
    name: 'shell available',
    pass: Boolean(SHELL),
    detail: SHELL,
  },
];

// 1. Resolve + load node-pty from any of the resolution roots the
// runtime might use. createRequire(import.meta.url) anchors at this
// script file (scripts/check-node-pty.mjs), which pnpm has placed in
// the monorepo's .pnpm store tree, so its resolution tree is the
// same as the workspace CLI's. Falling back to direct import lets
// the script work outside pnpm (e.g. in a published-install smoke
// test).
let pty;
try {
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const here = fileURLToPath(import.meta.url);
  const req = createRequire(here);
  // Walk up to the monorepo root to find packages/webui (the canonical
  // location of node-pty under pnpm optionalDependencies). Fall back to
  // plain require() if not found, then to direct import.
  const walk = () => {
    let dir = dirname(here);
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'packages', 'webui', 'node_modules', 'node-pty');
      if (existsSync(candidate)) return req(candidate);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };
  const candidates = [walk, () => req('node-pty'), () => import('node-pty')];
  let lastErr;
  for (const candidate of candidates) {
    try {
      pty = await candidate();
      if (pty) break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!pty) throw lastErr ?? new Error('node-pty not found in any resolution root');
  checks.push({
    name: 'node-pty resolves',
    pass: typeof pty.spawn === 'function',
    detail: 'spawn function available',
  });
} catch (err) {
  checks.push({
    name: 'node-pty resolves',
    pass: false,
    detail: err.message,
  });
}

// 2. Spawn a real pty, write the sentinel command, expect it back.
// We give the pty up to 5 s to produce any output, then check the
// accumulated buffer for the sentinel. We kill the pty with SIGTERM
// (Windows uses process.kill) regardless of outcome.
if (pty && typeof pty.spawn === 'function') {
  let proc;
  let output = '';
  let exited = false;
  try {
    proc = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    checks.push({
      name: 'pty.spawn',
      pass: typeof proc.pid === 'number' || (proc.pid === 0 && PLATFORM === 'win32'),
      detail: `pid=${proc.pid}, shell=${SHELL}`,
    });
    proc.onData((data) => {
      output += data;
    });
    proc.onExit(() => {
      exited = true;
    });
  } catch (err) {
    checks.push({ name: 'pty.spawn', pass: false, detail: err.message });
  }

  // Wait up to 5 s for the sentinel to appear in output.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !exited && !output.includes(SENTINEL)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (proc) {
    if (!exited) {
      try {
        proc.kill();
      } catch {}
    }
  }
  checks.push({
    name: 'sentinel echoed back',
    pass: output.includes(SENTINEL),
    detail:
      output.length === 0
        ? 'no output received in 5 s'
        : `output ${output.length} bytes, sentinel ${output.includes(SENTINEL) ? 'found' : 'NOT found'}`,
  });
}

// Report.
let failed = 0;
for (const c of checks) {
  const mark = c.pass ? 'PASS' : 'FAIL';
  process.stdout.write(`[${mark}] ${c.name.padEnd(22)} ${c.detail}\n`);
  if (!c.pass) failed += 1;
}
process.stdout.write(
  `\n${failed === 0 ? 'OK' : 'FAILED'}: ${checks.length - failed}/${checks.length} checks passed (${NODE}, ${PLATFORM})\n`,
);
process.exit(failed === 0 ? 0 : 1);
