#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = path.join(repoRoot, 'packages/core');
const architectureRoot = path.join(repoRoot, 'architecture');
const write = process.argv.includes('--write');

/**
 * Normalize file content for deterministic cross-platform snapshots.
 *
 * Strips BOM and converts CRLF → LF so the snapshot is identical on Windows
 * and Linux regardless of git checkout state or Node version. Without this,
 * `readFileSync` on Windows can produce slightly different strings than on
 * Linux, causing "snapshot is stale" CI failures that pass locally.
 */
function readNormalized(file) {
  return readFileSync(file, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
}
const apiPolicy = JSON.parse(
  readNormalized(path.join(architectureRoot, 'core-api-policy.json'), 'utf8'),
);

const ownership = {
  chronicle: ['storage/repository implementation', 'focused repository or runtime subsystem'],
  coordination: [
    'coordination implementation',
    'Core subpath until physical extraction is justified',
  ],
  core: ['agent-domain contract', 'Core'],
  defaults: ['compatibility-only', 'deprecated compatibility surface'],
  design: ['product feature', 'feature/plugin owner behind a focused public facade'],
  execution: ['concrete runtime default', 'Runtime pilot candidate after R2/R3'],
  extension: ['agent-domain contract', 'Core plugin/extension contract'],
  goal: ['storage/repository implementation', 'repository behind persistence primitive'],
  hooks: ['product feature', 'feature/plugin owner'],
  hq: ['host/application concern', 'protocol DTOs only in Core; runtime elsewhere'],
  infrastructure: ['concrete runtime default', 'Runtime or focused infrastructure package'],
  kernel: ['kernel primitive', 'Core'],
  middleware: ['concrete runtime default', 'Runtime composition'],
  models: ['concrete runtime default', 'Runtime or Providers'],
  notifications: ['host/application concern', 'host adapter behind contract'],
  observability: ['concrete runtime default', 'preferred Runtime pilot'],
  plugin: ['agent-domain contract', 'Core plugin API'],
  plugins: ['product feature', '@wrongstack/plugins'],
  prompts: ['product feature', 'plugin/runtime implementation'],
  registry: ['concrete runtime default', 'Runtime composition'],
  replay: ['storage/repository implementation', 'repository/runtime implementation'],
  security: ['concrete runtime default', 'Runtime security subsystem'],
  'session-catalog': [
    'storage/repository implementation',
    'project-scoped ownership and catalog subsystem',
  ],
  skills: ['product feature', 'skills implementation package or Runtime'],
  statusline: ['host/application concern', 'CLI/TUI presentation contract; host rendering stays outside Core'],
  storage: ['storage/repository implementation', 'repositories over dependency-free persistence'],
  tasking: ['agent-domain contract', 'Core tasking subpath'],
  tools: ['host/application concern', '@wrongstack/tools or product plugin'],
  types: ['agent-domain contract', 'Core type-only subpaths'],
  utils: ['kernel primitive', 'split dependency-free primitives from concrete helpers'],
  // wiring: pure-logic shared infrastructure (e.g. the WrongProxy URL
  // rewriter consumed by both cli and runtime; side-effectful companions
  // like the periodic probe stay in their consuming packages).
  wiring: ['concrete runtime default', 'Runtime or focused infrastructure package'],
  worktree: ['concrete runtime default', 'Runtime or focused worktree implementation'],
};

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['dist', 'node_modules', '.git', 'website'].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, '/');
}

function withoutComments(source) {
  let result = '';
  let state = 'code';
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        result += char;
      } else result += ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        result += '  ';
        index++;
        state = 'code';
      } else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'code') {
      if (char === '/' && next === '/') {
        result += '  ';
        index++;
        state = 'line-comment';
      } else if (char === '/' && next === '*') {
        result += '  ';
        index++;
        state = 'block-comment';
      } else {
        result += char;
        if (char === "'") state = 'single-quote';
        else if (char === '"') state = 'double-quote';
        else if (char === '`') state = 'template';
      }
      continue;
    }
    result += char;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (
      (state === 'single-quote' && char === "'") ||
      (state === 'double-quote' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code';
    }
  }
  return result;
}

function sourceForExport(target) {
  if (typeof target === 'string') return undefined;
  const dist = target?.import;
  if (typeof dist !== 'string' || !dist.startsWith('./dist/') || !dist.endsWith('.js'))
    return undefined;
  return path.join(coreRoot, dist.replace('./dist/', 'src/').replace(/\.js$/, '.ts'));
}

function exportDeclarations(source) {
  const text = readNormalized(source, 'utf8');
  const declarations = [];
  const patterns = [
    /export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?/g,
    /export\s+\*\s+from\s+['"][^'"]+['"];?/g,
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|function|const|enum)\s+[A-Za-z_$][\w$]*/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern))
      declarations.push(match[0].replace(/\s+/g, ' ').trim());
  }
  return [...new Set(declarations)].sort();
}

function buildApiSnapshot() {
  const manifest = JSON.parse(readNormalized(path.join(coreRoot, 'package.json'), 'utf8'));
  const subpaths = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const source = sourceForExport(target);
    subpaths.push({
      subpath,
      target,
      source: source && existsSync(source) ? relative(source) : undefined,
      declarations: source && existsSync(source) ? exportDeclarations(source) : [],
    });
  }

  const directories = readdirSync(path.join(coreRoot, 'src'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const unclassified = directories.filter((name) => !ownership[name]);
  if (unclassified.length > 0)
    throw new Error(`Unclassified Core directories: ${unclassified.join(', ')}`);
  const inventory = directories.map((name) => {
    const files = walk(path.join(coreRoot, 'src', name)).filter((file) =>
      /\.(?:ts|tsx)$/.test(file),
    );
    const lines = files.reduce(
      (total, file) => total + readNormalized(file, 'utf8').split('\n').length,
      0,
    );
    return {
      directory: name,
      classification: ownership[name][0],
      intendedOwner: ownership[name][1],
      sourceFiles: files.length,
      sourceLines: lines,
    };
  });
  return {
    schemaVersion: 1,
    package: manifest.name,
    packageVersion: manifest.version,
    policy: 'Root is compatibility-only; new imports use owned domain subpaths.',
    subpaths,
    inventory,
  };
}

function buildUsageSnapshot() {
  const roots = ['packages', 'apps', 'scripts']
    .map((name) => path.join(repoRoot, name))
    .filter(existsSync);
  const files = roots.flatMap(walk).filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));
  const usages = new Map();
  const record = (file, specifier, typeOnly) => {
    if (!/^@wrongstack\/core(?:\/|$)/u.test(specifier)) return;
    const key = `${specifier}\0${relative(file)}`;
    const entry = usages.get(key) ?? {
      specifier,
      file: relative(file),
      typeOnly: 0,
      runtimeOrMixed: 0,
    };
    if (typeOnly) entry.typeOnly++;
    else entry.runtimeOrMixed++;
    usages.set(key, entry);
  };
  for (const file of files) {
    if (/(?:^|[\\/])dist(?:\.[^\\/]+)?[\\/]/u.test(file)) continue;
    const source = withoutComments(readNormalized(file, 'utf8'));
    const staticPattern =
      /\b(import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"](@wrongstack\/core(?:\/[^'"]*)?)['"]/gu;
    for (const match of source.matchAll(staticPattern)) {
      const clause = match[3] ?? '';
      const named = clause.match(/\{([\s\S]*?)\}/u)?.[1];
      const allNamedTypeOnly = named
        ?.split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .every((part) => /^type\s+/u.test(part));
      record(file, match[4], !!match[2] || allNamedTypeOnly);
    }
    const sideEffectPattern = /\bimport\s*['"](@wrongstack\/core(?:\/[^'"]*)?)['"]/gu;
    for (const match of source.matchAll(sideEffectPattern)) record(file, match[1], false);
    const dynamicPattern =
      /\b(import|require)\s*\(\s*['"](@wrongstack\/core(?:\/[^'"]*)?)['"]\s*\)/gu;
    for (const match of source.matchAll(dynamicPattern)) {
      const before = source.slice(Math.max(0, match.index - 16), match.index);
      record(file, match[2], /(?:typeof|type)\s*$/u.test(before));
    }
  }
  const entries = [...usages.values()].sort((a, b) =>
    a.specifier === b.specifier
      ? a.file.localeCompare(b.file)
      : a.specifier.localeCompare(b.specifier),
  );
  const bySpecifier = {};
  for (const entry of entries) {
    const aggregate = bySpecifier[entry.specifier] ?? { files: 0, typeOnly: 0, runtimeOrMixed: 0 };
    aggregate.files++;
    aggregate.typeOnly += entry.typeOnly;
    aggregate.runtimeOrMixed += entry.runtimeOrMixed;
    bySpecifier[entry.specifier] = aggregate;
  }
  return {
    schemaVersion: 1,
    scope: 'packages, apps, scripts; website and generated output excluded',
    rootImportFiles: entries.filter((entry) => entry.specifier === '@wrongstack/core').length,
    bySpecifier,
    usages: entries,
  };
}

function emit(name, value) {
  const target = path.join(architectureRoot, name);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (write) {
    writeFileSync(target, serialized);
    return;
  }
  if (!existsSync(target) || readNormalized(target, 'utf8') !== serialized) {
    throw new Error(
      `${relative(target)} is stale; run node scripts/snapshot-core-public-api.mjs --write`,
    );
  }
}

const apiSnapshot = buildApiSnapshot();
const usageSnapshot = buildUsageSnapshot();
if (
  !Number.isInteger(apiPolicy.maxRootImportFiles) ||
  apiPolicy.maxRootImportFiles < 0 ||
  usageSnapshot.rootImportFiles !== apiPolicy.maxRootImportFiles
) {
  throw new Error(
    `Core root import ratchet drifted to ${usageSnapshot.rootImportFiles}; ` +
      `architecture/core-api-policy.json records ${String(apiPolicy.maxRootImportFiles)}. ` +
      `Lower the policy in the same change when migrations remove consumers; never raise it to admit new ones.`,
  );
}
emit('core-public-api-snapshot.json', apiSnapshot);
emit('core-public-api-usage.json', usageSnapshot);
console.log(write ? 'Core API snapshots written.' : 'Core API snapshots are current.');
