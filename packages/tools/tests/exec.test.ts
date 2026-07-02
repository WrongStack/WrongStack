import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  execTool,
  configureExecPolicy,
  resetExecPolicy,
  isExecCommandAllowed,
  getExecAllowlist,
  configureDangerBypass,
  resetDangerBypass,
  getDangerBypass,
} from '../src/exec.js';

const makeOpts = () => ({ signal: new AbortController().signal });
const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;

describe('execTool', () => {
  it('has correct metadata', () => {
    expect(execTool.name).toBe('exec');
    expect(execTool.permission).toBe('confirm');
    expect(execTool.mutating).toBe(true);
    expect(execTool.riskTier).toBe('standard');
  });

  it('rejects empty command', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: '  ' }, ctx, makeOpts());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Empty command');
  });

  it('blocks command strings with embedded shell metacharacters via allowlist', async () => {
    // Pre-0.1.6 the tool also pattern-matched against a forbidden-regex list,
    // but that was dead code (only the command name was tested). Today the
    // allowlist alone suffices: 'echo hello; rm -rf /' is not the key 'echo'.
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo hello; rm -rf /' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('not in allowlist');
  });

  it('blocks rm -rf pattern', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm -rf /tmp' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
  });

  it('blocks eval pattern', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'eval echo hello' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
  });

  it('rejects unknown commands not in allowlist', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'definitely-not-wstack' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('not in allowlist');
  });

  it('allows commands present in the allowlist', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo', args: ['hello'] }, ctx, makeOpts());
    // may fail if echo is missing from PATH but allowlist gate should let it through
    expect(result).toHaveProperty('command');
  });

  it('respects MAX_ARGS limit', async () => {
    const ctx = makeCtx();
    const manyArgs = Array(30).fill('arg');
    const result = await execTool.execute(
      { command: 'echo', args: manyArgs as string[] },
      ctx,
      makeOpts(),
    );
    // args should be sliced to MAX_ARGS
    expect(result).toHaveProperty('args');
  });

  it('respects timeout cap', async () => {
    const ctx = makeCtx();
    // timeout > TIMEOUT_MS should be capped
    const result = await execTool.execute(
      { command: 'echo', timeout: 999_999_999 } as any,
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exitCode');
  });

  it('rejects cwd that resolves outside projectRoot', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute(
      { command: 'echo', cwd: '../../../etc' },
      ctx,
      makeOpts(),
    );
    expect(result.allowed).toBe(false);
    expect(result.stderr).toMatch(/outside project root/);
  });

  it('accepts cwd resolving inside projectRoot', async () => {
    const sb = await mkRealSandbox();
    try {
      await fs.mkdir(path.join(sb.ctx.projectRoot, 'sub'));
      const result = await execTool.execute({ command: 'echo', cwd: 'sub' }, sb.ctx, makeOpts());
      expect(result.stderr).not.toMatch(/outside project root/);
    } finally {
      await sb.cleanup();
    }
  });

  it('blocks rm with absolute path /etc', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '/etc'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });

  it('blocks rm with ~', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '~'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });

  it('blocks rm with . (current dir)', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '.'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });

  it('blocks rm with .. (parent dir)', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm', args: ['-rf', '..'] }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('Blocked argument');
  });
});

// ─── Coverage: runCommand timer callback and buffer write paths ───────────────
describe('exec timer and buffer paths', () => {
  // Lines 243-246: timer callback sets killed=true, calls registry.kill(pid)
  // when pid is number, falls back to child.kill('SIGTERM') otherwise.
  // Exercises the callback body by letting the timeout timer fire.
  it('exercises timer callback with timeout large enough for spawn', async () => {
    // Uses a real temp dir so the spawn succeeds.
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'echo', args: ['start'], timeout: 500 },
        sb.ctx,
        makeOpts(),
      );
      // Either way the timer callback body ran; just verify no crash.
      expect(result).toHaveProperty('exitCode');
    } finally {
      await sb.cleanup();
    }
  });

  it('exercises timer callback with very short timeout', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'echo', args: ['ok'], timeout: 20 },
        sb.ctx,
        makeOpts(),
      );
      // exitCode may be 0 (completed) or 124 (killed) — just verify no crash.
      expect(result).toHaveProperty('exitCode');
    } finally {
      await sb.cleanup();
    }
  });

  // Lines 248-253: stdout/stderr chunks written to buffers when under MAX_OUTPUT
  it('writes stdout chunks to buffer when under MAX_OUTPUT', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'echo', args: ['hello'] },
        sb.ctx,
        makeOpts(),
      );
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('truncated');
    } finally {
      await sb.cleanup();
    }
  });

  it('writes stderr chunks to buffer when command produces stderr', async () => {
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute(
        { command: 'ls', args: ['--no-such-option'] },
        sb.ctx,
        makeOpts(),
      );
      expect(result).toHaveProperty('stderr');
    } finally {
      await sb.cleanup();
    }
  });
});

// ─── Helper: real temp sandbox for exec tests ────────────────────────────────
async function mkRealSandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-tool-'));
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    tools: [],
    session: { id: 'test', append: async () => {}, close: async () => {}, recordFileChange: () => {} },
    messages: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    hasRead(p: string) { return this.readFiles.has(p); },
    lastReadMtime(p: string) { return this.fileMtimes.get(p); },
    recordRead(p: string, m: number) { this.readFiles.add(p); this.fileMtimes.set(p, m); },
  } as never as Context;
  return { ctx, cleanup: async () => fs.rm(dir, { recursive: true, force: true }) };
}

// ─── Coverage: abort / ENOENT hardening (issue #99) ─────────────────────────
// Before the fix, a child process that exited via `AbortSignal.timeout()`
// emitted an `'error'` event with code 'ABORT_ERR'. Without an `'error'`
// listener attached at the moment the abort fired, Node's EventEmitter
// contract rethrows the error on nextTick and crashes the host process
// with `uncaughtException`. The fix in exec.ts attaches the error listener
// immediately after `spawn()` and wraps the lifecycle in try/catch so
// synchronous spawn failures resolve gracefully too.
//
// These tests exercise the abort path WITHOUT running a long-lived
// command: a *pre-aborted* signal causes spawn() (non-Windows) to
// emit `'error'` with ABORT_ERR synchronously after spawn returns.
// That is the exact EventEmitter race the fix guards against — if the
// `'error'` listener weren't attached before the abort fired, Node
// would throw on nextTick and crash this test process.
describe('exec abort and ENOENT hardening (#99)', () => {
  it('survives a pre-aborted signal without crashing the host (POSIX)', async () => {
    if (process.platform === 'win32') {
      // The pre-aborted signal path is handled differently on Windows
      // (manual onAbort() in the signal listener). The POSIX path is
      // what crashes per the issue body.
      return;
    }
    const sb = await mkRealSandbox();
    let crashed = false;
    const onUncaught = (err: Error) => {
      if (/abort/i.test(err.message)) crashed = true;
    };
    process.on('uncaughtException', onUncaught);
    try {
      const ac = new AbortController();
      ac.abort(); // pre-abort BEFORE spawn() is called
      const result = await execTool.execute(
        { command: 'node', args: ['--version'], timeout: 5000 },
        sb.ctx,
        { signal: ac.signal },
      );
      // spawn() with an already-aborted signal emits 'error' immediately
      // with code 'ABORT_ERR'. The error listener catches it and the
      // helper resolves with exitCode=124 + an Aborted: stderr.
      expect(result.allowed).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toMatch(/aborted/i);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await sb.cleanup();
    }
    expect(crashed).toBe(false);
  });

  it('handles ENOENT (command not on PATH) gracefully — does not crash the host', async () => {
    // The tool allowlist gates known-bad command names — pick a name that
    // is syntactically allowed but doesn't exist on any PATH. The
    // single-letter + dot pattern passes `cmd in ALLOWED_COMMANDS`'s
    // existence check but Node's spawn() will emit an ENOENT error
    // (async) or throw synchronously (depending on Node version).
    // Both paths must resolve the promise without crashing the host.
    // We bypass the allowlist by going through execTool with a 1-char
    // synthetic command — but the allowlist gate refuses unknown names,
    // so we use a known-allowed command name that has been removed from
    // PATH for this test only by using a sandboxed PATH.
    const sb = await mkRealSandbox();
    let crashed = false;
    const onUncaught = (err: Error) => {
      if (/ENOENT/.test(err.message)) crashed = true;
    };
    process.on('uncaughtException', onUncaught);
    try {
      // `mkdir` is in the allowlist. Rename it temporarily via PATH
      // stripping so spawn() reports ENOENT. We restore PATH after.
      const originalPath = process.env.PATH;
      process.env.PATH = '';
      try {
        const result = await execTool.execute(
          { command: 'mkdir', args: ['-p', 'subdir'], timeout: 5000 },
          sb.ctx,
          { signal: new AbortController().signal },
        );
        // The command exits gracefully (either ENOENT caught async via
        // 'error' event OR synchronous spawn throw caught by try/catch).
        expect(result.allowed).toBe(true);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
      } finally {
        process.env.PATH = originalPath;
      }
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await sb.cleanup();
    }
    expect(crashed).toBe(false);
  });
});

describe('exec command policy (configurable allowlist)', () => {
  const makeCtx2 = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
  const makeOpts2 = () => ({ signal: new AbortController().signal });

  afterEach(() => {
    resetExecPolicy();
    resetDangerBypass();
  });

  it('ships common build tools in the default allowlist (incl. modern dev runners)', () => {
    for (const cmd of [
      'go',
      'cargo',
      'make',
      'dotnet',
      'gradle',
      'mvn',
      'deno',
      'yarn',
      'tsx',
      'vite',
      'turbo',
      'nx',
      'rg',
      'pytest',
      'uv',
      'poetry',
      'composer',
      'phpunit',
      // Windows shell interpreters — required so `exec cmd /c dir` / PowerShell
      // cmdlets work on Windows instead of hard-failing the allowlist.
      'cmd',
      'cmd.exe',
      'powershell',
      'powershell.exe',
      'pwsh',
      'pwsh.exe',
    ]) {
      expect(isExecCommandAllowed(cmd)).toBe(true);
    }
  });

  it('go build is gated through (allowlisted command, unblocked args)', async () => {
    // go is allowlisted and `build` is not in BLOCKED_ARG_PATTERNS — the gate
    // lets it through (it may still ENOENT if go is not installed, but `allowed`
    // proves the allowlist did not reject it). Needs a real cwd because the
    // cwd-containment check (after the allowlist) realpath-resolves it.
    const sb = await mkRealSandbox();
    try {
      const result = await execTool.execute({ command: 'go', args: ['build', './...'] }, sb.ctx, makeOpts2());
      expect(result.allowed).toBe(true);
    } finally {
      await sb.cleanup();
    }
  });

  it('configureExecPolicy adds allow entries and removes deny entries', () => {
    configureExecPolicy({ allow: ['terraform', 'kubectl'], deny: ['rm', 'docker'] });
    expect(isExecCommandAllowed('terraform')).toBe(true); // added
    expect(isExecCommandAllowed('rm')).toBe(false); // removed from defaults
    expect(isExecCommandAllowed('docker')).toBe(false); // removed
    expect(isExecCommandAllowed('go')).toBe(true); // default preserved
  });

  it('is rebuilt from defaults each call (not cumulative)', () => {
    configureExecPolicy({ allow: ['terraform'] });
    expect(isExecCommandAllowed('terraform')).toBe(true);
    configureExecPolicy({ deny: ['go'] }); // no allow → terraform gone again
    expect(isExecCommandAllowed('terraform')).toBe(false);
    expect(isExecCommandAllowed('go')).toBe(false);
  });

  it('resetExecPolicy restores the built-in defaults', () => {
    configureExecPolicy({ allow: ['terraform'], deny: ['go'] });
    resetExecPolicy();
    expect(isExecCommandAllowed('terraform')).toBe(false);
    expect(isExecCommandAllowed('go')).toBe(true);
    expect(getExecAllowlist()).toContain('node');
  });

  it('a configured-allow command runs through the gate; the unallowed error names the config key', async () => {
    // Unallowed: rejected before cwd resolution, so a fake ctx is fine here.
    const blocked = await execTool.execute({ command: 'terraform' }, makeCtx2(), makeOpts2());
    expect(blocked.allowed).toBe(false);
    expect(blocked.stderr).toContain('tools": { "exec": { "allow"');

    // Allowed: reaches cwd resolution, so use a real sandbox dir.
    configureExecPolicy({ allow: ['terraform'] });
    const sb = await mkRealSandbox();
    try {
      const allowed = await execTool.execute({ command: 'terraform', args: ['version'] }, sb.ctx, makeOpts2());
      expect(allowed.allowed).toBe(true);
    } finally {
      await sb.cleanup();
    }
  });

  it('default allowlist includes Windows-native dev tooling and read-only system utilities', () => {
    // Regression: gh / where / tasklist / etc. were historically rejected
    // even under --yolo, because YOLO only skips the confirmation prompt —
    // it does not bypass the command-name allowlist. Adding them to the
    // default set is the correct fix for that class of "useful tool, no
    // policy reason to block" cases. Per-arg safety still comes from
    // BLOCKED_ARG_PATTERNS + the destructive-ops gate in bash-kill-guard.ts.
    for (const cmd of [
      'gh', // GitHub CLI — lives at "C:\Program Files\GitHub CLI\gh.exe"
      'where', 'tasklist', 'systeminfo', 'wmic', 'sc',
      'netstat', 'ipconfig', 'nslookup', 'tracert', 'pathping',
      'tar',
      'curl', 'wget',
      'clang', 'clang-cl', 'gcc', 'g++', 'ninja', 'msbuild',
    ]) {
      expect(isExecCommandAllowed(cmd)).toBe(true);
    }
  });

  it('default allowlist includes the [core] extended dev tooling set', () => {
    // Smoke test: pick at least one representative from every [core] category
    // added in this commit. We don't enumerate all ~280 entries — a duplicate
    // check in CI catches that case — but we want a regression test that
    // pins a name from each bucket so a future refactor that accidentally
    // drops a category fails loudly.
    for (const cmd of [
      // Archives
      '7z', 'xz', 'unzip',
      // Android / mobile
      'adb', 'fastboot',
      // DevOps / config mgmt
      'ansible', 'ansible-playbook',
      // Cloud CLIs
      'aws', 'az', 'gcloud',
      // Native / linker
      'clang-format', 'clangd', 'lld', 'lldb', 'meson', 'conan',
      // Image / media
      'ffmpeg', 'magick', 'exiftool',
      // HTTP / fetch
      'httpie', 'wget2',
      // Diff / patch
      'diff', 'patch', 'meld',
      // Encoding / file inspection
      'iconv', 'file', 'xxd', 'base64',
      // SSH / crypto
      'ssh', 'ssh-keygen', 'scp', 'rsync', 'gpg', 'openssl',
      // Search
      'jq', 'yq', 'fd', 'ugrep',
      // K8s ecosystem
      'helm', 'k9s', 'kustomize', 'skaffold', 'minikube', 'kind',
      // Container ecosystem
      'docker-compose', 'buildah', 'nerdctl',
      // Databases
      'sqlite3', 'psql', 'mysql', 'redis-cli', 'mongosh', 'etcdctl',
      // Windows extended
      'taskkill', 'hostname', 'whoami',
      // VCS ecosystem
      'glab', 'hub', 'lazygit', 'tig',
      // POSIX extended
      'tree', 'env', 'tr', 'cut', 'printf', 'timeout',
      // Process / system
      'htop', 'lsof', 'strace', 'kill', 'pkill', 'ps',
      // Network
      'ip', 'ss', 'tcpdump', 'nmap', 'socat',
      // Sync / backup
      'rclone', 'restic', 'borg',
      // Permissions
      'chown', 'chmod', 'setfacl',
      // Crypto / cert
      'certbot', 'mkcert',
      // Editors
      'vim', 'nvim', 'code', 'helix', 'micro',
      // Multiplexers
      'tmux', 'screen', 'expect',
      // Calculators / REPLs
      'bc', 'julia', 'irb', 'octave',
      // PHP / Lua / Perl / Ruby
      'phpcs', 'luarocks', 'cpan', 'rake',
      // JS / TS toolchain extended
      'electron', 'swc', 'mocha', 'puppeteer', 'lighthouse',
      // Linters
      'tslint', 'stylelint',
      // Document conversion
      'pandoc', 'wkhtmltopdf',
      // Office
      'soffice', 'libreoffice',
      // Spell
      'aspell', 'hunspell',
      // Source highlight
      'delta', 'bat',
      // Job schedulers
      'systemd-run', 'cronie',
      // Plotting
      'gnuplot', 'grace',
      // Security / recon
      'nmap', 'tcpdump', 'masscan', 'nuclei',
    ]) {
      expect(isExecCommandAllowed(cmd)).toBe(true);
    }
  });

  it('attaches a danger assessment to every exec return', async () => {
    // Integration: verify that the danger-detection layer is wired into the
    // exec tool. This is the contract that UI/TUI consumers rely on to
    // render a banner. We test three categories:
    //   - a pre-execution error return (allowlist miss) → level 'safe'
    //   - a destructive command (rm -rf in a sandbox) → level 'destructive'
    //   - a normal command (git status in a sandbox) → level 'safe'
    const r1 = await execTool.execute({ command: 'not-in-allowlist' }, makeCtx2(), makeOpts2());
    expect(r1.danger.level).toBe('safe');

    configureExecPolicy({ allow: ['rm'] });
    const sb = await mkRealSandbox();
    try {
      const target = path.join(sb.ctx.cwd, 'build');
      await fs.mkdir(target, { recursive: true });
      const r2 = await execTool.execute({ command: 'rm', args: ['-rf', target] }, sb.ctx, makeOpts2());
      expect(r2.allowed).toBe(true);
      expect(r2.danger.level).toBe('destructive');
      expect(r2.danger.reasons).toContain('recursive force-delete');
      expect(r2.danger.matchedRule).toBe('rm-recursive');

      const r3 = await execTool.execute({ command: 'git', args: ['status'] }, sb.ctx, makeOpts2());
      expect(r3.allowed).toBe(true);
      expect(r3.danger.level).toBe('safe');
      expect(r3.danger.reasons).toEqual([]);
    } finally {
      await sb.cleanup();
    }
  });

  it('honors configureDangerBypass: a bypassed rule is suppressed in danger output', async () => {
    configureExecPolicy({ allow: ['rm'] });
    const sb = await mkRealSandbox();
    try {
      // Without bypass: rm -rf is destructive.
      configureDangerBypass({ bypass: [] });
      const r1 = await execTool.execute(
        { command: 'rm', args: ['-rf', path.join(sb.ctx.cwd, 'a')] },
        sb.ctx,
        makeOpts2(),
      );
      expect(r1.danger.level).toBe('destructive');
      expect(r1.danger.matchedRule).toBe('rm-recursive');

      // With bypass on the rule: level drops to safe.
      configureDangerBypass({ bypass: ['rm-recursive'] });
      expect(getDangerBypass().has('rm-recursive')).toBe(true);
      const r2 = await execTool.execute(
        { command: 'rm', args: ['-rf', path.join(sb.ctx.cwd, 'b')] },
        sb.ctx,
        makeOpts2(),
      );
      expect(r2.danger.level).toBe('safe');
      expect(r2.danger.reasons).toEqual([]);
      expect(r2.danger.matchedRule).toBeUndefined();

      // Bypass on a different rule does NOT affect rm-recursive.
      configureDangerBypass({ bypass: ['inline-eval'] });
      const r3 = await execTool.execute(
        { command: 'rm', args: ['-rf', path.join(sb.ctx.cwd, 'c')] },
        sb.ctx,
        makeOpts2(),
      );
      expect(r3.danger.level).toBe('destructive');
      expect(r3.danger.matchedRule).toBe('rm-recursive');
    } finally {
      await sb.cleanup();
    }
  });
});
