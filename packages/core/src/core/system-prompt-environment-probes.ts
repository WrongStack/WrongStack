import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '../utils/child-env.js';

export async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ceiling on the in-flight partial line while folding `git status` output.
 * See the fold loop in {@link gitStatus}.
 */
const MAX_LINE_CHARS = 64 * 1024;

export async function gitStatus(root: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (s: string): void => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    let proc: ReturnType<typeof spawn> | undefined;
    // 10 s ceiling: a hung git status must not stall prompt construction
    // forever — but the ceiling must also tolerate a HEALTHY git under full
    // parallel load, where spawn+exec plus a lived-in repo's directory scan
    // legitimately exceeds 2 s (observed: a 2.3 s probe under 24-way vitest
    // load; the old 2 s ceiling SIGKILLed it and silently stripped
    // branch/modified/staged from every system prompt — bug-hunt round 19,
    // load-dependent flake in system-prompt-builder's "reports git branch"
    // test). 10 s still bounds a genuinely hung git via SIGKILL.
    const timer = setTimeout(() => {
      proc?.kill('SIGKILL');
      finish('git timeout');
    }, 10_000);
    try {
      proc = spawn('git', ['status', '--porcelain=v1', '--branch'], {
        cwd: root,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      // Folded as it streams rather than buffered. `--porcelain` output is
      // unbounded in the size of the working tree — a repo with a large
      // unignored subtree emits tens of megabytes — and this runs on every
      // system-prompt build for three numbers we can accumulate on the fly.
      // Retaining the full text meant allocating (and immediately dropping)
      // that whole string once per prompt.
      let branch = 'detached';
      let staged = 0;
      let modified = 0;
      let sawBranchLine = false;
      let carry = '';
      // Mirrors the old `split('\n').filter(Boolean)`: blank lines are
      // dropped, the first surviving line is the `## branch` header, and
      // every line after it is a dirty entry.
      const onLine = (line: string): void => {
        if (!line) return;
        if (!sawBranchLine) {
          sawBranchLine = true;
          branch = line.match(/## ([^\s.]+)/)?.[1] ?? 'detached';
          return;
        }
        if (/^[MARCD]/.test(line)) staged++;
        else modified++;
      };
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (c: string) => {
        carry += c;
        // Index walk, not repeated front-slicing — one chunk can carry
        // thousands of porcelain lines.
        let start = 0;
        let nl = carry.indexOf('\n', start);
        while (nl !== -1) {
          onLine(carry.slice(start, nl));
          start = nl + 1;
          nl = carry.indexOf('\n', start);
        }
        if (start > 0) carry = carry.slice(start);
        // git never emits a line this long; capping keeps a pathological
        // one from becoming the buffer we just removed.
        if (carry.length > MAX_LINE_CHARS) carry = carry.slice(0, MAX_LINE_CHARS);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        finish('git error');
      });
      proc.on('close', () => {
        clearTimeout(timer);
        if (carry) onLine(carry);
        finish(`branch=${branch}, ${modified} modified, ${staged} staged`);
      });
    } catch {
      clearTimeout(timer);
      finish('git unavailable');
    }
  });
}

export async function detectLanguages(root: string): Promise<string> {
  const checks: Array<[string, string]> = [
    ['package.json', 'JavaScript/TypeScript'],
    ['tsconfig.json', 'TypeScript'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['Gemfile', 'Ruby'],
    ['pom.xml', 'Java'],
    ['build.gradle', 'Java/Kotlin'],
    ['composer.json', 'PHP'],
    ['mix.exs', 'Elixir'],
  ];
  const hits = await Promise.all(
    checks.map(async ([marker, lang]) => {
      try {
        await fs.access(path.join(root, marker));
        return lang;
      } catch {
        return null;
      }
    }),
  );
  const langs = new Set(hits.filter((l): l is string => l !== null));
  return langs.size === 0 ? 'unknown' : Array.from(langs).join(', ');
}
