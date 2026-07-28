import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCAN_ROOTS = ['packages', 'apps', 'scripts'];
const SQLITE_OWNER = 'packages/core/src/coordination/mailbox-project-server.ts';
const LEGACY_AUTHORITIES = new Set([
  'packages/core/src/coordination/global-mailbox.ts',
  'packages/core/src/coordination/global-mailbox-paths.ts',
  'packages/core/src/coordination/mailbox.ts',
  'packages/core/src/coordination/mailbox-credential-store.ts',
  'packages/core/src/coordination/remote-mailbox.ts',
  'packages/core/src/coordination/sqlite-mailbox.ts',
]);

async function productionSourceFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'tests') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await productionSourceFiles(absolute)));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe('Mailbox SQLite/IPC ownership boundary', () => {
  it('keeps SQLite and legacy mailbox files behind the single project owner', async () => {
    const files = (
      await Promise.all(
        SCAN_ROOTS.map((directory) => productionSourceFiles(path.join(ROOT, directory))),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const relative = path.relative(ROOT, file).replaceAll('\\', '/');
      const source = await fs.readFile(file, 'utf8');
      const executableSource = source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      if (relative !== SQLITE_OWNER && /new\s+SqliteMailbox\s*\(/u.test(source)) {
        violations.push(`${relative}: opens the authoritative SQLite mailbox`);
      }
      if (
        !LEGACY_AUTHORITIES.has(relative) &&
        /new\s+(?:GlobalMailbox|DefaultMailbox)\s*\(/u.test(source)
      ) {
        violations.push(`${relative}: constructs a direct filesystem mailbox`);
      }
      if (
        !LEGACY_AUTHORITIES.has(relative) &&
        /new\s+JsonlCredentialStore\s*\(/u.test(source)
      ) {
        violations.push(`${relative}: constructs a direct filesystem credential store`);
      }
      if (
        !LEGACY_AUTHORITIES.has(relative) &&
        /(?:readFile|writeFile|appendFile|unlink|rm|open|DatabaseSync)[\s\S]{0,180}_mailbox(?:\.(?:jsonl|registry\.json|clients\.json|sqlite)|_credentials\.json)/u.test(
          executableSource,
        )
      ) {
        violations.push(`${relative}: directly accesses mailbox persistence`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('opens SQLite only after the IPC endpoint ownership election succeeds', async () => {
    const source = await fs.readFile(path.join(ROOT, SQLITE_OWNER), 'utf8');
    const listening = source.indexOf("server.on('listening'");
    const open = source.indexOf('new SqliteMailbox');
    expect(listening).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThan(listening);
    expect(source.slice(0, listening)).not.toContain('new SqliteMailbox');
  });

  it('does not expose the concrete SQLite store through public barrels', async () => {
    const barrels = await Promise.all([
      fs.readFile(path.join(ROOT, 'packages/core/src/index.ts'), 'utf8'),
      fs.readFile(path.join(ROOT, 'packages/core/src/coordination/index.ts'), 'utf8'),
    ]);
    expect(barrels.join('\n')).not.toMatch(/export\s+\{[^}]*SqliteMailbox/u);
  });

  it('does not provide a production escape hatch back to legacy mailbox files', async () => {
    const legacySources = await Promise.all([
      fs.readFile(path.join(ROOT, 'packages/core/src/coordination/global-mailbox.ts'), 'utf8'),
      fs.readFile(path.join(ROOT, 'packages/core/src/coordination/mailbox.ts'), 'utf8'),
      fs.readFile(
        path.join(ROOT, 'packages/core/src/coordination/mailbox-credential-store.ts'),
        'utf8',
      ),
    ]);
    expect(legacySources.join('\n')).not.toContain('WRONGSTACK_MAILBOX_ALLOW_LEGACY_FILES');
    expect(legacySources.join('\n')).not.toContain('WRONGSTACK_MAILBOX_ALLOW_CREDENTIAL_FILES');
  });
});
