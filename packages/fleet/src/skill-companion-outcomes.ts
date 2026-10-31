/**
 * What the leader did with Skill Companion recommendations, across sessions.
 *
 * A recommendation ends one of two ways in a session: the leader loaded the
 * skill (accepted) or retried past the hold / could not load it (declined).
 * The counts live in `.wrongstack/agents/skill-companion/outcomes.json`, local
 * like the roster's `affinity.json` — one person's habits are not the team's.
 *
 * The rule is deterministic and forgiving: a skill is withheld from the judge
 * and from declared-path holds only while its declines outweigh its accepts
 * (each accept cancels two declines) by {@link SUPPRESS_AT} or more, and the
 * latest decline is recent. One accept, or a quiet month, brings it back.
 *
 * Everything here is an optimization signal: a read or write failure skips
 * the update and never overwrites what the file holds.
 *
 * @module skill-companion-outcomes
 */

import * as path from 'node:path';
import { readRoleFileForUpdate, roleDir, writeTextAtomically } from '@wrongstack/agent-catalog';

export const SUPPRESS_AT = 3;
const ACCEPT_WEIGHT = 2;
const SUPPRESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SKILLS = 256;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillOutcomeEntry {
  accepted: number;
  declined: number;
  lastAcceptedAt?: string | undefined;
  lastDeclinedAt?: string | undefined;
}

export interface SkillOutcomes {
  version: 1;
  skills: Record<string, SkillOutcomeEntry>;
  updatedAt: string;
}

export function skillOutcomesPath(projectRoot: string): string {
  return path.join(roleDir('skill-companion', projectRoot), 'outcomes.json');
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function empty(): SkillOutcomes {
  return { version: 1, skills: {}, updatedAt: new Date(0).toISOString() };
}

function parse(text: string): SkillOutcomes {
  if (!text.trim()) return empty();
  const raw = JSON.parse(text) as { skills?: unknown; updatedAt?: unknown };
  const skills: Record<string, SkillOutcomeEntry> = {};
  if (raw.skills && typeof raw.skills === 'object') {
    for (const [name, entry] of Object.entries(raw.skills as Record<string, unknown>)) {
      if (!SKILL_NAME.test(name) || !entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      skills[name] = {
        accepted: count(e['accepted']),
        declined: count(e['declined']),
        lastAcceptedAt: stamp(e['lastAcceptedAt']),
        lastDeclinedAt: stamp(e['lastDeclinedAt']),
      };
    }
  }
  return { version: 1, skills, updatedAt: stamp(raw.updatedAt) ?? empty().updatedAt };
}

/** Lenient read for decisions: anything unreadable is "no history". */
export function loadSkillOutcomes(projectRoot: string): SkillOutcomes {
  try {
    return parse(readRoleFileForUpdate(skillOutcomesPath(projectRoot)));
  } catch {
    return empty();
  }
}

/**
 * Add one session's settled recommendations. Strict read: an unreadable file
 * is left alone rather than rewritten from nothing. Returns the new counts,
 * or undefined when nothing was written.
 */
export function recordSkillOutcomes(
  projectRoot: string,
  outcome: { accepted: readonly string[]; declined: readonly string[] },
  now = new Date(),
): SkillOutcomes | undefined {
  if (outcome.accepted.length === 0 && outcome.declined.length === 0) return undefined;
  const file = skillOutcomesPath(projectRoot);
  let outcomes: SkillOutcomes;
  try {
    outcomes = parse(readRoleFileForUpdate(file));
  } catch {
    return undefined;
  }
  const at = now.toISOString();
  const bump = (name: string, field: 'accepted' | 'declined') => {
    if (!SKILL_NAME.test(name)) return;
    const entry = outcomes.skills[name] ?? { accepted: 0, declined: 0 };
    entry[field]++;
    if (field === 'accepted') entry.lastAcceptedAt = at;
    else entry.lastDeclinedAt = at;
    outcomes.skills[name] = entry;
  };
  for (const name of outcome.accepted) bump(name, 'accepted');
  for (const name of outcome.declined) bump(name, 'declined');
  // Bound the file: keep the most recently touched skills.
  const recent = (entry: SkillOutcomeEntry) =>
    Math.max(
      Date.parse(entry.lastAcceptedAt ?? '') || 0,
      Date.parse(entry.lastDeclinedAt ?? '') || 0,
    );
  const names = Object.keys(outcomes.skills).sort(
    (a, b) => recent(outcomes.skills[b]!) - recent(outcomes.skills[a]!),
  );
  for (const name of names.slice(MAX_SKILLS)) delete outcomes.skills[name];
  outcomes.updatedAt = at;
  try {
    writeTextAtomically(file, `${JSON.stringify(outcomes, null, 2)}\n`);
  } catch {
    return undefined;
  }
  return outcomes;
}

/** Whether the leader has turned this skill down often and lately enough to stop offering it. */
export function isSkillSuppressed(entry: SkillOutcomeEntry | undefined, now = Date.now()): boolean {
  if (!entry) return false;
  if (entry.declined - ACCEPT_WEIGHT * entry.accepted < SUPPRESS_AT) return false;
  const last = Date.parse(entry.lastDeclinedAt ?? '');
  return Number.isFinite(last) && now - last <= SUPPRESS_WINDOW_MS;
}
