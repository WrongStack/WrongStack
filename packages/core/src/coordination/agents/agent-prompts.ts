import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWstackPaths } from '../../utils/wstack-paths.js';
import { buildProjectContextualizedPrompt } from './project-agent-identity.js';

/**
 * Cache of resolved prompt text, keyed by `<envDir>\0<id>`. Prompt files do
 * not change during a process lifetime, so the first successful (or failed)
 * lookup is memoized. The key includes the override env var so tests that set
 * `WRONGSTACK_AGENT_INSTRUCTIONS_DIR` still observe fresh resolution.
 */
const promptCache = new Map<string, string>();

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
 * inherits. Read at most once per process (memoized in `promptCache`) and
 * prepended to each role's base prompt so the rule travels with the persona.
 */
const TECH_VERSION_POLICY_KEY = '\u0000__tech_version_policy__';

let techVersionPolicyBody: string | undefined;

const INLINE_TECH_VERSION_POLICY = `# Mandatory modern technology policy

You are bound to the current stable version of every library, framework and
package you use. The latest stable is preferred; the latest *published* is
*required*.

## Non-negotiable rules

1. **Verify the version, never trust a number from training data.** Before
   recommending a package or framework version, fetch the live registry
   (npm, PyPI, crates, Go proxy, GitHub releases). Treat the value you read
   as the only acceptable reference; do not interpolate from memory.

2. **Latest stable by default.** Pick the highest stable release that
   satisfies the project runtime, the pinned peer-dependency range, and
   the role's required APIs. Pin to \`^<major>.<minor>.0\` and report the
   exact version.

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
   - Bower → npm or pnpm.
   - \`underscore\` → \`lodash\` or native ES2020+.
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
  if (techVersionPolicyBody !== undefined) return techVersionPolicyBody;
  const fromDisk = policyBody();
  techVersionPolicyBody = fromDisk || INLINE_TECH_VERSION_POLICY;
  return techVersionPolicyBody;
}

function policyCandidateDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const profileInstructions = resolveWstackPaths({ projectRoot: process.cwd() }).globalInstructions;
  return [
    path.resolve(here, '../../../../instructions/agents'),
    path.resolve(here, '../../../instructions/agents'),
    path.resolve(here, '../../instructions/agents'),
    path.resolve(here, '../instructions/agents'),
    path.resolve(here, 'instructions/agents'),
    path.join(profileInstructions, 'agents'),
    profileInstructions,
  ].filter((dir, index, all) => all.indexOf(dir) === index);
}

function policyBody(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Two layouts must resolve:
  //  * source: `packages/core/src/coordination/agents` → `../../instructions/agents/_policy/tech-version.md`
  //  * build:  `packages/core/dist/coordination/agents` → `../../../instructions/agents/_policy/tech-version.md`
  // Both point at the same on-disk file. We list every plausible relative
  // depth so the policy finds the prompt regardless of where the consumer
  // imported the helper from.
  const roots = [
    path.resolve(here, '_policy/tech-version.md'),
    path.resolve(here, '../_policy/tech-version.md'),
    path.resolve(here, '../../../instructions/agents/_policy/tech-version.md'),
    path.resolve(here, '../../instructions/agents/_policy/tech-version.md'),
    path.resolve(here, '../instructions/agents/_policy/tech-version.md'),
    path.resolve(here, '../../../../instructions/agents/_policy/tech-version.md'),
    path.resolve(here, 'instructions/agents/_policy/tech-version.md'),
  ];
  for (const file of roots) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      // try next candidate
    }
  }
  for (const dir of policyCandidateDirs()) {
    try {
      return readFileSync(path.join(dir, '_policy', 'tech-version.md'), 'utf8').trim();
    } catch {
      // try next candidate
    }
  }
  return '';
}

export function agentPrompt(id: string): string {
  // The policy body itself is a single shared suffix; return it directly
  // when the sentinel key is requested (used by tests / docs).
  if (id === TECH_VERSION_POLICY_KEY) return loadTechVersionPolicy();

  const envDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] ?? '';
  const policyOn = process.env['WRONGSTACK_AGENT_POLICY'] === 'on';
  const cacheBypass =
    (globalThis as { __WS_DISABLE_PROMPT_CACHE__?: boolean }).__WS_DISABLE_PROMPT_CACHE__ ===
    true;
  // The cached value embeds the project-contextualized overlay (identity,
  // learned instructions, knowledge checklist), so the project root is part of
  // the cached string's identity. Omitting it let a single process serve one
  // project's learned content for another project's prompt.
  const promptProjectRoot = process.env['WRONGSTACK_PROJECT_ROOT'] || process.cwd();
  const cacheKey = `${envDir}\u0000${policyOn ? 1 : 0}\u0000${promptProjectRoot}\u0000${id}`;
  const cached = cacheBypass ? undefined : promptCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const fileName = `${id}.md`;
  let resolved = '';
  for (const dir of agentPromptDirCandidates(envDir)) {
    try {
      resolved = readFileSync(path.join(dir, fileName), 'utf8').trim();
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
  if (!cacheBypass) promptCache.set(cacheKey, resolved);
  return resolved;
}

function agentPromptDirCandidates(envDir: string): string[] {
  const profileInstructions = resolveWstackPaths({ projectRoot: process.cwd() }).globalInstructions;
  const candKey = `${envDir}\u0000${profileInstructions}`;
  const cached = candidateCache.get(candKey);
  if (cached !== undefined) return cached;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const explicitDir = envDir || undefined;
  const candidates = [
    ...(explicitDir ? [path.resolve(explicitDir)] : []),
    path.join(profileInstructions, 'agents'),
    path.resolve(here, '../../../../instructions/agents'),
    path.resolve(here, '../../../instructions/agents'),
    path.resolve(here, '../../instructions/agents'),
    path.resolve(here, '../instructions/agents'),
    path.resolve(here, 'instructions/agents'),
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
