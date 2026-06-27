/**
 * Project-local Design Studio store — a gitignored `<project>/.design/` directory
 * that persists design DECISIONS and project-specific design RULES across
 * sessions, separate from the committed `.wrongstack/design-kits/` (shared
 * custom kits). Layout:
 *
 *   .design/.gitignore   `*`  — self-ignores so the dir is untracked in ANY repo
 *   .design/rules.md     project design rules (always injected when UI work is active)
 *   .design/active.json  { kit, stack } — the pinned kit, restored on session start
 *   .design/decisions.md append-only log of kit choices (timestamp · kit · stack · via)
 *
 * All writes are best-effort: a failure here must never break the tool, slash
 * command, or a turn.
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const DESIGN_DIR = '.design';

export function designProjectDir(projectRoot: string): string {
  return path.join(projectRoot, DESIGN_DIR);
}

const RULE_FILES = ['rules.md', 'RULES.md', 'design.md'];

const rulesCache = new Map<string, string | undefined>();

/** Read `.design/rules.md` (or RULES.md / design.md). Cached per project root. */
export async function loadProjectDesignRules(projectRoot: string): Promise<string | undefined> {
  if (rulesCache.has(projectRoot)) return rulesCache.get(projectRoot);
  let rules: string | undefined;
  for (const name of RULE_FILES) {
    try {
      const txt = await fs.readFile(path.join(designProjectDir(projectRoot), name), 'utf8');
      if (txt.trim()) {
        rules = txt.trim();
        break;
      }
    } catch {
      // file absent — try next
    }
  }
  rulesCache.set(projectRoot, rules);
  return rules;
}

export interface PersistedActiveKit {
  kit: string;
  stack?: string | undefined;
}

/** Read the persisted active kit from `.design/active.json`, if any. */
export async function loadActiveKit(projectRoot: string): Promise<PersistedActiveKit | undefined> {
  try {
    const raw = await fs.readFile(path.join(designProjectDir(projectRoot), 'active.json'), 'utf8');
    const parsed = JSON.parse(raw) as { kit?: unknown; stack?: unknown };
    if (parsed && typeof parsed.kit === 'string') {
      return {
        kit: parsed.kit,
        stack: typeof parsed.stack === 'string' ? parsed.stack : undefined,
      };
    }
  } catch {
    // absent or malformed — no persisted kit
  }
  return undefined;
}

async function ensureDesignDir(projectRoot: string): Promise<string> {
  const dir = designProjectDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  // Self-ignore: a `.gitignore` of `*` makes the whole directory untracked in
  // any project, so design decisions never pollute the repo and we don't have
  // to edit the project's root .gitignore.
  const gi = path.join(dir, '.gitignore');
  if (!existsSync(gi)) {
    try {
      await fs.writeFile(gi, '*\n');
    } catch {
      // best-effort
    }
  }
  return dir;
}

/**
 * Persist a kit choice: update `active.json` and append to `decisions.md`.
 * `isoTime` is passed in so callers control the timestamp (and tests stay
 * deterministic). Best-effort — swallows all errors.
 */
export async function recordKitChoice(
  projectRoot: string,
  kit: string,
  stack: string | undefined,
  source: string,
  isoTime: string,
): Promise<void> {
  try {
    const dir = await ensureDesignDir(projectRoot);
    await fs.writeFile(
      path.join(dir, 'active.json'),
      `${JSON.stringify({ kit, stack: stack ?? null }, null, 2)}\n`,
    );
    const line = `- ${isoTime} · kit=${kit}${stack ? ` stack=${stack}` : ''} · via=${source}\n`;
    await fs.appendFile(path.join(dir, 'decisions.md'), line);
  } catch {
    // best-effort: never break the caller
  }
}

/** Clear the persisted active kit (e.g. `/design off`). Best-effort. */
export async function clearPersistedActiveKit(projectRoot: string): Promise<void> {
  try {
    await fs.rm(path.join(designProjectDir(projectRoot), 'active.json'), { force: true });
  } catch {
    // best-effort
  }
}

/** Test helper — clears the rules cache. */
export function _resetDesignRulesCache(): void {
  rulesCache.clear();
}
