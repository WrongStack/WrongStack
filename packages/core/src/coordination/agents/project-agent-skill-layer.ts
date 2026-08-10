/**
 * Project-specific **skill development** layer for roster agents.
 *
 * This is deliberately not a memory store. A roster agent's skills are what it
 * knows how to *do*; this layer lets a project grow those skills in place — the
 * bundled `testing` skill body, plus everything this project has taught the
 * `verifier` agent about testing *here*. The addendum is injected directly
 * beneath the bundled skill body at spawn time, so the agent reads one coherent
 * skill rather than a skill plus a pile of recalled facts.
 *
 * Files under `.wrongstack/agents/<role>/skills/`:
 *   `<skill>.md`    — project addendum for that skill (distilled, bounded)
 *   `affinity.json` — per-skill load/outcome/learning counters that drive which
 *                     skills are eagerly loaded for this role in this project
 *
 * Ownership: capture routes each learned directive to a skill
 * (`project-agent-identity.ts`); the optimization pass distills the routed
 * directives into `<skill>.md`; the spawn path reads both
 * (`packages/cli/src/fleet/host-context.ts`).
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { loadProjectAgentConfig } from './project-agent-config-io.js';
import { tokenOverlap } from './project-agent-learning-entries.js';
import { normalizeForComparison } from './project-agent-learning-normalize.js';
import { assertProjectAgentRole, roleDir, writeTextAtomically } from './project-agent-paths.js';
import { loadProjectAgentProfile } from './project-agent-profile.js';
import { ROLE_SKILL_SETS } from './role-skills.js';

/** Skill names follow the same kebab-case contract as the skill loader. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Hard cap on a single skill addendum. Keeps the spawn budget predictable. */
export const SKILL_AUGMENTATION_MAX_BYTES = 6_144;

/** Default number of skills eagerly loaded into a spawn. */
export const DEFAULT_EAGER_SKILL_LIMIT = 3;

export function isProjectSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export function assertProjectSkillName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!isProjectSkillName(normalized)) {
    throw new Error(`Invalid project skill name: "${name}".`);
  }
  return normalized;
}

export function projectSkillsDir(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'skills');
}

export function projectSkillAugmentationPath(
  role: string,
  skill: string,
  projectRoot?: string,
): string {
  return path.join(projectSkillsDir(role, projectRoot), `${assertProjectSkillName(skill)}.md`);
}

export function projectSkillAffinityPath(role: string, projectRoot?: string): string {
  return path.join(projectSkillsDir(role, projectRoot), 'affinity.json');
}

// ---------------------------------------------------------------------------
// Skill augmentation documents
// ---------------------------------------------------------------------------

export function loadProjectSkillAugmentation(
  role: string,
  skill: string,
  projectRoot?: string,
): string {
  try {
    return readFileSync(projectSkillAugmentationPath(role, skill, projectRoot), 'utf8').trim();
  } catch {
    return '';
  }
}

export function saveProjectSkillAugmentation(
  role: string,
  skill: string,
  content: string,
  projectRoot?: string,
): string {
  const filePath = projectSkillAugmentationPath(role, skill, projectRoot);
  const trimmed = content.trim();
  // A distillation that produced nothing must not clobber a good addendum.
  if (!trimmed) return filePath;
  writeTextAtomically(filePath, `${boundAugmentation(trimmed)}\n`);
  return filePath;
}

/**
 * Keep an addendum under budget: its title, then as much of the **end** as fits.
 *
 * Two things the previous byte-offset slice got wrong. It could land inside a
 * command or a path, and a half-written anchor is worse than a missing one —
 * the agent is handed something that looks runnable and is not. And it kept the
 * head, which in the append-fallback path is the oldest material, so the
 * directives this project learned most recently were the first to be dropped.
 */
function boundAugmentation(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= SKILL_AUGMENTATION_MAX_BYTES) return text;
  const notice = `\n\n_(truncated at ${SKILL_AUGMENTATION_MAX_BYTES} bytes)_`;
  const lines = text.split('\n');
  const title = lines[0] ?? '';
  let budget =
    SKILL_AUGMENTATION_MAX_BYTES -
    Buffer.byteLength(`${title}\n${notice}`, 'utf8') -
    Buffer.byteLength('…\n', 'utf8');
  const tail: string[] = [];
  for (let i = lines.length - 1; i > 0; i--) {
    const cost = Buffer.byteLength(`${lines[i] as string}\n`, 'utf8');
    if (cost > budget) break;
    tail.unshift(lines[i] as string);
    budget -= cost;
  }
  if (tail.length === 0) return `${title.slice(0, SKILL_AUGMENTATION_MAX_BYTES)}${notice}`;
  return `${title}\n…\n${tail.join('\n').trimEnd()}${notice}`;
}

export function clearProjectSkillAugmentation(
  role: string,
  skill?: string,
  projectRoot?: string,
): void {
  const target = skill
    ? projectSkillAugmentationPath(role, skill, projectRoot)
    : projectSkillsDir(role, projectRoot);
  try {
    rmSync(target, { force: true, recursive: !skill });
  } catch {
    // already absent
  }
}

/** Skill names that have a project addendum for this role. */
export function listProjectSkillAugmentations(role: string, projectRoot?: string): string[] {
  try {
    return readdirSync(projectSkillsDir(role, projectRoot))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .filter(isProjectSkillName)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Render a distilled skill addendum. Used as the deterministic fallback when no
 * LLM is available — the directives are already instructive, so emitting them
 * verbatim under a stable header is strictly better than no addendum.
 *
 * `existing` is **not optional in practice**: this renderer only ever sees the
 * directives currently sitting in the capture buffer, and the buffer is pruned
 * after every successful optimization. Rendering from the buffer alone and
 * writing the result over the file therefore deleted every directive distilled
 * by an earlier pass. That happened silently on any headless box, and on a
 * model-backed one whenever a single per-skill call timed out and the role-level
 * consolidation then pruned; the only remaining copy was under `archive/`.
 *
 * Passing the current addendum in keeps it: prior body first, new directives
 * appended, near-duplicates of lines already present dropped.
 */
export function renderSkillAugmentation(
  role: string,
  skill: string,
  directives: readonly string[],
  updatedAt: string,
  existing?: string,
): string {
  const priorBody = stripAugmentationFooter(existing ?? '');
  const priorLines = priorBody
    .split('\n')
    .map((line) => normalizeForComparison(line.replace(/^[-*]\s+/, '')))
    .filter(Boolean);
  const fresh = directives.filter(
    (directive) =>
      !priorLines.some((line) => tokenOverlap(line, normalizeForComparison(directive)) >= 0.55),
  );
  if (priorBody) {
    // Nothing new to say: hand back the file exactly as it is, footer and all,
    // so a repeated pass over an unchanged buffer is a true no-op. Returning
    // the footer-stripped body would make every quiet pass a rewrite.
    if (fresh.length === 0) return `${(existing ?? '').trim()}\n`;
    return [
      priorBody,
      '',
      ...fresh.map((directive) => `- ${directive}`),
      '',
      '---',
      `*Distilled ${updatedAt} · ${fresh.length} new directive${fresh.length === 1 ? '' : 's'}*`,
      '',
    ].join('\n');
  }
  return [
    `# Project practice: \`${skill}\` (role: \`${role}\`)`,
    '',
    `> How the \`${skill}\` skill is applied **in this project**. Read these as`,
    `> refinements of the bundled skill, not as separate facts to recall.`,
    '',
    ...directives.map((directive) => `- ${directive}`),
    '',
    '---',
    `*Distilled ${updatedAt} · ${directives.length} directive${directives.length === 1 ? '' : 's'}*`,
    '',
  ].join('\n');
}

/** Drop the trailing `--- / *Distilled …*` block so a re-render appends cleanly. */
function stripAugmentationFooter(text: string): string {
  return text
    .replace(/\n*---\s*\n\*(?:Distilled|Truncated)[^\n]*\*\s*$/i, '')
    .replace(/\n*_\(truncated at \d+ bytes\)_\s*$/i, '')
    .trimEnd();
}

/**
 * Instruction for the optimization pass: turn the directives that capture
 * routed to one skill into that skill's project addendum.
 */
export function buildSkillDistillInstruction(
  role: string,
  skill: string,
  directives: readonly string[],
  existing?: string,
  retired: readonly string[] = [],
): string {
  const sections = [
    `You are refining the \`${skill}\` skill for the "${role}" agent **in this project**.`,
    '',
    'The bundled `' +
      skill +
      '` skill already teaches the general method. Your job is to write the *project addendum*: the delta a future invocation needs so it applies this skill correctly in this specific codebase.',
    '',
    '## Requirements',
    '',
    '1. **Delta only.** Never restate the general skill. Write only what is specific to this project — its commands, paths, conventions, and known failure modes.',
    '2. **Instructional voice.** Each bullet is something the agent should do or avoid while exercising this skill, not a report of what happened.',
    '3. **Keep the anchors.** Preserve exact commands, file paths, package names, and config keys; they are what make the addendum runnable.',
    '4. **Merge, do not append.** Combine overlapping directives into one sharper rule. The output must be shorter than the input.',
    '5. **Structure.** Short `##` sections when it helps (e.g. Commands, Conventions, Pitfalls); bullets otherwise.',
    '6. **Budget.** Stay under 400 words. Drop the weakest directives rather than compressing everything into noise.',
    '7. **Weigh the track record.** Some directives carry one, shown as `[applied N×, M ok]` — the number of completed tasks that exercised the directive and how many of those succeeded. Lead with the ones that keep working. A directive applied several times with few successes has been tested and found wanting: drop it, or state the narrower condition under which it actually holds. A directive with no record is unproven, not bad — keep it if it is sound, but do not let it displace a proven one.',
    '',
    `## Directives captured for \`${skill}\` (${directives.length})`,
    '',
    ...directives.map((directive, i) => `${i + 1}. ${directive}`),
  ];
  if (existing?.trim()) {
    sections.push('', '## Existing addendum (improve upon it)', '', existing.trim());
  }
  if (retired.length > 0) {
    sections.push(
      '',
      `## Retired — do not reinstate (${retired.length})`,
      '',
      'These were exercised repeatedly and kept correlating with failed tasks. If the existing addendum still states any of them, drop it.',
      '',
      ...retired.map((what) => `- ${what}`),
    );
  }
  sections.push(
    '',
    '## Output',
    '',
    'Return ONLY the markdown addendum. No preamble, no code fences around the whole document, no commentary.',
  );
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Skill affinity — which skills actually earn their place for this role
// ---------------------------------------------------------------------------

export interface SkillAffinityEntry {
  /** Times this skill was eagerly loaded into a spawn of this role. */
  loaded: number;
  /** Task outcomes observed while this skill was loaded. */
  succeeded: number;
  failed: number;
  /** Learned directives routed to this skill. */
  learned: number;
  lastUsedAt?: string | undefined;
  /** Operator pin — always selected, never rotated out. */
  pinned?: boolean | undefined;
}

export interface SkillAffinity {
  role: string;
  entries: Record<string, SkillAffinityEntry>;
  updatedAt: string;
}

const EMPTY_ENTRY: SkillAffinityEntry = { loaded: 0, succeeded: 0, failed: 0, learned: 0 };

function normalizeAffinityEntry(value: unknown): SkillAffinityEntry {
  const raw = (value ?? {}) as Partial<SkillAffinityEntry>;
  const count = (n: unknown): number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return {
    loaded: count(raw.loaded),
    succeeded: count(raw.succeeded),
    failed: count(raw.failed),
    learned: count(raw.learned),
    ...(typeof raw.lastUsedAt === 'string' ? { lastUsedAt: raw.lastUsedAt } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
  };
}

export function loadSkillAffinity(role: string, projectRoot?: string): SkillAffinity {
  const normalizedRole = assertProjectAgentRole(role);
  try {
    const parsed = JSON.parse(
      readFileSync(projectSkillAffinityPath(normalizedRole, projectRoot), 'utf8'),
    ) as Partial<SkillAffinity>;
    const entries: Record<string, SkillAffinityEntry> = {};
    for (const [skill, entry] of Object.entries(parsed.entries ?? {})) {
      if (!isProjectSkillName(skill)) continue;
      entries[skill] = normalizeAffinityEntry(entry);
    }
    return {
      role: normalizedRole,
      entries,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { role: normalizedRole, entries: {}, updatedAt: new Date(0).toISOString() };
  }
}

function saveSkillAffinity(affinity: SkillAffinity, projectRoot?: string): void {
  writeTextAtomically(
    projectSkillAffinityPath(affinity.role, projectRoot),
    `${JSON.stringify(affinity, null, 2)}\n`,
  );
}

function mutateAffinity(
  role: string,
  skills: readonly string[],
  projectRoot: string | undefined,
  mutate: (entry: SkillAffinityEntry) => void,
): SkillAffinity {
  const affinity = loadSkillAffinity(role, projectRoot);
  let changed = false;
  for (const raw of skills) {
    if (!isProjectSkillName(raw)) continue;
    const entry = { ...EMPTY_ENTRY, ...affinity.entries[raw] };
    mutate(entry);
    affinity.entries[raw] = entry;
    changed = true;
  }
  if (!changed) return affinity;
  affinity.updatedAt = new Date().toISOString();
  try {
    saveSkillAffinity(affinity, projectRoot);
  } catch {
    // Affinity is an optimization signal — never fail a spawn over it.
  }
  return affinity;
}

/** Record that these skills were loaded into a spawn of `role`. */
export function recordSkillLoad(
  role: string,
  skills: readonly string[],
  projectRoot?: string,
): void {
  const now = new Date().toISOString();
  mutateAffinity(role, skills, projectRoot, (entry) => {
    entry.loaded += 1;
    entry.lastUsedAt = now;
  });
}

/**
 * Record the outcome of a task that ran with these skills loaded.
 *
 * Also stamps `lastUsedAt`: an outcome is the strongest evidence that a skill
 * was in use, and the recency decay in {@link scoreSkillAffinity} reads that
 * stamp. Leaving it to `recordSkillLoad` alone meant an affinity file written
 * only through this path looked like it had never been touched.
 */
export function recordSkillOutcome(
  role: string,
  skills: readonly string[],
  ok: boolean,
  projectRoot?: string,
): void {
  const now = new Date().toISOString();
  mutateAffinity(role, skills, projectRoot, (entry) => {
    if (ok) entry.succeeded += 1;
    else entry.failed += 1;
    entry.lastUsedAt = now;
  });
}

/** Record that a learned directive was routed to this skill. */
export function recordSkillLearned(role: string, skill: string, projectRoot?: string): void {
  mutateAffinity(role, [skill], projectRoot, (entry) => {
    entry.learned += 1;
  });
}

export function setSkillPinned(
  role: string,
  skill: string,
  pinned: boolean,
  projectRoot?: string,
): SkillAffinity {
  return mutateAffinity(role, [skill], projectRoot, (entry) => {
    if (pinned) entry.pinned = true;
    else delete entry.pinned;
  });
}

/** Half-life of outcome evidence, in days. Older evidence fades toward neutral. */
export const SKILL_EVIDENCE_HALF_LIFE_DAYS = 30;

/**
 * Score a skill for this role. Higher wins. Deterministic and monotone: with no
 * recorded history every candidate scores exactly the same, so ranking falls
 * back to the curated order and a fresh project behaves as if this layer did
 * not exist.
 *
 * Four properties the previous scoring got wrong, each of which showed up as a
 * skill that could not be dislodged:
 *
 * 1. **Failure counts against a skill.** The old form skipped Laplace smoothing
 *    when there were no outcomes, so "no evidence" scored 0 while ten straight
 *    failures scored 0.25 — failure ranked as evidence of relevance. The
 *    success rate is now centred on the 0.5 prior, so a losing record is
 *    negative and an untried skill is exactly neutral.
 * 2. **Exposure is not merit.** `min(loaded, 10) * 0.1` paid a skill up to a
 *    full point for having been selected, which is a loop: selected skills
 *    out-scored unselected ones because they had been selected. The term is now
 *    an exploration bonus that *decays* with load count, so a skill that has
 *    never been tried is the one with something to prove.
 * 3. **Evidence goes stale.** Counters are lifetime totals; a project that
 *    switched test runners four months ago still carried the old runner's wins
 *    at full weight. Outcome evidence now decays with a
 *    {@link SKILL_EVIDENCE_HALF_LIFE_DAYS}-day half-life.
 * 4. **One chatty skill could pin the top slot.** `learned * 2` is unbounded, so
 *    a skill that attracts routing dominates every other signal forever. It is
 *    now logarithmic: still the strongest single term, no longer a lock.
 *
 * A missing `lastUsedAt` means "unknown", not "ancient" — legacy affinity files
 * written before the field existed must not have their evidence zeroed.
 */
export function scoreSkillAffinity(
  entry: SkillAffinityEntry | undefined,
  now: number = Date.now(),
): number {
  const record = entry ?? EMPTY_ENTRY;
  if (record.pinned) return Number.POSITIVE_INFINITY;
  const outcomes = record.succeeded + record.failed;
  // Laplace-smoothed in every branch: no outcomes ⇒ exactly the 0.5 prior.
  const successRate = (record.succeeded + 1) / (outcomes + 2);
  const ageDays = record.lastUsedAt
    ? (now - Date.parse(record.lastUsedAt)) / 86_400_000
    : Number.NaN;
  const recency = Number.isFinite(ageDays)
    ? 0.5 ** (Math.max(0, ageDays) / SKILL_EVIDENCE_HALF_LIFE_DAYS)
    : 1;
  const evidence = (successRate - 0.5) * 4 * recency;
  const exploration = 1 / Math.sqrt(1 + record.loaded);
  return Math.log1p(record.learned) * 2 + evidence + exploration;
}

/**
 * Rank the candidate skills for a role by project affinity, keeping the
 * curated order as a stable tie-break, and return at most `limit` names.
 *
 * A skill that has accumulated project-specific learning outranks one that has
 * not: the whole point of the layer is that a skill the project actually
 * developed is more valuable here than a generic sibling.
 */
export function rankRoleSkills(
  role: string,
  candidates: readonly string[],
  projectRoot?: string,
  limit: number = DEFAULT_EAGER_SKILL_LIMIT,
): string[] {
  const unique = [...new Set(candidates.filter(isProjectSkillName))];
  if (unique.length <= limit) return unique;
  const affinity = loadSkillAffinity(role, projectRoot);
  const augmented = new Set(listProjectSkillAugmentations(role, projectRoot));
  const now = Date.now();
  return unique
    .map((skill, index) => ({
      skill,
      index,
      // An existing addendum is itself evidence the project developed this
      // skill, even when the affinity file was reset or hand-edited.
      score: scoreSkillAffinity(affinity.entries[skill], now) + (augmented.has(skill) ? 1 : 0),
    }))
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .slice(0, limit)
    .map((item) => item.skill);
}

// ---------------------------------------------------------------------------
// Candidate resolution and directive routing
// ---------------------------------------------------------------------------

/**
 * Every skill this role could legitimately develop in this project:
 * the project override when present, otherwise the curated catalog set (or the
 * base role's set for a project-created role), always unioned with any skill
 * that already carries a project addendum.
 */
export function resolveRoleSkillCandidates(role: string, projectRoot?: string): string[] {
  const normalizedRole = assertProjectAgentRole(role);
  const override = loadProjectAgentConfig(normalizedRole, projectRoot)?.skillNames;
  const curated =
    override ??
    ROLE_SKILL_SETS[normalizedRole as keyof typeof ROLE_SKILL_SETS] ??
    (() => {
      const profile = loadProjectAgentProfile(normalizedRole, projectRoot);
      const base = profile?.baseRole as keyof typeof ROLE_SKILL_SETS | undefined;
      return base ? ROLE_SKILL_SETS[base] : undefined;
    })() ??
    [];
  return [
    ...new Set([...curated, ...listProjectSkillAugmentations(normalizedRole, projectRoot)]),
  ].filter(isProjectSkillName);
}

/**
 * Vocabulary that maps a directive's wording onto a bundled skill. Only used
 * to route a captured directive when the agent did not tag it explicitly;
 * an unroutable directive simply stays role-level, which is always safe.
 */
const SKILL_VOCABULARY: Record<string, readonly string[]> = {
  'api-design': ['api', 'endpoint', 'rest', 'openapi', 'schema', 'contract', 'versioning'],
  'audit-log': ['audit', 'log', 'logging', 'trace', 'provenance', 'ledger'],
  'bug-hunter': ['bug', 'defect', 'repro', 'root cause', 'regression', 'crash'],
  chimera: ['review', 'reviewer', 'critique', 'adversarial', 'second opinion'],
  'data-governance': ['pii', 'retention', 'governance', 'gdpr', 'data policy'],
  'docker-deploy': ['docker', 'container', 'image', 'compose', 'deploy', 'k8s'],
  'git-flow': ['git', 'branch', 'commit', 'rebase', 'merge', 'worktree', 'pr'],
  mnemosyne: ['memory', 'recall', 'knowledge base'],
  'multi-agent': ['subagent', 'fleet', 'director', 'delegate', 'coordination', 'roster'],
  'node-modern': ['node', 'esm', 'package.json', 'pnpm', 'npm', 'runtime'],
  observability: ['metric', 'telemetry', 'tracing', 'dashboard', 'alert', 'profil'],
  'output-standards': ['format', 'report', 'output', 'markdown', 'summary'],
  'plugin-author': ['plugin', 'hook', 'manifest', 'extension'],
  'prompt-engineering': ['prompt', 'system message', 'instruction', 'few-shot'],
  'react-modern': ['react', 'component', 'hook', 'jsx', 'tsx', 'render', 'ui'],
  'refactor-planner': ['refactor', 'extract', 'rename', 'restructure', 'decompose'],
  'research-web': ['research', 'documentation', 'upstream', 'changelog', 'registry'],
  sdd: ['spec', 'requirement', 'acceptance', 'plan', 'task breakdown'],
  'security-scanner': ['security', 'vulnerab', 'injection', 'secret', 'auth', 'sanitiz'],
  'skill-creator': ['skill', 'skill.md', 'authoring'],
  'tech-stack': ['dependency', 'version', 'upgrade', 'toolchain', 'stack'],
  testing: ['test', 'vitest', 'jest', 'coverage', 'assert', 'fixture', 'mock', 'spec file'],
  'typescript-strict': ['typescript', 'tsc', 'type', 'generic', 'strict', 'noemit', '.d.ts'],
  'wrongstack-mailbox': ['mailbox', 'message', 'inbox', 'broadcast'],
};

function skillTokens(skill: string): string[] {
  return [...skill.split('-'), ...(SKILL_VOCABULARY[skill] ?? [])].filter(
    (token) => token.length >= 3,
  );
}

/** Explicit tag form the agent can use: `## LEARNED [skill: testing]`. */
export const LEARNED_SKILL_TAG = /\[\s*skill\s*[:=]\s*([a-z0-9][a-z0-9-]{0,63})\s*\]/i;

/**
 * Route a captured directive to one of the role's candidate skills.
 * Returns `undefined` when nothing matches well enough — an unrouted directive
 * stays role-level rather than being forced into the wrong skill.
 */
export function routeDirectiveToSkill(
  text: string,
  candidates: readonly string[],
): string | undefined {
  const tagged = LEARNED_SKILL_TAG.exec(text)?.[1]?.toLowerCase();
  if (tagged && candidates.includes(tagged)) return tagged;
  const haystack = text.toLowerCase();
  let best: { skill: string; score: number } | undefined;
  for (const skill of candidates) {
    let score = 0;
    for (const token of skillTokens(skill)) {
      if (haystack.includes(token)) score += token.length >= 6 ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { skill, score };
  }
  // Require more than one weak hit so a stray "test" in prose does not
  // permanently bind an unrelated directive to the testing skill.
  return best && best.score >= 2 ? best.skill : undefined;
}
