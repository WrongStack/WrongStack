/**
 * The default import-organizer command runs the real project-local Biome on
 * a file. A bare `biome check --write --unsafe` applied every unsafe fix,
 * not only the import ones: `x!.y` became `x?.y` (a behaviour change) and an
 * unused `z` became `_z`. The default limits Biome to the import rules.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import importOrganizerPlugin, { resolveAllowedCommand } from '../src/import-organizer/index.js';

const SOURCE = [
  'import { b } from "./b";',
  'import { a, unused } from "./a";',
  'export function f(x?: { y: number }) {',
  '  const z = 1;',
  '  return a + b + x!.y;',
  '}',
  '',
].join('\n');

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('import-organizer default command', () => {
  it('organizes imports without applying other unsafe fixes', () => {
    const command = (importOrganizerPlugin.defaultConfig as { command: string }).command;
    const resolved = resolveAllowedCommand(command);
    expect(resolved).not.toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-organizer-default-'));
    const file = path.join(dir, 'f.ts');
    fs.writeFileSync(file, SOURCE, 'utf8');
    try {
      execFileSync(resolved!.cmd, [...resolved!.args, 'f.ts'], {
        cwd: dir,
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      // Biome exits non-zero when diagnostics remain; the file is still written.
    }
    const out = fs.readFileSync(file, 'utf8');
    expect(out).toContain('import { a } from "./a";\nimport { b } from "./b";');
    expect(out).not.toContain('unused');
    expect(out).toContain('x!.y');
    expect(out).toContain('const z = 1;');
  }, 30_000);
});
