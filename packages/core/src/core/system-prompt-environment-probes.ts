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

export async function gitStatus(root: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (s: string): void => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    let proc: ReturnType<typeof spawn> | undefined;
    // 2 s ceiling: a hung git status must not stall prompt construction.
    const timer = setTimeout(() => {
      proc?.kill('SIGKILL');
      finish('git timeout');
    }, 2000);
    try {
      proc = spawn('git', ['status', '--porcelain=v1', '--branch'], {
        cwd: root,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let buf = '';
      proc.stdout?.on('data', (c) => {
        buf += c.toString();
      });
      proc.on('error', () => {
        clearTimeout(timer);
        finish('git error');
      });
      proc.on('close', () => {
        clearTimeout(timer);
        const lines = buf.split('\n').filter(Boolean);
        const branchLine = lines[0] ?? '';
        const branchMatch = branchLine.match(/## ([^\s.]+)/);
        const branch = branchMatch?.[1] ?? 'detached';
        const dirty = lines.slice(1);
        const staged = dirty.filter((l) => /^[MARCD]/.test(l)).length;
        const modified = dirty.length - staged;
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
