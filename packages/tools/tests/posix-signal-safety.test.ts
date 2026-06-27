import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const self = rel(__filename);
const allowedNegativeKillTests = new Set(['packages/tools/tests/spawn-background.test.ts']);
const negativeProcessKillPattern = new RegExp('process\\.kill\\s*\\(\\s*-');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(full);
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
    for (const file of walk(path.join(repoRoot, 'packages'))) {
      const relative = rel(file);
      if (relative === self) continue;
      const text = withoutLineComments(readFileSync(file, 'utf8'));
      if (!negativeProcessKillPattern.test(text)) continue;
      if (!allowedNegativeKillTests.has(relative)) offenders.push(relative);
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
});
