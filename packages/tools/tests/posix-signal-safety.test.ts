import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const self = rel(__filename);
const sourceRoots = ['packages', 'apps'].map((dir) => path.join(repoRoot, dir));
const allowedNegativeKillTests = new Set(['packages/tools/tests/spawn-background.test.ts']);
const allowedNegativeKillSources = new Set(['packages/tools/src/process-registry.ts']);
const allowedDirectSignalSources = new Set([
  'packages/cli/src/slash-commands/session.ts',
  'packages/webui/src/server/index.ts',
]);
const negativeProcessKillPattern = /process\.kill\s*\(\s*-/;
const directProcessSignalPattern = /process\.kill\s*\([^,\n]+,\s*['"]SIG(?:KILL|TERM|INT|HUP)['"]/;

function walk(dir: string, out: string[] = [], predicate: (name: string) => boolean = (name) => name.endsWith('.test.ts')): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, predicate);
    else if (entry.isFile() && predicate(entry.name)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(repoRoot, file).replaceAll(path.sep, '/');
}

function withoutLineComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('POSIX signal safety in tests', () => {
  it('does not add unguarded negative-PID process.kill calls to tests', () => {
    const offenders: string[] = [];
    for (const root of sourceRoots) {
      for (const file of walk(root, [], (name) => name.endsWith('.test.ts') || name.endsWith('.spec.ts'))) {
        const relative = rel(file);
        if (relative === self) continue;
        const text = withoutLineComments(readFileSync(file, 'utf8'));
        if (!negativeProcessKillPattern.test(text)) continue;
        if (!allowedNegativeKillTests.has(relative)) offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the spawn-background negative-PID cleanup guarded', () => {
    const file = path.join(repoRoot, 'packages/tools/tests/spawn-background.test.ts');
    const text = readFileSync(file, 'utf8');

    expect(text).toContain('function isSafePid(pid: number): boolean');
    expect(text).toContain('pid > 1');
    expect(text).toContain('pid !== process.pid');
    expect(text).toContain('pid !== process.ppid');
    expect(text).toContain('child.pid !== pid');
    expect(text).toContain("process.kill(-pid, 'SIGKILL')");
  });

  it('keeps production negative-PID process.kill isolated to ProcessRegistry', () => {
    const offenders: string[] = [];
    for (const root of sourceRoots) {
      for (const file of walk(root, [], (name) => name.endsWith('.ts'))) {
        const relative = rel(file);
        if (relative.includes('/tests/') || relative.endsWith('.test.ts') || relative.endsWith('.spec.ts')) continue;
        const text = withoutLineComments(readFileSync(file, 'utf8'));
        if (!negativeProcessKillPattern.test(text)) continue;
        if (!allowedNegativeKillSources.has(relative)) offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps production direct process.kill signals limited to reviewed call sites', () => {
    const offenders: string[] = [];
    for (const root of sourceRoots) {
      for (const file of walk(root, [], (name) => name.endsWith('.ts'))) {
        const relative = rel(file);
        if (relative.includes('/tests/') || relative.endsWith('.test.ts') || relative.endsWith('.spec.ts')) continue;
        const text = withoutLineComments(readFileSync(file, 'utf8'));
        if (!directProcessSignalPattern.test(text)) continue;
        if (!allowedDirectSignalSources.has(relative)) offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps ProcessRegistry process-group signaling behind explicit guards', () => {
    const file = path.join(repoRoot, 'packages/tools/src/process-registry.ts');
    const text = readFileSync(file, 'utf8');

    expect(text).toContain('processGroupLeader === true');
    expect(text).toContain('pid > 1');
    expect(text).toContain('pid !== process.pid');
    expect(text).toContain('pid !== process.ppid');
    expect(text).toContain('p.child.pid === p.pid');
    expect(text).toContain('process.kill(-p.pid, signal)');
  });

  it('keeps /sessions kill SIGTERM behind PID safety guards', () => {
    const file = path.join(repoRoot, 'packages/cli/src/slash-commands/session.ts');
    const text = readFileSync(file, 'utf8');

    expect(text).toContain('function isSafeSessionKillPid');
    expect(text).toContain('pid > 1');
    expect(text).toContain('pid !== process.pid');
    expect(text).toContain('pid !== process.ppid');
    expect(text).toContain('!isSafeSessionKillPid(entry.pid)');
    expect(text).toContain("process.kill(entry.pid, 'SIGTERM')");
  });

  it('keeps WebUI shutdown self-signaling scoped to the current process', () => {
    const file = path.join(repoRoot, 'packages/webui/src/server/index.ts');
    const text = readFileSync(file, 'utf8');

    expect(text).toContain("case 'webui.shutdown'");
    expect(text).toContain("process.kill(process.pid, 'SIGINT')");
  });
});
