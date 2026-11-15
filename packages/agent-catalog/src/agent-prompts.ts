import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { moduleDirFor, resolveWstackPaths } from '@wrongstack/persistence';
import { buildProjectContextualizedPrompt } from './project-agent-identity.js';
import { assertProjectAgentRole } from './project-agent-paths.js';

/**
 * Cache of resolved prompt text, keyed by
 * `<envDir>\0<policyOn>\0<projectRoot>\0<id>`. Base
 * prompt files do not change during a process lifetime, so their resolution
 * is memoized. The key includes the override env var so tests that set
 * `WRONGSTACK_AGENT_INSTRUCTIONS_DIR` still observe fresh resolution.
 *
 * The project overlay files (`identity.md` / `learned.md` / `consolidated.md`)
 * DO change mid-process — `captureLearnedFromAgentOutput` rewrites
 * `learned.md` on every capture — so their (mtimeMs, size) fingerprint decides
 * whether an entry is still valid. Without that check, wisdom captured in a
 * running process only reached subagent spawns after a restart, silently
 * breaking the capture→inject feedback loop.
 *
 * The fingerprint lives in the VALUE, not the key. It used to be part of the
 * key, which meant every capture minted a new entry and left the previous
 * generation behind forever — each one a fully rendered prompt (base + tech
 * policy + identity + learned overlay), and nothing here ever deleted. A
 * long-lived host that captures often grew this map without bound. Keying on
 * role alone and overwriting on a fingerprint miss keeps the entry count at
 * one per role while preserving the exact same invalidation semantics.
 */
const promptCache = new Map<string, { fingerprint: string; prompt: string }>();

/**
 * Number of live prompt-cache entries.
 *
 * Exposed so the "one entry per role, regardless of how many times the overlay
 * is rewritten" bound above is testable. The old fingerprint-in-key scheme grew
 * this without limit and nothing could observe it.
 */
export function agentPromptCacheSize(): number {
  return promptCache.size;
}

/**
 * Cache of the ordered candidate directory list, keyed by `<envDir>\0<cwd-home>`.
 * The list is otherwise identical for every `agentPrompt()` call, so resolving
 * (and sorting via `statSync`) it once per env avoids ~7 redundant `statSync`
 * probes per call. `fleet.ts` + the phase catalogs alone call `agentPrompt()`
 * ~60 times at import time.
 */
const candidateCache = new Map<string, string[]>();

/**
 * Mandatory modern technology policy that every built-in roster agent
 * inherits. Memoized per env-dir and prepended to each role's base prompt
 * so the rule travels with the persona.
 */
const TECH_VERSION_POLICY_KEY = '\u0000__tech_version_policy__';

/**
 * Cache of resolved policy body keyed by env-dir. The policy file lives on
 * disk and can be overridden via `WRONGSTACK_AGENT_INSTRUCTIONS_DIR`, so the
 * memo must invalidate when the env var changes — a single module-level
 * `let` would serve the first-resolved body forever.
 */
const techVersionPolicyCache = new Map<string, string>();

const INLINE_TECH_VERSION_POLICY = `# Mandatory modern technology policy

You are bound to the current stable version of every library, framework and
package you use. The latest stable is preferred; the latest *published* is
*required*.

## Non-negotiable rules

1. **Verify the version, never trust a number from training data.** Before
   recommending, adding, or upgrading a package or framework version, fetch the
   live registry (npm, PyPI, crates, Go proxy, GitHub releases). Treat the value
   you read as the only acceptable reference; do not interpolate from memory.
   When a task does not add, upgrade, or recommend a dependency, do not spend
   turns querying package registries.

2. **Latest stable by default.** Pick the highest stable release that
   satisfies the project runtime/compiler (\`Cargo.toml\`, \`pyproject.toml\`,
   \`go.mod\`, \`package.json\`, \`pom.xml\`, \`build.gradle\`, etc.), the pinned
   dependency/peer range, and the role's required APIs. Pin using the
   ecosystem's standard constraint (\`^<major>.<minor>.0\`, \`~=<major>.<minor>\`, etc.)
   and report the exact version.

3. **Reject alpha / beta / RC / nightly** unless the user explicitly
   requests a pre-release. State the rejection reason in the output.

4. **Reject EOL, deprecated and unmaintained packages** — a package with
   no release in >2 years **and** open critical issues is *dead*. Reject
   it on the same day you find it and propose a maintained replacement.

5. **Reject prehistoric technology.** The well-known blocklist:
   - \`axios\` / \`node-fetch\` / \`got\` / \`request\` → native \`fetch\` (Node 18+).
   - \`moment\` → \`date-fns\`, \`luxon\` or \`Temporal\`.
   - jQuery on new projects → vanilla DOM or React.
   - Gulp / Grunt → \`tsup\`, \`esbuild\` or \`vite\`.
   - CoffeeScript / Flow → TypeScript.
   - \`Bluebird\` → native Promises.
   - \`crypto-js\` → \`node:crypto\` or Web Crypto.
   - Bower → npm, pnpm, or the repository's active package manager.
   - \`underscore\` → \`lodash\` or native ES2020+.
   - Python \`optparse\` / \`imp\` / \`distutils\` → \`argparse\`, \`importlib\`, modern \`packaging\`.
   - Rust \`failure\` / \`error-chain\` / \`lazy_static\` → \`thiserror\` / \`anyhow\`, \`std::sync::LazyLock\`.
   - Go \`io/ioutil\` / \`golang.org/x/net/context\` → \`io\` / \`os\` and standard \`context\`.
   - Java \`java.util.Date\` / \`SimpleDateFormat\` / \`Vector\` → \`java.time\` and modern collections.
   Use the intervention phrase: **"This isn't code, this is X-year-old
   technology."** Follow with the modern replacement and a one-step
   migration path.

6. **Prefer built-in over third-party.** Before adding a dependency, check
   the language or runtime native API. Examples:
   - Node ≥22.19 → \`node:test\`, \`node:sqlite\`, \`node:fs/promises\`,
     \`fetch\`, \`WebSocket\`, \`node:crypto\`, \`node:stream/web\`, AbortSignal.
   - Browsers → \`fetch\`, \`AbortController\`, \`structuredClone\`,
     \`URLPattern\`, Web Streams.
   - TypeScript ≥5.6 → \`using\` declarations, \`await using\`, the new
     iterator helpers, \`NoInfer\`, the \`esnext.disposable\` types.
   - Python ≥3.11 → \`tomllib\`, \`asyncio.TaskGroup\`, \`pathlib\`, \`dataclasses\`, \`zoneinfo\`, \`typing.Self\`.
   - Rust ≥1.80 → \`std::sync::LazyLock\`, \`OnceLock\`, \`let...else\`, native async traits.
   - Go ≥1.21 → \`slices\`, \`maps\`, \`cmp\`, \`log/slog\`, \`min\`/\`max\`/\`clear\`.
   - Java ≥21 → virtual threads, record patterns, sequenced collections, \`java.net.http.HttpClient\`.

7. **Never silently upgrade a pinned version.** If the project pins an
   old version, call it out and report: the new compatible version,
   the breaking changes between them, and a migration recipe. Do not
   upgrade without confirmation.

8. **Always cite the source and the verification time.** Output must
   include the registry URL and the date you verified, so the operator
   can audit the choice.

9. **Never use deprecated APIs even if a tutorial says so.** When a
   vendor marks an API deprecated, switch to the documented replacement
   and record the migration in the role's working notes.

10. **A package must exist.** Reject and call out any hallucinated package
    or framework. The intervention phrase for missing packages is
    **"This package does not exist on the registry."** and the role must
    propose a real, maintained alternative.`;

function loadTechVersionPolicy(): string {
  const envDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] ?? '';
  const cached = techVersionPolicyCache.get(envDir);
  if (cached !== undefined) return cached;
  const fromDisk = policyBody(envDir);
  const body = fromDisk || INLINE_TECH_VERSION_POLICY;
  techVersionPolicyCache.set(envDir, body);
  return body;
}

/**
 * The bundled role prompts ship in this package's `instructions/agents`. Source
 * (`src/`), build (`dist/`) and the standalone binary (whose `moduleDirFor` is
 * the embedded package's `dist/`) all sit one level below the package root.
 */
function bundledAgentsDir(): string {
  return path.resolve(
    moduleDirFor(import.meta.url, '@wrongstack/agent-catalog'),
    '../instructions/agents',
  );
}

function policyCandidateDirs(envDir: string): string[] {
  const profileInstructions = resolveWstackPaths({ projectRoot: process.cwd() }).globalInstructions;
  return [
    ...(envDir ? [path.resolve(envDir)] : []),
    bundledAgentsDir(),
    path.join(profileInstructions, 'agents'),
    profileInstructions,
  ].filter((dir, index, all) => all.indexOf(dir) === index);
}

function policyBody(envDir: string): string {
  const roots = [path.resolve(bundledAgentsDir(), '_policy/tech-version.md')];
  // When the caller overrides the instructions dir, check there first so
  // `_policy/tech-version.md` placed in the override takes precedence.
  if (envDir) {
    roots.unshift(path.resolve(envDir, '_policy/tech-version.md'));
  }
  for (const file of roots) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      // try next candidate
    }
  }
  for (const dir of policyCandidateDirs(envDir)) {
    try {
      return readFileSync(path.join(dir, '_policy', 'tech-version.md'), 'utf8').trim();
    } catch {
      // try next candidate
    }
  }
  return '';
}

/**
 * Files `buildProjectContextualizedPrompt` inlines into the cached prompt.
 * `learned.md` is rewritten on every capture; `consolidated.md` on every
 * consolidation pass; `identity.md` on manual/WebUI edits.
 */
const OVERLAY_FILES = ['identity.md', 'learned.md', 'consolidated.md'] as const;

/**
 * Fingerprint of the project overlay files for a role, as
 * `name:mtimeMs:size;` per present file. Part of the `promptCache` key so a
 * mid-process capture (which rewrites `learned.md`) invalidates the memoized
 * prompt and the next spawn in the same process sees the new entry — the
 * capture→inject feedback loop the learning layer documents.
 *
 * Returns '' when the overlay cannot apply: the env override dir disables it
 * entirely (see `buildProjectContextualizedPrompt`), and non-role ids (e.g.
 * the policy sentinel) never get one. mtime+size is the deliberate tradeoff:
 * hashing content would require reading the files, defeating the cache.
 */
function agentOverlayFingerprint(id: string, projectRoot: string): string {
  if (process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR']) return '';
  let roleDir: string;
  try {
    roleDir = path.join(projectRoot, '.wrongstack', 'agents', assertProjectAgentRole(id));
  } catch {
    return '';
  }
  let fp = '';
  for (const name of OVERLAY_FILES) {
    try {
      const st = statSync(path.join(roleDir, name));
      fp += `${name}:${st.mtimeMs}:${st.size};`;
    } catch {
      // File absent — contributes nothing to the overlay.
    }
  }
  return fp;
}

/**
 * Install `prompt` on a catalog config as a lazy accessor that resolves through
 * {@link agentPrompt} on first read.
 *
 * The phase catalogs used to call `agentPrompt()` eagerly in their array
 * literals — 76 roles × (one base-prompt `readFileSync` + three overlay
 * `statSync` + the identity/learned reads inside
 * `buildProjectContextualizedPrompt`) — and `AGENT_CATALOG` is re-exported from
 * the core barrel, so *importing core at all* paid that bill. It was ~60 ms of
 * every CLI and TUI cold start, for ~438 KB of prompt text that a session which
 * never delegates never reads.
 *
 * Deliberately NOT memoized here: `agentPrompt` owns the cache, and its
 * overlay-fingerprint check is what lets a mid-process `learned.md` capture
 * reach the next spawn. Caching the string in this closure would pin the first
 * generation forever and silently break the capture→inject loop.
 *
 * The accessor is enumerable (so spreads, `Object.keys` and JSON round-trips
 * still see `prompt`) and carries a setter that re-defines the key as a plain
 * data property, so existing `cfg.prompt = …` overrides — `director-tools.ts`
 * applies `system_prompt` that way — keep working instead of throwing in strict
 * mode. Note that any SPREAD of the config materializes the prompt, which is
 * why the two catalog funnels that used to spread — `assignSkillsToAgents` and
 * `withDispatchMetadata` — copy by descriptor via {@link cloneWithLazyPrompt}.
 */
export function defineLazyAgentPrompt<T extends object>(config: T, role: string): T {
  Object.defineProperty(config, 'prompt', {
    configurable: true,
    enumerable: true,
    get: (): string => agentPrompt(role),
    // Writes land on the RECEIVER, not on the config captured above.
    // `cloneWithLazyPrompt` copies this accessor by descriptor, so the closure
    // variable is the ORIGINAL config — redefining it there would move another
    // object's prompt and leave the clone still reading through the getter, so
    // the override silently vanished.
    set(this: T, value: string) {
      Object.defineProperty(this, 'prompt', {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
  return config;
}

/**
 * Install the lazy `prompt` accessor on every definition in a phase catalog,
 * keyed on each one's own role.
 *
 * The phase arrays are exported in their own right — `index.ts` re-exports them
 * and tests read `DISCOVERY_AGENTS[0].config.prompt` directly — so the accessor
 * has to live on the raw definitions, not only on the catalog copies that
 * `assignSkillsToAgents` produces. Roles whose prompt file name differs from
 * their role id install their own accessor in the literal instead (see
 * `phase3-techstack.ts`) and are left alone here.
 */
export function applyLazyPrompts<T extends { config: { role?: string | undefined } }>(
  definitions: readonly T[],
): readonly T[] {
  for (const definition of definitions) {
    const role = definition.config.role;
    if (!role) continue;
    if (Object.getOwnPropertyDescriptor(definition.config, 'prompt')) continue;
    defineLazyAgentPrompt(definition.config, role);
  }
  return definitions;
}

/**
 * Re-exported from a leaf module. The implementation lives in
 * `agent-prompt-clone.ts` because `role-skills.ts` also needs it, and importing
 * it from here closed a runtime module cycle through `project-agent-identity.js`.
 */
export { cloneWithLazyPrompt } from './agent-prompt-clone.js';

export function agentPrompt(id: string): string {
  // The policy body itself is a single shared suffix; return it directly
  // when the sentinel key is requested (used by tests / docs).
  if (id === TECH_VERSION_POLICY_KEY) return loadTechVersionPolicy();

  const envDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] ?? '';
  const policyOn = process.env['WRONGSTACK_AGENT_POLICY'] === 'on';
  const cacheBypass =
    (globalThis as { __WS_DISABLE_PROMPT_CACHE__?: boolean }).__WS_DISABLE_PROMPT_CACHE__ === true;
  // The cached value embeds the project-contextualized overlay (identity,
  // learned instructions, knowledge checklist), so the project root is part of
  // the cached string's identity. Omitting it let a single process serve one
  // project's learned content for another project's prompt.
  const promptProjectRoot = process.env['WRONGSTACK_PROJECT_ROOT'] || process.cwd();
  const cacheKey = `${envDir}\u0000${policyOn ? 1 : 0}\u0000${promptProjectRoot}\u0000${id}`;
  const overlayFingerprint = agentOverlayFingerprint(id, promptProjectRoot);
  const cached = cacheBypass ? undefined : promptCache.get(cacheKey);
  // A fingerprint miss means the overlay was rewritten: fall through, rebuild,
  // and OVERWRITE this key rather than leaving a second generation beside it.
  if (cached !== undefined && cached.fingerprint === overlayFingerprint) return cached.prompt;

  if (!id || /[\\/\0]|^\.\.?$|\.\./.test(id)) {
    throw new Error(`Invalid agent prompt id: ${id}`);
  }

  const fileName = `${id}.md`;
  let resolved = '';
  for (const dir of agentPromptDirCandidates(envDir, promptProjectRoot)) {
    try {
      const resolvedDir = path.resolve(dir);
      const candidate = path.resolve(resolvedDir, fileName);
      if (!candidate.startsWith(`${resolvedDir}${path.sep}`)) continue;
      resolved = readFileSync(candidate, 'utf8').trim();
      break;
    } catch {
      // try next candidate
    }
  }
  // The policy body is appended to *every* role's prompt so the latest-stable
  // invariant is enforced uniformly. It is opt-in: the policy ships only when
  // the host explicitly enables it via `WRONGSTACK_AGENT_POLICY=on`. Tests
  // and byte-equality smoke fixtures stay deterministic by default; the
  // dispatcher and `agent-catalog` integration test opt in for the contract.
  const policy = policyOn ? loadTechVersionPolicy() : '';
  if (policy) {
    if (!resolved) {
      resolved = policy;
    } else if (cacheBypass || !resolved.includes('Mandatory modern technology policy')) {
      // Older role briefs reference the policy by name but do not yet embed
      // its body — append the canonical body so every prompt carries the
      // latest-stable invariant in full. In test-bypass mode we always
      // append so the cache-bypass assertion sees the canonical text even
      // when an older prompt already mentions the policy by name.
      resolved = `${resolved}\n\n---\n\n${policy}`;
    }
  }
  // Project-contextualized prompt: overlay identity, learned wisdom and
  // current-knowledge checklist on top of the base role prompt.
  // Uses the current working directory as project root when no explicit
  // WRONGSTACK_PROJECT_ROOT is set, allowing the project-specific agent
  // identity mechanism to work without any code changes.
  resolved = buildProjectContextualizedPrompt(resolved, id, promptProjectRoot);
  if (!cacheBypass)
    promptCache.set(cacheKey, { fingerprint: overlayFingerprint, prompt: resolved });
  return resolved;
}

function agentPromptDirCandidates(envDir: string, projectRoot: string): string[] {
  const profileInstructions = resolveWstackPaths({ projectRoot }).globalInstructions;
  const candKey = `${envDir}\u0000${projectRoot}\u0000${profileInstructions}`;
  const cached = candidateCache.get(candKey);
  if (cached !== undefined) return cached;

  const explicitDir = envDir || undefined;
  const candidates = [
    ...(explicitDir ? [path.resolve(explicitDir)] : []),
    path.join(profileInstructions, 'agents'),
    bundledAgentsDir(),
  ];
  const ordered = candidates.sort((a, b) => Number(!isDirectory(a)) - Number(!isDirectory(b)));
  candidateCache.set(candKey, ordered);
  return ordered;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
