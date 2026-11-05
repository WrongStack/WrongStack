import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_WALK_IGNORE_DIRS } from '@wrongstack/core/utils';
import {
  detectLanguageWorkspaces,
  languageProfileRegistry,
  planLanguageOperation,
} from '@wrongstack/tools/languages';

export interface ProjectFacts {
  build?: string | undefined;
  test?: string | undefined;
  lint?: string | undefined;
  run?: string | undefined;
  hints: string[];
  /** Top languages by source-file count, e.g. `['Python (142)', 'Shell (8)']`.
   *  Only populated by the source-tree scan fallback (no manifest matched). */
  languages?: string[] | undefined;
  /** Likely entry-point files discovered by the scan (relative paths). */
  entryPoints?: string[] | undefined;
  /** Non-ignored top-level directories discovered by the scan. */
  topDirs?: string[] | undefined;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull literal shell commands out of a GitHub Actions workflow's `run:` steps,
 * handling both inline (`run: pnpm test`) and block-scalar (`run: |` + indented
 * lines) forms. No YAML dependency — line-based, matching the Makefile parser's
 * pragmatism. Obvious non-build noise (cd/echo/export/comments) is dropped.
 */
function parseCiRunCommands(yaml: string): string[] {
  const commands: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = (m[1] ?? '').length;
    const inline = (m[2] ?? '').trim();
    if (inline && inline !== '|' && inline !== '>' && !/^[|>][+-]?$/.test(inline)) {
      commands.push(inline);
      continue;
    }
    // Block scalar: collect following lines indented deeper than the `run:` key.
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j] ?? '';
      if (body.trim() === '') continue;
      const bodyIndent = body.length - body.trimStart().length;
      if (bodyIndent <= indent) break;
      commands.push(body.trim());
      i = j;
    }
  }
  return commands.filter((c) => c !== '' && !/^(#|cd\s|echo\s|export\s|set\s|if\s)/.test(c));
}

/** Fill missing facts from CI command candidates, matching by keyword. CI is
 *  strong evidence: these commands actually run on every push. */
function applyCiCommands(facts: ProjectFacts, commands: string[]): void {
  const find = (re: RegExp) => commands.find((c) => re.test(c));
  facts.test ??= find(/\b(test|pytest|vitest|jest|go test|cargo test|mix test|rspec)\b/i);
  facts.lint ??= find(/\b(lint|eslint|biome|clippy|ruff|flake8|golangci-lint|fmt --check)\b/i);
  facts.build ??= find(
    /\b(build|compile|tsc|cargo build|go build|mvn .*package|gradle .*build)\b/i,
  );
}

async function detectPackageManager(root: string, declared?: string): Promise<string> {
  if (declared) {
    const name = declared.split('@')[0];
    if (name) return name;
  }
  if (await pathExists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(root, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(root, 'bun.lock'))) return 'bun';
  if (await pathExists(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function hasUsableScript(scripts: Record<string, string>, name: string): boolean {
  const script = scripts[name];
  if (typeof script !== 'string' || script.trim() === '') return false;
  if (name === 'test' && /no test specified/i.test(script)) return false;
  return true;
}

function parseMakeTargets(makefile: string): Set<string> {
  const targets = new Set<string>();
  for (const line of makefile.split(/\r?\n/)) {
    if (line.startsWith('\t') || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*:(?![=])/.exec(line);
    if (match?.[1]) targets.add(match[1]);
  }
  return targets;
}

/** Source-file extension → human language label. Used by the scan fallback to
 *  name a project's stack when no manifest (package.json, go.mod, …) matched. */
const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.hpp': 'C++',
  '.cs': 'C#',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.scala': 'Scala',
  '.clj': 'Clojure',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.erl': 'Erlang',
  '.hs': 'Haskell',
  '.ml': 'OCaml',
  '.dart': 'Dart',
  '.lua': 'Lua',
  '.jl': 'Julia',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.ps1': 'PowerShell',
  '.pl': 'Perl',
  '.zig': 'Zig',
  '.nim': 'Nim',
  '.sql': 'SQL',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
};

/** Directories the scan never descends into — the shared walker list plus fingerprint-only extras. */
const SCAN_IGNORE_DIRS = new Set([
  ...DEFAULT_WALK_IGNORE_DIRS,
  'out',
  'vendor',
  'env',
  '.wrongstack',
  '.idea',
  '.vscode',
  'obj',
  '.dart_tool',
  'Pods',
]);

/** Basenames (sans extension) that usually mark a program entry point. */
const ENTRY_BASENAMES = new Set(['main', 'index', 'app', 'cli', 'server', '__main__']);

interface ScanResult {
  languages: string[];
  entryPoints: string[];
  topDirs: string[];
}

/**
 * Last-resort project fingerprint for repos that match no manifest: walk the
 * source tree (bounded by depth + file count, skipping deps/build dirs) and
 * report the dominant languages, likely entry points, and top-level layout.
 * Never invents build/test commands — it only tells the agent what's there.
 */
async function scanSourceTree(root: string): Promise<ScanResult | undefined> {
  const counts = new Map<string, number>();
  const entryPoints: string[] = [];
  const topDirs: string[] = [];
  let fileCount = 0;
  const MAX_FILES = 5000;
  const MAX_DEPTH = 6;

  async function walk(dir: string, depth: number, rel: string): Promise<void> {
    if (fileCount >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (fileCount >= MAX_FILES) return;
      const name = e.name;
      if (e.isDirectory()) {
        if (SCAN_IGNORE_DIRS.has(name) || name.startsWith('.')) continue;
        if (depth === 0) topDirs.push(name);
        await walk(path.join(dir, name), depth + 1, rel ? `${rel}/${name}` : name);
      } else if (e.isFile()) {
        fileCount++;
        const ext = path.extname(name).toLowerCase();
        const lang = EXT_LANG[ext];
        if (!lang) continue;
        counts.set(lang, (counts.get(lang) ?? 0) + 1);
        const base = name.slice(0, name.length - ext.length).toLowerCase();
        if (entryPoints.length < 10 && ENTRY_BASENAMES.has(base)) {
          entryPoints.push(rel ? `${rel}/${name}` : name);
        }
      }
    }
  }

  await walk(root, 0, '');
  if (counts.size === 0) return undefined;
  const languages = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang, n]) => `${lang} (${n})`);
  return { languages, entryPoints, topDirs: topDirs.sort() };
}

export async function detectProjectFacts(root: string): Promise<ProjectFacts> {
  const facts: ProjectFacts = { hints: [] };
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      packageManager?: string | undefined;
    };
    const scripts = pkg.scripts ?? {};
    const pm = await detectPackageManager(root, pkg.packageManager);
    if (hasUsableScript(scripts, 'build')) facts.build = `${pm} run build`;
    if (hasUsableScript(scripts, 'test')) facts.test = `${pm} test`;
    if (hasUsableScript(scripts, 'lint')) facts.lint = `${pm} run lint`;
    const runScript = ['dev', 'start', 'serve', 'preview'].find((name) =>
      hasUsableScript(scripts, name),
    );
    if (runScript) facts.run = `${pm} run ${runScript}`;
    facts.hints.push(Object.keys(scripts).length > 0 ? 'package.json scripts' : 'package.json');
  } catch {
    /* not node */
  }
  try {
    const makefile = await fs.readFile(path.join(root, 'Makefile'), 'utf8');
    const targets = parseMakeTargets(makefile);
    facts.build ??= targets.has('build') ? 'make build' : 'make';
    if (targets.has('test')) facts.test ??= 'make test';
    if (targets.has('lint')) facts.lint ??= 'make lint';
    const runTarget = ['run', 'dev', 'start', 'serve'].find((name) => targets.has(name));
    if (runTarget) facts.run ??= `make ${runTarget}`;
    facts.hints.push('Makefile');
  } catch {
    /* no make */
  }
  // Language registry — one pass replaces 15 ecosystem-specific try/catch blocks.
  // Fills gaps (??=) so package.json scripts and Makefile targets take priority.
  // Only fills commands when evidence is authoritative (manifest/config/lockfile),
  // NOT when the profile only matched via source-file extension heuristics — that
  // path leaves commands undefined so the source scan fallback can still run.
  const detection = await detectLanguageWorkspaces({ projectRoot: root });
  for (const workspace of detection.workspaces) {
    const profile = languageProfileRegistry.get(workspace.language);
    if (!profile) continue;
    const authoritative = workspace.evidence.some((e) => e.kind !== 'source');
    if (authoritative) {
      for (const op of ['build', 'test', 'lint', 'run'] as const) {
        if (facts[op] !== undefined) continue;
        const plan = await planLanguageOperation({
          projectRoot: root,
          operation: op,
          language: workspace.language,
        });
        if (plan.status === 'planned') {
          const cmd = [plan.plan.command, ...plan.plan.args].join(' ');
          facts[op] = cmd;
        }
      }
    }
    facts.hints.push(profile.id);
  }
  // CI workflows are the strongest evidence for projects with thin/odd manifests:
  // these commands actually run on every push. Fills only gaps left above.
  if (!facts.build || !facts.test || !facts.lint) {
    try {
      const wfDir = path.join(root, '.github', 'workflows');
      const wfNames = (await fs.readdir(wfDir)).filter((n) => /\.ya?ml$/i.test(n));
      const commands: string[] = [];
      for (const n of wfNames) {
        commands.push(...parseCiRunCommands(await fs.readFile(path.join(wfDir, n), 'utf8')));
      }
      if (commands.length > 0) {
        const before = { build: facts.build, test: facts.test, lint: facts.lint };
        applyCiCommands(facts, commands);
        if (
          facts.build !== before.build ||
          facts.test !== before.test ||
          facts.lint !== before.lint
        ) {
          facts.hints.push('.github/workflows');
        }
      }
    } catch {
      /* no CI workflows */
    }
  }
  // No manifest produced runnable commands — fall back to scanning the source
  // tree so AGENTS.md still names the language and layout (commands stay TODO).
  if (!facts.build && !facts.test && !facts.run && !facts.lint) {
    const scan = await scanSourceTree(root);
    if (scan) {
      facts.languages = scan.languages;
      if (scan.entryPoints.length > 0) facts.entryPoints = scan.entryPoints;
      if (scan.topDirs.length > 0) facts.topDirs = scan.topDirs;
      facts.hints.push(`source scan: ${scan.languages.join(', ')}`);
    }
  }
  return facts;
}

export function renderAgentsTemplate(f: ProjectFacts): string {
  const cmd = (s?: string) => (s ? `\`${s}\`` : '_TODO_');
  const hints = f.hints.length > 0 ? `\n\n> Auto-detected: ${f.hints.join(', ')}` : '';
  const runtime = f.languages?.length
    ? `_CLI, server, browser, worker, library, package?_ — detected: ${f.languages.join(', ')}`
    : '_CLI, server, browser, worker, library, package?_';

  // When the source scan found real entry points / directories, render them as
  // table rows; otherwise keep the generic placeholders.
  const keyFileRows: string[] = [];
  for (const ep of f.entryPoints ?? [])
    keyFileRows.push(`| \`${ep}\` | _Likely entry point (detected)_ |`);
  for (const dir of f.topDirs ?? [])
    keyFileRows.push(`| \`${dir}/\` | _Top-level directory (detected)_ |`);
  const keyFiles =
    keyFileRows.length > 0
      ? keyFileRows.join('\n')
      : `| _src/_ | _Main source entry point(s)_ |
| _tests/_ | _Test root or convention_ |
| _docs/_ | _Architecture, runbooks, design notes_ |
| _scripts/_ | _Automation scripts (CI, release, install, etc.)_ |`;

  return `# AGENTS.md

> **DO NOT DELETE THIS FILE.** It is loaded into WrongStack's system prompt as
> persistent project context. The \`/init\` command **regenerates** this file from
> detected project facts and backs up any previous version to \`AGENTS.md.bak\`.
> After \`/init\`, review the backup and merge any hand-written project context
> back into this file — then add your conventions, architecture notes, and
> domain knowledge below.

## Project brief

- **Purpose:** _What does this project do and why does it exist?_
- **Primary users:** _Who uses it: developers, operators, customers, internal systems?_
- **Runtime / deployment:** ${runtime}${hints}

## How to work safely

- _Project-specific rules the agent should always follow._
- _Files, generated artifacts, migrations, or config the agent should not edit without asking._
- _Preferred style or architecture choices not obvious from the code._
- _Known fragile areas or historical bugs that deserve extra caution._

## Commands

| Command | Script |
|---------|--------|
| Build | ${cmd(f.build)} |
| Test | ${cmd(f.test)} |
| Lint | ${cmd(f.lint)} |
| Run locally | ${cmd(f.run)} |

## Key files and entry points

| File / directory | Role |
|---|---|
${keyFiles}

## Architecture notes

_Summarize the important modules, data flow, boundaries, and ownership rules.
Mention anything a newcomer might misread or that looks unusual but is intentional._

### Dependency layers

_Describe the key dependency direction or layered structure, e.g.: "core has no
runtime deps; cli assembles everything above it."_

### Extension points

_Plugin, MCP, extension hooks, custom tools — what's wired up and how._

## Domain knowledge

_Business rules, acronyms, invariants, external services, and notes where the
code looks unusual but is intentional. E.g.: "IDs are ULIDs, not UUIDs", "the
\`draft\` flag means uncommitted billing metadata", "MCP servers are restarted
on disconnect with exponential backoff, up to 3 attempts"._

## Verification checklist

- _What should be run after code changes?_
- _What manual smoke test proves the common path still works?_
- _What failure modes deserve extra attention?_
- _Any known flaky tests or environment-dependent behavior?_

## Useful pointers

- _Docs, dashboards, runbooks, issue trackers, design notes, owner contacts._
- _Related projects or repositories._`;
}
