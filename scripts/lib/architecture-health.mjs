import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

function toPosix(value) {
  return value.replaceAll(path.sep, '/');
}

function repoRelative(repoRoot, value) {
  return toPosix(path.relative(repoRoot, value));
}

const CLI_SLASH_COMMAND_ROOT = 'packages/cli/src/slash-commands/';
const CLI_SLASH_COMMAND_COMPOSITION_ROOT = `${CLI_SLASH_COMMAND_ROOT}index.ts`;

/**
 * Reusable runtime code must not depend on command adapters. The command
 * registry entry point is the sole exception: composition roots may import it
 * to install commands, but shared behavior belongs in cli/services.
 */
export function findNonCommandSlashImports(moduleEdges) {
  return moduleEdges.filter(
    (edge) =>
      edge.to.startsWith(CLI_SLASH_COMMAND_ROOT) &&
      edge.to !== CLI_SLASH_COMMAND_COMPOSITION_ROOT &&
      !edge.from.startsWith(CLI_SLASH_COMMAND_ROOT),
  );
}

async function pathExists(value) {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function walk(dir, predicate) {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, predicate)));
    } else if (entry.isFile() && predicate(full, entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(file) {
  return /\.test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file);
}

export function collectModuleSpecifiers(sourceText, _fileName) {
  const imports = [];
  function add(specifier, typeOnly, syntax) {
    /* istanbul ignore if -- regex capture groups below always produce strings */
    if (typeof specifier !== 'string' || specifier.length === 0) return;
    imports.push({ specifier, typeOnly, syntax });
  }

  // TypeScript 7 no longer exposes the historical compiler AST from the root
  // package. This intentionally narrow scanner handles the module forms used
  // in this repository without binding architecture verification to an
  // unstable compiler API. Its behavior is covered by repository fixtures.
  const scannedText = stripSourceComments(sourceText);
  const staticImport = /\bimport\s+(type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of scannedText.matchAll(staticImport)) {
    const clause = match[2].trim();
    const namedOnlyType =
      /^\{[\s\S]*\}$/.test(clause) &&
      clause
        .slice(1, -1)
        .split(',')
        .filter(Boolean)
        .every((item) => /^\s*type\b/.test(item));
    add(match[3], Boolean(match[1]) || namedOnlyType, 'import');
  }

  const sideEffectImport = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of scannedText.matchAll(sideEffectImport)) add(match[1], false, 'import');

  const staticExport = /\bexport\s+(type\s+)?(?:\*|\{[\s\S]*?\})\s*(?:from\s*)['"]([^'"]+)['"]/g;
  for (const match of scannedText.matchAll(staticExport)) {
    const statement = match[0];
    const bodyMatch = statement.match(/\{([\s\S]*?)\}/);
    const namedOnlyType =
      Boolean(bodyMatch) &&
      bodyMatch[1]
        .split(',')
        .filter(Boolean)
        .every((item) => /^\s*type\b/.test(item));
    add(match[2], Boolean(match[1]) || namedOnlyType, 'export');
  }

  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of scannedText.matchAll(dynamicImport)) {
    const prefix = scannedText.slice(Math.max(0, match.index - 40), match.index);
    const suffix = scannedText.slice(
      match.index + match[0].length,
      match.index + match[0].length + 40,
    );
    const typeOnly =
      /(?:\btype\b|\btypeof\s*)$/.test(prefix.trimEnd()) || /^\s*\.\s*[A-Z_$]/.test(suffix);
    add(match[1], typeOnly, 'dynamic-import');
  }

  const requireCall = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of scannedText.matchAll(requireCall)) add(match[1], false, 'require');

  const importEquals =
    /\bimport\s+(type\s+)?[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of scannedText.matchAll(importEquals))
    add(match[2], Boolean(match[1]), 'import-equals');

  return imports;
}

// Keywords that, when they are the previous significant token, mean a `/`
// begins a regular-expression literal rather than a division operator.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'case',
  'throw',
  'yield',
  'await',
]);

// Punctuators that, when they are the previous significant token, mean a `/`
// begins a regular-expression literal rather than a division operator. `}`,
// `)`, `]`, identifiers, and digits are deliberately excluded: after those a
// `/` is division, and mis-reading division as a regex would blank real code.
// `<` and `>` are also excluded: in this TSX-heavy repository a `/` after `<`
// is almost always a JSX closing tag (`</div>`), and a `/` after a lone `>` is
// more likely relational division (`a > / b`) than `a > /re/`. The `=> /re/`
// arrow case is special-cased in regexLiteralCanStart instead.
const REGEX_PRECEDING_CHARS = new Set([
  '(',
  '[',
  ',',
  ':',
  ';',
  '{',
  '=',
  '+',
  '-',
  '*',
  '&',
  '|',
  '!',
  '?',
  '~',
  '^',
  '%',
]);

function regexLiteralCanStart(emitted) {
  const prevMatch = emitted.match(/\S\s*$/);
  const prevChar = prevMatch ? prevMatch[0].trim() : '';
  if (prevChar === '') return true;
  // Arrow-function body: `=> /re/` reliably starts a regex. A lone `>` does
  // not, because `a > / b` is relational division.
  if (/=>\s*$/.test(emitted)) return true;
  if (prevChar === '+' || prevChar === '-') {
    // `x++ / 2` or `x-- / 2` is a postfix increment/decrement followed by
    // division, not a regex. A lone `+`/`-` (binary/unary) before `/` can only
    // start a regex literal in valid JavaScript.
    return !/([+-])\1\s*$/.test(emitted);
  }
  if (REGEX_PRECEDING_CHARS.has(prevChar)) return true;
  const wordMatch = emitted.match(/[A-Za-z_$][\w$]*\s*$/);
  return Boolean(wordMatch && REGEX_PRECEDING_KEYWORDS.has(wordMatch[0].trim()));
}

function stripSourceComments(text) {
  let result = '';
  let state = 'code';
  let regexInClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (state === 'line-comment') {
      if (current === '\n') {
        result += '\n';
        state = 'code';
      } else result += ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        result += '  ';
        index += 1;
        state = 'code';
      } else result += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'template') {
      if (current === '\\' && next !== undefined) {
        result += '  ';
        index += 1;
      } else if (current === '`') {
        result += '`';
        state = 'code';
      } else result += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote') {
      result += current;
      if (current === '\\' && next !== undefined) {
        result += next;
        index += 1;
        continue;
      }
      if (
        (state === 'single-quote' && current === "'") ||
        (state === 'double-quote' && current === '"')
      )
        state = 'code';
      continue;
    }
    if (state === 'regex') {
      if (current === '\\' && next !== undefined) {
        result += '  ';
        index += 1;
      } else if (current === '[') {
        regexInClass = true;
        result += ' ';
      } else if (current === ']') {
        regexInClass = false;
        result += ' ';
      } else if (current === '/' && !regexInClass) {
        // Closing slash: emit a value-like placeholder so a following `/`
        // is treated as division, not the start of another regex literal.
        result += '0';
        regexInClass = false;
        state = 'code';
      } else result += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (current === '/' && next === '/') {
      result += '  ';
      index += 1;
      state = 'line-comment';
    } else if (current === '/' && next === '*') {
      result += '  ';
      index += 1;
      state = 'block-comment';
    } else if (current === '/' && regexLiteralCanStart(result)) {
      // Regular-expression literal: blank its body so quote characters inside
      // the pattern cannot desynchronise the string/template state machine and
      // leak comment text (e.g. `// export { X } from '..'`) into the output.
      result += ' ';
      regexInClass = false;
      state = 'regex';
    } else if (current === "'") {
      result += current;
      state = 'single-quote';
    } else if (current === '"') {
      result += current;
      state = 'double-quote';
    } else if (current === '`') {
      result += current;
      state = 'template';
    } else result += current;
  }
  return result;
}

function candidatePaths(basePath, sourceExtensions) {
  const ext = path.extname(basePath);
  const withoutRuntimeExtension = /\.(?:js|jsx|mjs|cjs)$/.test(ext)
    ? basePath.slice(0, -ext.length)
    : basePath;
  const candidates = [basePath];
  for (const sourceExt of sourceExtensions) {
    candidates.push(`${withoutRuntimeExtension}${sourceExt}`);
  }
  for (const sourceExt of sourceExtensions) {
    candidates.push(path.join(withoutRuntimeExtension, `index${sourceExt}`));
  }
  return [...new Set(candidates)];
}

async function resolveRelativeModule(fromFile, specifier, knownFiles, sourceExtensions) {
  if (!specifier.startsWith('.')) return null;
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of candidatePaths(basePath, sourceExtensions)) {
    const normalized = path.normalize(candidate);
    if (knownFiles.has(normalized)) return normalized;
  }
  return null;
}

export function stronglyConnectedComponents(nodes, adjacency) {
  let index = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function connect(node) {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!indexes.has(next)) {
        connect(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(next)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    const selfLoop =
      component.length === 1 && (adjacency.get(component[0]) ?? new Set()).has(component[0]);
    if (component.length > 1 || selfLoop) components.push(component.sort());
  }

  for (const node of [...nodes].sort()) {
    if (!indexes.has(node)) connect(node);
  }
  return components.sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/**
 * Runtime symbols a file exports.
 *
 * Types are excluded on purpose: an unused type costs nothing at runtime, and
 * including them buried the signal this check exists for — code that ships,
 * carries coverage, and never runs.
 *
 * Re-exports (`export { x } from './y.js'`) are NOT collected here. A barrel
 * forwarding a name is not the name's definition, and counting it as one would
 * report the same symbol from every layer that passes it along.
 *
 * Known blind spot: methods on an exported object are not module exports, so
 * `viz-store`'s `decayActivity`/`prunesStale` — the audit's own headline case,
 * zustand store actions with tests and no caller — do not appear. Reaching them
 * needs member-level analysis, which is a different tool. The four other cases
 * from that list (`tui/input-validation`, `settings-panel-reducers`,
 * `cli/config-history`, `subcommands/handlers/config-history`) are all caught.
 */
const EXPORT_DECLARATION =
  /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}(\s*from\s*['"][^'"]+['"])?/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

export function collectRuntimeExports(sourceText) {
  const text = stripSourceComments(sourceText);
  const names = new Set();
  for (const match of text.matchAll(EXPORT_DECLARATION)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of text.matchAll(EXPORT_LIST)) {
    if (match[2]) continue; // `export { … } from` — a re-export, not a definition
    for (const part of (match[1] ?? '').split(',')) {
      const segment = part.trim();
      if (!segment || /^type\s/.test(segment)) continue;
      const aliased = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(segment);
      const name = aliased ? aliased[1] : segment;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Distinct identifiers appearing anywhere in a file. */
export function collectIdentifiers(sourceText) {
  return new Set(stripSourceComments(sourceText).match(IDENTIFIER) ?? []);
}

/**
 * Exports that only tests ever mention.
 *
 * Matching is by NAME, across every file in the workspace, rather than by
 * resolved module graph. That is deliberate: the graph this script builds
 * covers relative imports only, so a symbol consumed cross-package through a
 * barrel (`import { capSubject } from '@wrongstack/core/utils'`) would look
 * unreachable. Name matching cannot miss that consumer. It can only err the
 * other way — a name that collides with an unrelated symbol elsewhere reads as
 * "used" and is silently dropped from the report. For a gate, under-reporting
 * is the safe direction.
 *
 * Occurrences inside the defining file itself do not count. A symbol exported
 * for a test, used nowhere else, is what this looks for.
 */
export function findTestOnlyExports({ exportsByFile, sourceIdentifiers, testIdentifiers }) {
  const found = [];
  for (const [file, names] of exportsByFile) {
    for (const name of names) {
      const usage = sourceIdentifiers.get(name);
      // Seen in ≥2 source files, or in exactly one that is not the definer.
      if (usage && (usage.files > 1 || usage.firstFile !== file)) continue;
      if (!testIdentifiers.has(name)) continue;
      found.push({ file, name });
    }
  }
  found.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return found;
}

/**
 * Ratchet, not a cleanup order. The workspace carries hundreds of these — many
 * are `*Coverage` handles minted by the coverage initiative — so failing on the
 * whole set would just be turned off. The baseline freezes today's list; the
 * check fires when a NEW export lands that only a test consumes, which is the
 * moment it is cheapest to ask whether the code is wired at all.
 */
export function validateTestOnlyExportBaseline(current, baseline) {
  const errors = [];
  const expected = new Map(
    Object.entries(baseline.files ?? {}).map(([file, names]) => [file, new Set(names)]),
  );
  const seen = new Map();
  for (const item of current) {
    if (!seen.has(item.file)) seen.set(item.file, new Set());
    seen.get(item.file).add(item.name);
    if (!expected.get(item.file)?.has(item.name)) {
      errors.push(
        `${item.file}: "${item.name}" is exported but only tests reference it; wire it, drop it, or record it in architecture/test-only-exports.json`,
      );
    }
  }
  for (const [file, names] of expected) {
    for (const name of names) {
      if (!seen.get(file)?.has(name)) {
        errors.push(
          `${file}: "${name}" is no longer test-only; remove it from architecture/test-only-exports.json in the same change`,
        );
      }
    }
  }
  return { errors };
}

export function validateHotspotBaseline(sourceMetrics, baseline) {
  const errors = [];
  const current = new Map(sourceMetrics.map((item) => [item.file, item]));
  const candidates = sourceMetrics.filter((item) => item.lines >= baseline.thresholdLines);
  for (const item of candidates) {
    const expected = baseline.files[item.file];
    if (!expected) {
      errors.push(
        `${item.file}: new ${item.lines}-line hotspot is not in architecture/hotspots.json`,
      );
      continue;
    }
    if (item.lines !== expected.lines) {
      const direction = item.lines > expected.lines ? 'grew' : 'shrunk';
      errors.push(
        `${item.file}: hotspot ${direction} from ${expected.lines} to ${item.lines} lines; review and update the ratchet in the same change`,
      );
    }
    if (item.relativeImports !== expected.relativeImports) {
      const direction = item.relativeImports > expected.relativeImports ? 'increased' : 'decreased';
      errors.push(
        `${item.file}: relative import fan-out ${direction} from ${expected.relativeImports} to ${item.relativeImports}; review and update the ratchet in the same change`,
      );
    }
  }
  for (const file of Object.keys(baseline.files)) {
    const item = current.get(file);
    if (!item || item.lines < baseline.thresholdLines) {
      errors.push(`${file}: stale hotspot baseline; remove or tighten it in the same change`);
    }
  }
  return { errors, candidates };
}

function findGraphCycles(nodes, edges, runtimeOnly) {
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node, new Set());
  for (const edge of edges) {
    if (runtimeOnly && edge.typeOnly) continue;
    adjacency.get(edge.from)?.add(edge.to);
  }
  return stronglyConnectedComponents(nodes, adjacency);
}

function findPackageCycles(packages) {
  const names = packages.map((item) => item.name);
  const adjacency = new Map(names.map((name) => [name, new Set()]));
  for (const pkg of packages) {
    for (const dependency of pkg.workspaceDependencies) adjacency.get(pkg.name).add(dependency);
  }
  return stronglyConnectedComponents(names, adjacency);
}

function matchesTestProject(file, project) {
  if (project.exactFiles?.includes(file)) return true;
  if (project.excludeFiles?.includes(file)) return false;
  if (project.excludePrefixes?.some((prefix) => file.startsWith(prefix))) return false;
  return Boolean(project.includePrefixes?.some((prefix) => file.startsWith(prefix)));
}

function stripJsonComments(text) {
  return stripSourceComments(text).replace(/,\s*([}\]])/g, '$1');
}

export function globToRegExp(pattern) {
  let result = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];
    if (character === '*' && next === '*' && afterNext === '/') {
      result += '(?:.*/)?';
      index += 2;
    } else if (character === '*' && next === '*') {
      result += '.*';
      index += 1;
    } else if (character === '*') result += '[^/]*';
    else if (character === '?') result += '[^/]';
    else result += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${result}$`);
}

export async function parseTsConfigFiles(repoRoot, packageDir, packageTestFiles) {
  const entries = await readdir(packageDir, { withFileTypes: true });
  const configs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^tsconfig.*\.json$/.test(entry.name)) continue;
    const configPath = path.join(packageDir, entry.name);
    let config;
    try {
      config = JSON.parse(stripJsonComments(await readFile(configPath, 'utf8')));
    } catch (error) {
      configs.push({
        path: repoRelative(repoRoot, configPath),
        error: error.message,
        testFiles: [],
      });
      continue;
    }
    const includes = (config.include ?? []).map((item) => globToRegExp(toPosix(item)));
    const excludes = (config.exclude ?? []).map((item) => globToRegExp(toPosix(item)));
    const ownedTests = packageTestFiles
      .filter((file) => {
        const relative = toPosix(path.relative(packageDir, file));
        return (
          includes.some((pattern) => pattern.test(relative)) &&
          !excludes.some((pattern) => pattern.test(relative))
        );
      })
      .map((file) => repoRelative(repoRoot, file))
      .sort();
    configs.push({
      path: repoRelative(repoRoot, configPath),
      error: null,
      testFiles: ownedTests,
    });
  }
  return configs.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeExceptionMembers(members) {
  return [...members].map((item) => toPosix(item)).sort();
}

function cycleKey(kind, members) {
  return `${kind}:${normalizeExceptionMembers(members).join('|')}`;
}

function validateExceptions(exceptionDocument, activeCycles, now) {
  const errors = [];
  const matched = new Set();
  const byKey = new Map();
  const ids = new Set();
  for (const exception of exceptionDocument.exceptions ?? []) {
    const required = [
      'id',
      'kind',
      'members',
      'owner',
      'reason',
      'introduced',
      'reviewBy',
      'removeWhen',
      'canonicalTask',
    ];
    for (const field of required) {
      if (
        exception[field] === undefined ||
        exception[field] === '' ||
        (Array.isArray(exception[field]) && exception[field].length === 0)
      ) {
        errors.push(`${exception.id ?? '<missing-id>'}: missing required field '${field}'`);
      }
    }
    if (ids.has(exception.id)) errors.push(`${exception.id}: duplicate exception id`);
    ids.add(exception.id);
    if (
      !['runtime-module-cycle', 'type-module-cycle', 'slash-command-import'].includes(
        exception.kind,
      )
    ) {
      errors.push(`${exception.id ?? '<missing-id>'}: unsupported kind '${exception.kind}'`);
      continue;
    }
    const reviewDate = new Date(`${exception.reviewBy}T23:59:59Z`);
    if (Number.isNaN(reviewDate.getTime())) {
      errors.push(`${exception.id}: invalid reviewBy date '${exception.reviewBy}'`);
    } else if (reviewDate < now) {
      errors.push(`${exception.id}: exception expired on ${exception.reviewBy}`);
    }
    if (exception.kind === 'runtime-module-cycle' || exception.kind === 'type-module-cycle') {
      const key = cycleKey(exception.kind, exception.members ?? []);
      if (byKey.has(key)) errors.push(`${exception.id}: duplicates exception ${byKey.get(key)}`);
      byKey.set(key, exception.id);
    }
  }

  const unexcepted = [];
  for (const cycle of activeCycles) {
    const key = cycleKey(cycle.kind, cycle.members);
    const exceptionId = byKey.get(key);
    if (exceptionId) matched.add(exceptionId);
    else unexcepted.push(cycle);
  }

  const stale = (exceptionDocument.exceptions ?? [])
    .filter(
      (exception) =>
        (exception.kind === 'runtime-module-cycle' || exception.kind === 'type-module-cycle') &&
        !matched.has(exception.id),
    )
    .map((exception) => `${exception.id}: exception no longer matches an active cycle`);
  errors.push(...stale);
  return { errors, unexcepted, matched: [...matched].sort() };
}

export async function buildArchitectureHealth({
  repoRoot,
  registry,
  exceptions,
  hotspots,
  testOnlyExports = { schemaVersion: 1, files: {} },
  now = new Date(),
}) {
  const sourceExtensions = new Set(registry.sourceExtensions);
  const packages = [];
  const allSourceFiles = [];
  const allTestFiles = [];

  for (const workspaceRoot of registry.scope.workspaceRoots) {
    const root = path.join(repoRoot, workspaceRoot);
    if (!(await pathExists(root))) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(root, entry.name);
      const relativeDir = repoRelative(repoRoot, packageDir);
      if (
        registry.scope.excludedPaths.some(
          (excluded) => relativeDir === excluded || relativeDir.startsWith(`${excluded}/`),
        )
      )
        continue;
      const manifestPath = path.join(packageDir, 'package.json');
      if (!(await pathExists(manifestPath))) continue;
      const manifest = await readJson(manifestPath);
      const sourceRoot = path.join(packageDir, 'src');
      const sourceFiles = await walk(
        sourceRoot,
        (file) => sourceExtensions.has(path.extname(file)) && !isTestFile(file),
      );
      const packageTests = await walk(packageDir, (file) => isTestFile(file));
      allSourceFiles.push(...sourceFiles);
      allTestFiles.push(...packageTests);
      packages.push({
        name: manifest.name ?? relativeDir,
        dir: relativeDir,
        manifest,
        sourceFiles,
        testFiles: packageTests,
      });
    }
  }

  const workspaceNames = new Set(packages.map((item) => item.name));
  const testRelativeSet = new Set(allTestFiles.map((file) => repoRelative(repoRoot, file)));
  for (const pkg of packages) {
    const dependencyFields = [
      pkg.manifest.dependencies,
      pkg.manifest.optionalDependencies,
      pkg.manifest.peerDependencies,
    ];
    pkg.workspaceDependencies = [
      ...new Set(
        dependencyFields
          .flatMap((field) => Object.keys(field ?? {}))
          .filter((name) => workspaceNames.has(name)),
      ),
    ].sort();
    pkg.tsconfigs = await parseTsConfigFiles(repoRoot, path.join(repoRoot, pkg.dir), pkg.testFiles);
  }

  const knownSourceFiles = new Set(allSourceFiles.map((file) => path.normalize(file)));
  const moduleEdges = [];
  const selfImports = [];
  const unresolvedRelativeImports = [];
  const sourceMetrics = [];
  // Inputs for the test-only-export check, gathered in the pass that already
  // reads every source file rather than in a second walk.
  const exportsByFile = new Map();
  const sourceIdentifiers = new Map();
  for (const file of allSourceFiles) {
    const sourceText = await readFile(file, 'utf8');
    const relativeFile = repoRelative(repoRoot, file);
    const runtimeExports = collectRuntimeExports(sourceText);
    if (runtimeExports.size > 0) exportsByFile.set(relativeFile, runtimeExports);
    for (const identifier of collectIdentifiers(sourceText)) {
      const entry = sourceIdentifiers.get(identifier);
      if (entry) entry.files += 1;
      else sourceIdentifiers.set(identifier, { files: 1, firstFile: relativeFile });
    }
    const specifiers = collectModuleSpecifiers(sourceText, file);
    sourceMetrics.push({
      file: relativeFile,
      lines: sourceText.split(/\r?\n/).length,
      relativeImports: specifiers.filter((item) => item.specifier.startsWith('.')).length,
    });
    for (const item of specifiers) {
      if (!item.specifier.startsWith('.')) continue;
      const target = await resolveRelativeModule(
        file,
        item.specifier,
        knownSourceFiles,
        registry.sourceExtensions,
      );
      if (!target) {
        unresolvedRelativeImports.push({
          from: relativeFile,
          specifier: item.specifier,
          syntax: item.syntax,
        });
        continue;
      }
      const relativeTarget = repoRelative(repoRoot, target);
      if (relativeTarget === relativeFile) {
        selfImports.push({
          from: relativeFile,
          specifier: item.specifier,
          typeOnly: item.typeOnly,
          syntax: item.syntax,
        });
        continue;
      }
      moduleEdges.push({
        from: relativeFile,
        to: relativeTarget,
        typeOnly: item.typeOnly,
        syntax: item.syntax,
      });
    }
  }

  const moduleNodes = allSourceFiles.map((file) => repoRelative(repoRoot, file));
  const nonCommandSlashImports = findNonCommandSlashImports(moduleEdges);
  const runtimeCycles = findGraphCycles(moduleNodes, moduleEdges, true).map((members) => ({
    kind: 'runtime-module-cycle',
    members,
  }));
  const typeCycles = findGraphCycles(moduleNodes, moduleEdges, false).map((members) => ({
    kind: 'type-module-cycle',
    members,
  }));
  const activeCycles = [...runtimeCycles, ...typeCycles];
  const exceptionResult = validateExceptions(exceptions, activeCycles, now);

  const packageCycles = findPackageCycles(packages);
  const coreSrc = path.join(repoRoot, 'packages/core/src');
  const actualCoreAreas = (await readdir(coreSrc, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const registeredCoreAreas = Object.keys(registry.coreAreas).sort();
  const unclassifiedCoreAreas = actualCoreAreas.filter((area) => !registry.coreAreas[area]);
  const staleCoreAreas = registeredCoreAreas.filter((area) => !actualCoreAreas.includes(area));

  const testOwnership = [...testRelativeSet].sort().map((file) => ({
    file,
    runtimeProjects: registry.testProjects
      .filter((project) => matchesTestProject(file, project))
      .map((project) => project.id),
    typecheckProjects: packages.flatMap((pkg) =>
      pkg.tsconfigs
        .filter((config) => config.testFiles.includes(file))
        .map((config) => config.path),
    ),
  }));
  const invalidRuntimeTestOwnership = testOwnership.filter(
    (item) => item.runtimeProjects.length !== 1,
  );
  const testsWithoutTypecheck = testOwnership.filter((item) => item.typecheckProjects.length === 0);
  const testsWithMultipleTypechecks = testOwnership.filter(
    (item) => item.typecheckProjects.length > 1,
  );
  const hotspotResult = validateHotspotBaseline(sourceMetrics, hotspots);

  const testIdentifiers = new Set();
  for (const file of allTestFiles) {
    for (const identifier of collectIdentifiers(await readFile(file, 'utf8'))) {
      testIdentifiers.add(identifier);
    }
  }
  const testOnlyExportList = findTestOnlyExports({
    exportsByFile,
    sourceIdentifiers,
    testIdentifiers,
  });
  const testOnlyExportResult = validateTestOnlyExportBaseline(testOnlyExportList, testOnlyExports);

  sourceMetrics.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const errors = [];
  if (packageCycles.length > 0) errors.push(`${packageCycles.length} workspace package cycle(s)`);
  if (unclassifiedCoreAreas.length > 0)
    errors.push(`unclassified Core areas: ${unclassifiedCoreAreas.join(', ')}`);
  if (staleCoreAreas.length > 0)
    errors.push(`stale Core registry areas: ${staleCoreAreas.join(', ')}`);
  if (invalidRuntimeTestOwnership.length > 0)
    errors.push(
      `${invalidRuntimeTestOwnership.length} test file(s) without exactly one runtime project`,
    );
  for (const edge of nonCommandSlashImports) {
    errors.push(
      `${edge.from}: non-command module imports ${edge.to}; move shared logic to packages/cli/src/services`,
    );
  }
  if (exceptionResult.unexcepted.length > 0)
    errors.push(`${exceptionResult.unexcepted.length} unexcepted module cycle(s)`);
  errors.push(...exceptionResult.errors);
  errors.push(...hotspotResult.errors);
  errors.push(...testOnlyExportResult.errors);

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    scope: registry.scope,
    summary: {
      packages: packages.length,
      sourceFiles: allSourceFiles.length,
      testFiles: allTestFiles.length,
      sourceLines: sourceMetrics.reduce((total, item) => total + item.lines, 0),
      workspaceEdges: packages.reduce(
        (total, item) => total + item.workspaceDependencies.length,
        0,
      ),
      moduleEdges: moduleEdges.length,
      nonCommandSlashImports: nonCommandSlashImports.length,
      runtimeModuleCycles: runtimeCycles.length,
      typeModuleCycles: typeCycles.length,
      testsWithoutTypecheck: testsWithoutTypecheck.length,
      testsWithMultipleTypechecks: testsWithMultipleTypechecks.length,
      testOnlyExports: testOnlyExportList.length,
    },
    errors,
    packageCycles,
    coreAreas: {
      actual: actualCoreAreas,
      registered: registeredCoreAreas,
      unclassified: unclassifiedCoreAreas,
      stale: staleCoreAreas,
    },
    packages: packages
      .map((pkg) => ({
        name: pkg.name,
        dir: pkg.dir,
        sourceFiles: pkg.sourceFiles.length,
        testFiles: pkg.testFiles.length,
        workspaceDependencies: pkg.workspaceDependencies,
        tsconfigs: pkg.tsconfigs.map((config) => ({
          path: config.path,
          error: config.error,
          testFiles: config.testFiles.length,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    cycles: {
      runtime: runtimeCycles,
      type: typeCycles,
      matchedExceptions: exceptionResult.matched,
      unexcepted: exceptionResult.unexcepted,
    },
    testOwnership: {
      runtimeAssignments: testOwnership.map((item) => ({
        file: item.file,
        projects: item.runtimeProjects,
      })),
      invalidRuntime: invalidRuntimeTestOwnership,
      withoutTypecheck: testsWithoutTypecheck,
      multipleTypechecks: testsWithMultipleTypechecks,
    },
    unresolvedRelativeImports,
    selfImports,
    nonCommandSlashImports,
    hotspotCandidates: hotspotResult.candidates,
    hotspots: sourceMetrics.slice(0, 50),
    testOnlyExports: testOnlyExportList,
  };
}

export function renderArchitectureHealthMarkdown(report) {
  const lines = [
    '# Architecture Health Report',
    '',
    `**Generated:** ${report.generatedAt}`,
    `**Scope:** ${report.scope.workspaceRoots.join(', ')}; excluded: ${report.scope.excludedPaths.join(', ') || 'none'}`,
    '',
    '## Summary',
    '',
    '| Measure | Value |',
    '|---|---:|',
    `| Workspace packages | ${report.summary.packages} |`,
    `| Production source files | ${report.summary.sourceFiles} |`,
    `| Production source lines | ${report.summary.sourceLines} |`,
    `| Test files | ${report.summary.testFiles} |`,
    `| Workspace dependency edges | ${report.summary.workspaceEdges} |`,
    `| Relative module edges | ${report.summary.moduleEdges} |`,
    `| Non-command slash imports | ${report.summary.nonCommandSlashImports} |`,
    `| Runtime module cycles | ${report.summary.runtimeModuleCycles} |`,
    `| Type-inclusive module cycles | ${report.summary.typeModuleCycles} |`,
    `| Tests without TypeScript test-project coverage | ${report.summary.testsWithoutTypecheck} |`,
    `| Tests in multiple TypeScript projects | ${report.summary.testsWithMultipleTypechecks} |`,
    '',
    '## Verification result',
    '',
  ];
  if (report.errors.length === 0) lines.push('PASS — no blocking architecture-health errors.');
  else lines.push(...report.errors.map((error) => `- ${error}`));

  lines.push(
    '',
    '## Workspace packages',
    '',
    '| Package | Sources | Tests | Workspace dependencies |',
    '|---|---:|---:|---|',
  );
  for (const pkg of report.packages) {
    lines.push(
      `| ${pkg.name} | ${pkg.sourceFiles} | ${pkg.testFiles} | ${pkg.workspaceDependencies.join(', ') || '—'} |`,
    );
  }

  lines.push('', '## Module cycles', '');
  for (const [label, cycles] of [
    ['Runtime', report.cycles.runtime],
    ['Type-inclusive', report.cycles.type],
  ]) {
    lines.push(`### ${label}`, '');
    if (cycles.length === 0) lines.push('None.', '');
    else {
      for (const cycle of cycles) lines.push(`- ${cycle.members.join(' ↔ ')}`);
      lines.push('');
    }
  }

  lines.push('## Largest production files', '', '| Lines | File |', '|---:|---|');
  for (const hotspot of report.hotspots) lines.push(`| ${hotspot.lines} | \`${hotspot.file}\` |`);
  lines.push('', '## Exports only tests reference', '');
  lines.push(
    `- ${report.summary.testOnlyExports} runtime exports are referenced by tests and by no other production file.`,
    '- Green coverage on one of these proves the function works, not that anything calls it.',
    '- The set is frozen in `architecture/test-only-exports.json`; the check fires on additions.',
  );
  lines.push('', '## TypeScript test coverage debt', '');
  lines.push(
    `- ${report.testOwnership.withoutTypecheck.length} test files are not included in a package TypeScript test project.`,
  );
  lines.push(
    `- ${report.testOwnership.multipleTypechecks.length} test files are included in more than one package TypeScript project.`,
  );
  lines.push(
    '',
    '> This report is generated. Change architecture registry inputs or source code, then regenerate it; do not hand-edit measurements.',
    '',
  );
  return lines.join('\n');
}

/**
 * Narrow test seam for filesystem/parser helpers that are otherwise only
 * reachable through a full repository scan. Production callers should use
 * buildArchitectureHealth; this object exists so edge-case behavior remains
 * executable and does not become unmeasured script code.
 */
export const __architectureHealthTestInternals = {
  pathExists,
  walk,
  isTestFile,
  stripSourceComments,
  candidatePaths,
  resolveRelativeModule,
  findGraphCycles,
  findPackageCycles,
  matchesTestProject,
  stripJsonComments,
  validateExceptions,
};

// ── Committed-evidence freshness gate ────────────────────────────────────
//
// docs/reports/architecture-health-current.{json,md} is committed evidence.
// architecture/README.md requires it to be regenerated "in the same PR that
// intentionally changes the architecture baseline", but nothing enforced that:
// the report went 12 days stale in July 2026 and 3 days stale in August 2026
// without any gate noticing. This check closes that loop.
//
// Semantics:
//   - Timestamps are COMMIT timestamps from git, never file mtimes — mtimes
//     reset on every fresh clone, which would false-fail CI forever.
//   - A commit that touches both a watched source root and the report files
//     counts as fresh: that is the mandated same-PR regeneration flow. Stale
//     means a source-only commit landed strictly AFTER the last report commit.
//   - Report freshness is the OLDER of the .json/.md pair — regenerating only
//     one file still leaves stale evidence on disk.
//   - Non-git contexts (no HEAD, or a git failure) degrade to a written
//     warning, never a hard failure: this is an evidence-hygiene gate, not a
//     correctness gate, and release:check must not die on environment quirks.

/** Roots whose newest commit marks the "sources changed" timestamp. */
export const FRESHNESS_WATCHED_ROOTS = ['architecture', 'packages', 'apps'];

export const FRESHNESS_REPORT_FILES = [
  'docs/reports/architecture-health-current.json',
  'docs/reports/architecture-health-current.md',
];

function gitLogTimestamp(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Commit timestamp (epoch ms) for one git-log query.
 *   git failure  → undefined (the caller treats the whole comparison as
 *                  skipped — the repo is unusable, not the evidence stale)
 *   empty output → 0: the pathspec has NO history. A report file that exists
 *                  on disk but was never committed means there is no
 *                  committed evidence; that reads as older-than-everything
 *                  (stale), not as skip. A DELETED file still returns its
 *                  deletion commit — the newest one — which is why the
 *                  enforcing caller must also stat the report pair before
 *                  trusting any "fresh" verdict from history alone.
 *   bad date     → undefined (defensive; behaves like git failure)
 */
function commitTimestampMs(repoRoot, args) {
  const out = gitLogTimestamp(repoRoot, args);
  if (out === undefined) return undefined;
  if (out === '') return 0;
  const ms = Date.parse(out);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Newest commit timestamp (epoch ms) that touched any watched root.
 * `git log -1` with multiple pathspecs needs the `--` separator before the
 * paths on every git version this repo supports.
 */
function newestWatchedCommitMs(repoRoot) {
  return commitTimestampMs(repoRoot, [
    'log',
    '-1',
    '--format=%cI',
    '--',
    ...FRESHNESS_WATCHED_ROOTS,
  ]);
}

/**
 * Freshness anchor for the report pair: the OLDER of the two files' newest
 * commit timestamps. Each file is queried independently — a single git log
 * across both paths would return the newest commit touching either file, so
 * regenerating only the .json after a source change would read as fresh while
 * its stale .md companion ships as evidence. A file with NO git history maps
 * to 0 (older than everything → stale), not skip: present-on-disk-but-never-
 * committed is exactly the state that must force a commit. Git failure for
 * either query still returns undefined → caller skips. A DELETED file returns
 * its deletion commit (the newest one), so the enforcing caller must stat the
 * pair on disk before trusting any "fresh" verdict from history alone.
 */
function newestReportCommitMs(repoRoot) {
  let oldestMs;
  for (const file of FRESHNESS_REPORT_FILES) {
    const ms = commitTimestampMs(repoRoot, ['log', '-1', '--format=%cI', '--', file]);
    if (ms === undefined) return undefined;
    oldestMs = oldestMs === undefined ? ms : Math.min(oldestMs, ms);
  }
  return oldestMs;
}

/**
 * True when git reports a shallow clone (e.g. actions/checkout with
 * fetch-depth: 1, the default for CI PR runs). Path-filtered history is
 * unreliable there: the depth-1 boundary commit has no parent, so `git log
 * -- <path>` treats every path in the tree as newly added at HEAD, and the
 * report pair always appears to be "regenerated" by whatever commit is
 * checked out. Freshness cannot be decided — callers must skip, not guess.
 */
function isShallowRepository(repoRoot) {
  return gitLogTimestamp(repoRoot, ['rev-parse', '--is-shallow-repository']) === 'true';
}

/**
 * Compare committed report evidence against the newest watched-source commit.
 *
 * Returns a single discriminated shape:
 *   status:'fresh'  — the report pair is at least as new as the newest
 *                     watched-source commit (same-PR regeneration counts).
 *   status:'stale'  — a watched-source commit landed strictly after the last
 *                     report commit, OR a report file has no commit history
 *                     (empty git log maps to 0 = older than everything).
 *                     `detail` explains, `reason` is stable.
 *   status:'skipped'— git itself is unusable (spawn failure / bad date);
 *                     callers warn rather than fail.
 */
export function evaluateReportFreshness(repoRoot) {
  if (isShallowRepository(repoRoot)) {
    return {
      status: 'skipped',
      reason: 'shallow-repository',
      detail:
        'shallow clone detected (e.g. actions/checkout fetch-depth: 1): path-filtered ' +
        'history is unreliable at the shallow boundary, so evidence freshness cannot ' +
        'be decided here. Evaluate with full history (fetch-depth: 0) or on a local clone.',
    };
  }
  const watchedMs = newestWatchedCommitMs(repoRoot);
  const reportMs = newestReportCommitMs(repoRoot);
  if (watchedMs === undefined || reportMs === undefined) {
    return {
      status: 'skipped',
      reason: 'git-history-unavailable',
      detail:
        'git history unavailable for the freshness comparison (missing HEAD or no commits touching watched paths)',
    };
  }
  if (watchedMs <= reportMs) {
    return { status: 'fresh', watchedCommitMs: watchedMs, reportCommitMs: reportMs };
  }
  const watchedIso = new Date(watchedMs).toISOString();
  const reportIso = new Date(reportMs).toISOString();
  return {
    status: 'stale',
    reason: 'stale-committed-evidence',
    watchedCommitMs: watchedMs,
    reportCommitMs: reportMs,
    detail:
      `Newest commit touching watched roots (${FRESHNESS_WATCHED_ROOTS.join(', ')}): ` +
      `${watchedIso}; newest commit touching the report pair: ${reportIso}. ` +
      'A source-only change landed after the committed evidence was regenerated.',
  };
}

export async function loadArchitectureInputs(repoRoot) {
  const registry = await readJson(path.join(repoRoot, 'architecture/registry.json'));
  const exceptions = await readJson(path.join(repoRoot, 'architecture/exceptions.json'));
  const hotspots = await readJson(path.join(repoRoot, 'architecture/hotspots.json'));
  const testOnlyExportsPath = path.join(repoRoot, 'architecture/test-only-exports.json');
  // Absent on a first run (and in any checkout predating the baseline): treat
  // that as "nothing recorded yet" so `--write-hotspot-baseline` can create it,
  // rather than failing the whole report on a missing file.
  const testOnlyExports = (await pathExists(testOnlyExportsPath))
    ? await readJson(testOnlyExportsPath)
    : { schemaVersion: 1, files: {} };
  return { registry, exceptions, hotspots, testOnlyExports };
}
