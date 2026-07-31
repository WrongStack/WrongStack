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
    return !/([+\-])\1\s*$/.test(emitted);
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
  for (const file of allSourceFiles) {
    const sourceText = await readFile(file, 'utf8');
    const relativeFile = repoRelative(repoRoot, file);
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

export async function loadArchitectureInputs(repoRoot) {
  const registry = await readJson(path.join(repoRoot, 'architecture/registry.json'));
  const exceptions = await readJson(path.join(repoRoot, 'architecture/exceptions.json'));
  const hotspots = await readJson(path.join(repoRoot, 'architecture/hotspots.json'));
  return { registry, exceptions, hotspots };
}
