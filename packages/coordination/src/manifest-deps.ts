/**
 * manifest-deps — Declared-dependency extraction and diffing for manifest files.
 *
 * The dep-watcher pipeline knows *that* a manifest changed, but not *what*
 * changed in it. That gap is why the tech-stack audit could only ever react to
 * a file-level event: the spawned agent was told to re-read the manifest and
 * figure it out, which means every edit — a version bump, a lockfile touch, a
 * formatter run — looked identical to "a brand new dependency was added".
 *
 * This module closes that gap. It parses the *declared* dependency blocks of
 * the manifest formats that carry them, and diffs two snapshots of the same
 * file to report exactly which packages were added, version-changed, or
 * removed. The tech-stack audit can then be scoped to the packages that are
 * actually new.
 *
 * Two deliberate limits:
 *
 * - **Declared only.** Lockfiles and transitive graphs are not parsed here.
 *   The caller already has `packages/techstack` for full graph work; this
 *   module answers the narrow question "what did the human/agent just declare".
 * - **Never throws.** Manifests are frequently half-written while an editor
 *   saves, and unparseable content is normal on a watch-triggered read. Every
 *   parser degrades to "nothing declared" rather than propagating, so a
 *   malformed save can never wedge the watcher loop.
 *
 * @module manifest-deps
 */

/** A dependency entry as literally declared in the manifest. */
export interface DeclaredDependency {
  /** Package name, exactly as written in the manifest. */
  readonly name: string;
  /** The declared version range, verbatim (`^1.2.3`, `~2.0`, `>=1`, ...). */
  readonly range: string;
  /** Which manifest block declared it: 'dependencies' | 'devDependencies' | ... */
  readonly section: string;
}

/**
 * The dependency set of one manifest, keyed by package name.
 *
 * A Map (rather than a Record) because scoped npm packages legitimately carry
 * `/` in their names, which is only awkward as an object key.
 */
export type DeclaredDependencyMap = ReadonlyMap<string, DeclaredDependency>;

/** What changed between two readings of the same manifest. */
export interface DependencyDelta {
  /** Packages present now that were not present before. */
  readonly added: readonly DeclaredDependency[];
  /** Packages whose declared range changed. */
  readonly changed: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
  }[];
  /** Packages present before that are gone now. */
  readonly removed: readonly DeclaredDependency[];
}

/**
 * Parse the declared dependencies out of a manifest's contents.
 *
 * Returns an empty map for formats this module does not parse (Maven POM,
 * Gradle, CMake, conan) rather than guessing. Callers treat that as "no
 * delta available" and fall back to the whole-manifest audit.
 *
 * @param content Raw file contents.
 * @param manifestPath Manifest filename or path — selects the parser.
 */
export function parseDeclaredDependencies(
  content: string,
  manifestPath: string,
): DeclaredDependencyMap {
  const name = manifestPath.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  const parsed = parseByManifestName(name, content);
  const out = new Map<string, DeclaredDependency>();
  for (const entry of parsed) {
    // First declaration wins: `dependencies` is listed before `devDependencies`
    // so a package in both is attributed to its runtime role.
    if (!out.has(entry.name)) out.set(entry.name, entry);
  }
  return out;
}

/**
 * Diff two readings of the same manifest.
 *
 * `before` is the prior baseline; `after` is the current state. An absent
 * baseline (`undefined`) yields an empty delta — we cannot claim a package is
 * "new" when we have never seen the file before, and guessing would fire a
 * tech-stack audit listing every dependency in the repo.
 */
export function diffDeclaredDependencies(
  before: DeclaredDependencyMap | undefined,
  after: DeclaredDependencyMap,
): DependencyDelta {
  if (!before) return { added: [], changed: [], removed: [] };

  const added: DeclaredDependency[] = [];
  const changed: { name: string; from: string; to: string }[] = [];
  const removed: DeclaredDependency[] = [];

  for (const [name, entry] of after) {
    const prior = before.get(name);
    if (!prior) added.push(entry);
    else if (prior.range !== entry.range)
      changed.push({ name, from: prior.range, to: entry.range });
  }
  for (const [name, entry] of before) {
    if (!after.has(name)) removed.push(entry);
  }

  return { added, changed, removed };
}

/** True when the delta contains anything worth an audit. */
export function hasDependencyChanges(delta: DependencyDelta): boolean {
  return delta.added.length > 0 || delta.changed.length > 0;
}

// ── Per-format parsers ───────────────────────────────────────────────────

function parseByManifestName(name: string, content: string): DeclaredDependency[] {
  switch (name) {
    case 'package.json':
      return parsePackageJson(content);
    case 'cargo.toml':
      return parseCargoToml(content);
    case 'go.mod':
      return parseGoMod(content);
    case 'requirements.txt':
      return parseRequirementsTxt(content);
    case 'pyproject.toml':
      return parsePyprojectToml(content);
    case 'composer.json':
      return parseComposerJson(content);
    case 'gemfile':
      return parseGemfile(content);
    case 'pubspec.yaml':
      return parsePubspecYaml(content);
    default:
      return [];
  }
}

/** npm/pnpm/yarn — four declaration blocks in one JSON document. */
function parsePackageJson(content: string): DeclaredDependency[] {
  const doc = safeJson(content);
  if (!doc || typeof doc !== 'object') return [];
  const out: DeclaredDependency[] = [];
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const block = (doc as Record<string, unknown>)[section];
    if (!block || typeof block !== 'object') continue;
    for (const [depName, range] of Object.entries(block as Record<string, unknown>)) {
      if (typeof range !== 'string') continue;
      out.push({ name: depName, range, section });
    }
  }
  return out;
}

/**
 * Cargo — `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, and
 * the workspace-wide `[workspace.dependencies]`.
 *
 * The workspace table is not a nice-to-have: in a virtual workspace root — the
 * layout `cargo new` produces for every multi-crate project — it is the ONLY
 * place a declared range exists, because member crates write
 * `foo.workspace = true`, which carries no version. Leaving it out made a
 * workspace `Cargo.toml` report no dependencies at all, so
 * `diffDeclaredDependencies` produced an empty delta, `hasDependencyChanges`
 * stayed false, and the dep-watcher audit gate never opened for a genuinely
 * new Rust dependency. `[workspace]` itself stays out of the list: its keys
 * (`resolver`, `members`) are not packages.
 */
function parseCargoToml(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  const sections = [
    'dependencies',
    'dev-dependencies',
    'build-dependencies',
    'workspace.dependencies',
  ];
  let current: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      const name = header[1];
      current = sections.includes(name) ? name : undefined;
      continue;
    }
    if (!current) continue;

    // `serde = "1.0"` or `serde = { version = "1.0", features = [...] }`.
    const inline = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(line);
    if (inline?.[1] && inline[2]) {
      out.push({ name: inline[1], range: inline[2], section: current });
      continue;
    }
    const table = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}/.exec(line);
    if (table?.[1] && table[2] !== undefined) {
      const version = /\bversion\s*=\s*"([^"]+)"/.exec(table[2])?.[1];
      if (version) out.push({ name: table[1], range: version, section: current });
    }
  }
  return out;
}

/** Go — `require` directives, both single-line and parenthesised blocks. */
function parseGoMod(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  let inBlock = false;

  for (const rawLine of content.split(/\r?\n/)) {
    // go.mod comments are `//` (not `#`): a commented-out line inside a
    // `require ( … )` block used to come back as a dependency named "//".
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const entry = /^([^\s]+)\s+(\S+)/.exec(line);
      if (entry?.[1] && entry[2]) {
        out.push({ name: entry[1], range: entry[2], section: 'dependencies' });
      }
      continue;
    }

    const single = /^require\s+([^\s]+)\s+(\S+)/.exec(line);
    if (single?.[1] && single[2]) {
      out.push({ name: single[1], range: single[2], section: 'dependencies' });
      continue;
    }
    if (/^require\s*\($/.test(line)) inBlock = true;
  }
  return out;
}

/** pip — `name==1.2.3`, `name>=1.0`, `name~=2.0`, bare `name`. */
function parseRequirementsTxt(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    // pip: `#` starts a comment only at line start or after whitespace — the
    // `#egg=` fragment of a VCS/URL requirement is not a comment.
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    // `git+https://…#egg=pkg` / `https://…/pkg.whl`: not `name<op>version`.
    // Reading the scheme as a package name reported a dependency "git".
    if (/^(?:(?:git|hg|svn|bzr)\+|[a-z][a-z0-9+.-]*:\/\/)/i.test(line)) {
      const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(line)?.[1];
      if (egg) out.push({ name: egg, range: line.replace(/#.*$/, ''), section: 'dependencies' });
      continue;
    }
    // pip also accepts a *path* requirement: a local directory, or a wheel /
    // sdist file (PEP 427 / PEP 527). Those are filenames, not
    // `name<op>version`, and the generic pattern below read the leading path
    // segment — `.` from `./local-package`, `wheels` from
    // `wheels/foo-1.0-py3-none-any.whl` — or the whole filename as the package
    // name. That invented a package literally named "." and encoded the
    // version inside the name, so a wheel version bump arrived as
    // added+removed identity churn instead of one `changed` entry. The archive
    // carries a recoverable name+version; a directory path declares neither.
    if (isPathRequirement(line)) {
      const archive = archiveRequirement(line);
      if (archive) out.push({ ...archive, section: 'dependencies' });
      continue;
    }
    const entry = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
    const name = entry?.[1];
    if (!name) continue;
    out.push({ name, range: entry?.[3]?.trim() ?? '', section: 'dependencies' });
  }
  return out;
}

const ARCHIVE_REQUIREMENT = /\.(?:whl|zip|tgz|tar\.(?:gz|bz2|xz))$/i;

/** A requirement that names a filesystem path instead of a distribution. */
function isPathRequirement(line: string): boolean {
  // `foo @ https://…/foo-1.0-py3-none-any.whl` is a PEP 508 direct reference:
  // it DOES name the package, so it keeps going to the generic parser.
  if (/^[A-Za-z0-9._-]+\s*@\s*\S/.test(line)) return false;
  // Only the first token: a hash-pinned line such as
  // `foo==1.26.4 --hash=sha256:abcd/ef` carries a `/` in an OPTION, and the
  // requirement itself is an ordinary PEP 508 name.
  const first = line.split(/\s+/)[0] ?? '';
  return (
    /^[.~/]/.test(first) ||
    /^[a-zA-Z]:[\\/]/.test(first) ||
    first.includes('/') ||
    first.includes('\\') ||
    ARCHIVE_REQUIREMENT.test(first)
  );
}

/** `{name}-{version}…` from a wheel or sdist filename; undefined for a directory. */
function archiveRequirement(
  line: string,
): { readonly name: string; readonly range: string } | undefined {
  const base = (line.split(/\s+/)[0] ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(ARCHIVE_REQUIREMENT, '');
  if (stem === base) return undefined;
  // The name ends at the first `-` followed by a digit: wheel distribution
  // names cannot contain `-` (PEP 427 normalises them to `_`, dots survive),
  // and it keeps `zope.interface-5.0.tar.gz` whole.
  const parts = /^(.+?)-(\d[^-]*)/.exec(stem);
  if (!parts?.[1] || !parts[2]) return undefined;
  return { name: parts[1], range: parts[2] };
}

/** Python project metadata — PEP 621 `[project] dependencies = [...]`. */
function parsePyprojectToml(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  let inProject = false;
  let inArray = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (/^\[project\]$/.test(line)) {
      inProject = true;
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      inProject = false;
      inArray = false;
      continue;
    }
    if (!inProject) continue;

    if (/^dependencies\s*=\s*\[\s*$/.test(line)) {
      inArray = true;
      continue;
    }
    if (inArray) {
      if (line === ']') {
        inArray = false;
        continue;
      }
      const quoted = /^"([^"]+)"\s*,?$/.exec(line)?.[1];
      if (quoted) out.push(...pep508Entry(quoted));
      continue;
    }
    if (/^dependencies\s*=\s*\[(.*)\]\s*$/.test(line)) {
      // Take the quoted strings; never split on `,`. A PEP 508 range may
      // legitimately contain one (`numpy>=1.21,<2.0` is the common
      // lower-and-upper bound form), and splitting put a quote on each side of
      // that comma, so neither fragment matched the quoted pattern and the
      // whole dependency disappeared — while the identical multi-line array
      // parsed it. A dropped package also means `diffDeclaredDependencies`
      // reports nothing and the dep-watcher audit gate never opens for it.
      const inline = /\[(.*)\]/.exec(line)?.[1] ?? '';
      for (const match of inline.matchAll(/"([^"]+)"/g)) {
        const quoted = match[1];
        if (quoted) out.push(...pep508Entry(quoted));
      }
    }
  }
  return out;
}

/** Split a PEP 508 requirement string into name + version constraint. */
function pep508Entry(requirement: string): DeclaredDependency[] {
  const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(requirement.trim());
  const name = match?.[1];
  if (!name) return [];
  return [{ name, range: match?.[2]?.trim() ?? '', section: 'project.dependencies' }];
}

/** Composer — `require` and `require-dev`, with the `php`/`ext-*` pseudo-entries skipped. */
function parseComposerJson(content: string): DeclaredDependency[] {
  const doc = safeJson(content);
  if (!doc || typeof doc !== 'object') return [];
  const out: DeclaredDependency[] = [];
  for (const section of ['require', 'require-dev']) {
    const block = (doc as Record<string, unknown>)[section];
    if (!block || typeof block !== 'object') continue;
    for (const [depName, range] of Object.entries(block as Record<string, unknown>)) {
      if (typeof range !== 'string') continue;
      // `php: ">=8.1"` and `ext-json: "*"` are platform constraints, not packages.
      if (depName === 'php' || depName.startsWith('ext-') || depName === 'composer-plugin-api')
        continue;
      out.push({ name: depName, range, section });
    }
  }
  return out;
}

/** Bundler — `gem 'name', '~> 1.2'` and the bare `gem "name"` form. */
function parseGemfile(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  const re = /^\s*gem\s+(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]+)\3)?/gm;
  for (const match of content.matchAll(re)) {
    const name = match[2];
    if (!name) continue;
    out.push({ name, range: match[4] ?? '', section: 'dependencies' });
  }
  return out;
}

/** Dart/Flutter — top-level `dependencies:` / `dev_dependencies:` maps. */
function parsePubspecYaml(content: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = [];
  let current: string | undefined;
  // The whitespace of the section's OWN keys, taken from the first line under
  // the header. YAML lets the author choose it — two spaces is the convention,
  // not a requirement — and a range-less dependency (`pkg:` followed by a
  // nested `git:`/`sdk:`/`path:` map) is written as a bare key, so the entry
  // test has to be "same depth as the section's keys", not "exactly two spaces
  // and a non-empty value". Hard-coding both made a 4-space or tab-indented
  // pubspec report NO dependencies at all, and hid every map-form package:
  // `diffDeclaredDependencies` then produced an empty delta and the
  // dep-watcher audit gate never opened for a brand-new dependency.
  let entryWs = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '');
    if (!line.trim()) continue;

    const topLevel = /^([A-Za-z_][A-Za-z0-9_]*):\s*$/.exec(line);
    if (topLevel?.[1]) {
      current =
        topLevel[1] === 'dependencies' || topLevel[1] === 'dev_dependencies'
          ? topLevel[1]
          : undefined;
      entryWs = '';
      continue;
    }
    if (!current) continue;

    const ws = /^[\t ]*/.exec(line)?.[0] ?? '';
    // A zero-indent line that is not a bare `key:` header ends the block.
    if (ws === '') {
      current = undefined;
      continue;
    }
    if (!entryWs) entryWs = ws;
    // Deeper than the section's keys: options of the dependency above it.
    if (ws !== entryWs) continue;

    const entry = /^([A-Za-z0-9_]+):(.*)$/.exec(line.slice(ws.length));
    const name = entry?.[1];
    if (!name) continue;
    out.push({ name, range: stripYamlQuotes(entry?.[2] ?? ''), section: current });
  }
  return out;
}

// ── Small helpers ────────────────────────────────────────────────────────

/** Strip a trailing `# comment` that is not inside quotes. */
function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '"' || ch === "'") {
      quote = quote === ch ? undefined : (quote ?? ch);
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function stripYamlQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/** `JSON.parse` that yields undefined instead of throwing on a half-written file. */
function safeJson(content: string): unknown {
  try {
    return JSON.parse(content.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return undefined;
  }
}
