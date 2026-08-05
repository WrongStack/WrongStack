import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PLUGIN_SPECIFIERS } from '@wrongstack/plugins/factories';
import { OFFICIAL_PLUGIN_MANIFEST } from '@wrongstack/plugins/manifest';
import { describe, expect, it } from 'vitest';
import { PLUGIN_AUDIT_ENTRIES } from '../src/plugin-management.js';
import { BUILTIN_PLUGIN_FACTORIES } from '../src/wiring/plugins.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginsRoot = path.resolve(testDir, '..', '..', 'plugins');
const NON_PACKAGE_AUDIT_NAMES = new Set([
  'wstack-prompts',
  'wstack-sync',
  'wstack-chimera',
  'wstack-auto-review',
  'wstack-skills',
  '@wrongstack/plug-lsp',
  'telegram',
]);

/**
 * Subpath exports that are *not* plugins — they are shared helpers
 * (like the language-agnostic runtime). They are intentionally part of
 * the package's surface area but are excluded from plugin-level
 * parity checks.
 */
const NON_PLUGIN_EXPORT_NAMES = new Set([
  'audit',
  'factories',
  'manifest',
  'plugin-audit-catalog',
  'runtime',
]);

async function bundledPluginNames(): Promise<string[]> {
  const entries = await fs.readdir(path.join(pluginsRoot, 'src'), { withFileTypes: true });
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          await fs.access(path.join(pluginsRoot, 'src', entry.name, 'index.ts'));
          return entry.name;
        } catch {
          return null;
        }
      }),
  );
  return names
    .filter((name): name is string => name !== null)
    .filter((name) => !NON_PLUGIN_EXPORT_NAMES.has(name))
    .sort();
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function expectSameNames(surface: string, expected: string[], actual: Iterable<string>): void {
  const allActualNames = [...actual].sort();
  const actualNames = [...new Set(allActualNames)];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actualNames);
  expect({
    surface,
    missing: expected.filter((name) => !actualSet.has(name)),
    extra: actualNames.filter((name) => !expectedSet.has(name)),
    duplicates: actualNames.filter(
      (name) => allActualNames.indexOf(name) !== allActualNames.lastIndexOf(name),
    ),
  }).toEqual({ surface, missing: [], extra: [], duplicates: [] });
}

describe('@wrongstack/plugins registration parity', () => {
  it('keeps host-owned runtime factories and audit rows in sync', async () => {
    const official = new Set(OFFICIAL_PLUGIN_MANIFEST.map((entry) => entry.name));
    const runtimeHostNames = (
      await Promise.all(BUILTIN_PLUGIN_FACTORIES.map((factory) => factory()))
    )
      .map((plugin) => plugin.name)
      .filter((name) => !official.has(name));
    const auditHostNames = PLUGIN_AUDIT_ENTRIES.map((entry) => entry.name).filter(
      (name) => !official.has(name),
    );
    expectSameNames('host plugin audit rows', runtimeHostNames.sort(), auditHostNames);
  });

  it('keeps source, package, build, export, catalog, and CLI factory surfaces in sync', async () => {
    const expected = OFFICIAL_PLUGIN_MANIFEST.map((entry) => entry.name).sort();
    const sourceNames = await bundledPluginNames();
    const [packageText, indexSource] = await Promise.all([
      fs.readFile(path.join(pluginsRoot, 'package.json'), 'utf8'),
      fs.readFile(path.join(pluginsRoot, 'src', 'generated-plugin-exports.ts'), 'utf8'),
    ]);

    const packageJson = JSON.parse(packageText) as {
      description?: string;
      exports?: Record<string, unknown>;
    };
    const packageExports = Object.keys(packageJson.exports ?? {})
      .filter((specifier) => specifier.startsWith('./'))
      .map((specifier) => specifier.slice(2))
      .filter((name) => !NON_PLUGIN_EXPORT_NAMES.has(name));
    const indexExports = matches(indexSource, /from ['"]\.\/([^/'"]+)\/index\.js['"]/g).filter(
      (name) => !NON_PLUGIN_EXPORT_NAMES.has(name),
    );
    const factoryImports = OFFICIAL_PLUGIN_SPECIFIERS.map((specifier) =>
      specifier.replace('@wrongstack/plugins/', ''),
    );
    const auditNames = PLUGIN_AUDIT_ENTRIES.map((entry) => entry.name).filter(
      (name) => !NON_PACKAGE_AUDIT_NAMES.has(name),
    );

    expectSameNames('source directories', expected, sourceNames);
    expectSameNames('package.json exports', expected, packageExports);
    expectSameNames('src/index.ts exports', expected, indexExports);
    expectSameNames('PLUGIN_AUDIT_ENTRIES', expected, auditNames);
    expectSameNames('BUILTIN_PLUGIN_FACTORIES imports', expected, factoryImports);
  });
});
