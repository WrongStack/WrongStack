/**
 * The retired-directive log, and the surgery that keeps a retired directive
 * from surviving inside a document that was distilled while it was still
 * believed.
 *
 * Retirement removes a directive from the capture buffer, but by then it may
 * already have been folded into `skills/<skill>.md` and `consolidated.md` —
 * both of which are injected into every spawn and neither of which is rebuilt
 * until the next optimization pass, up to six hours later. Without the scrub
 * below, "stops being injected" was only true of the buffer, which is the one
 * copy the agent was least likely to be reading.
 *
 * Its own module so both the writer (`project-agent-directive-outcome`) and the
 * reader (`project-agent-consolidation`, building the distillation prompt) can
 * depend on it without depending on each other.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { tokenOverlap } from './project-agent-learning-entries.js';
import {
  MIN_INSTRUCTIVE_LENGTH,
  normalizeForComparison,
} from './project-agent-learning-normalize.js';
import {
  directiveTrials,
  type StructuredLearnedEntry,
} from './project-agent-learning-structured.js';
import { roleDir, writeTextAtomically } from './project-agent-paths.js';

/** Ceiling on the retired-directive log. Local audit only; never injected. */
export const QUARANTINE_MAX_BYTES = 64 * 1024;

/** Same similarity threshold capture and merge use, so the three agree. */
const RETIRED_MATCH_THRESHOLD = 0.55;

export interface QuarantinedDirective {
  what: string;
  skill?: string | undefined;
}

export function quarantinePath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'quarantine.md');
}

function readTextOrEmpty(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Append retired directives to the role's log.
 *
 * They are kept rather than deleted: a directive can be right about a project
 * that has since changed, and the log is the only place to see what the loop
 * decided to stop believing.
 */
export function appendQuarantine(
  role: string,
  retired: readonly StructuredLearnedEntry[],
  at: string,
  projectRoot?: string,
): void {
  if (retired.length === 0) return;
  const filePath = quarantinePath(role, projectRoot);
  const existing = readTextOrEmpty(filePath);
  const header = existing
    ? ''
    : `# Retired directives for \`${role}\`\n\n> Directives that were exercised repeatedly and kept correlating with\n> failure. They are no longer injected anywhere. Kept for audit — a directive\n> can be right about a project that has since changed.\n\n`;
  const block = retired
    .map((entry) => {
      const { applied, wins, losses } = directiveTrials(entry);
      const attributes = [
        `at=${at}`,
        `category=${entry.category}`,
        ...(entry.skill ? [`skill=${entry.skill}`] : []),
        `applied=${applied}`,
        `wins=${wins}`,
      ].join('; ');
      return [
        `<!-- quarantined: ${attributes} -->`,
        `- **${entry.what}**`,
        `  - *Record:* ${wins} succeeded / ${losses} failed of ${applied} applied`,
        '',
      ].join('\n');
    })
    .join('\n');

  let next = `${existing}${header}${block}`;
  if (Buffer.byteLength(next, 'utf8') > QUARANTINE_MAX_BYTES) {
    // Trim from the front at an entry boundary; the newest retirements are the
    // ones worth keeping.
    const marker = '<!-- quarantined:';
    const overflow = Buffer.byteLength(next, 'utf8') - QUARANTINE_MAX_BYTES;
    const cut = next.indexOf(marker, overflow);
    next = cut === -1 ? block : next.slice(cut);
  }
  writeTextAtomically(filePath, next);
}

/** Every directive this role has retired, newest last. */
export function readQuarantinedDirectives(
  role: string,
  projectRoot?: string,
): QuarantinedDirective[] {
  const raw = readTextOrEmpty(quarantinePath(role, projectRoot));
  if (!raw) return [];
  const out: QuarantinedDirective[] = [];
  const stamps = [...raw.matchAll(/<!--\s*quarantined:\s*([^>]*?)\s*-->/g)];
  for (const [index, stamp] of stamps.entries()) {
    const attributes: Record<string, string> = {};
    for (const part of (stamp[1] ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      attributes[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    const start = (stamp.index ?? 0) + stamp[0].length;
    const end = stamps[index + 1]?.index ?? raw.length;
    const what = /^-\s+\*\*([\s\S]+?)\*\*\s*$/m
      .exec(raw.slice(start, end))?.[1]
      ?.replace(/\s+/g, ' ')
      .trim();
    if (!what) continue;
    const skill = attributes['skill'];
    out.push({ what, ...(skill ? { skill } : {}) });
  }
  return out;
}

/** Strip list markup and emphasis so a rendered bullet compares as its claim. */
function bareClaim(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Remove any line that states one of the retired directives, together with the
 * indented lines that hang off it.
 *
 * Line-oriented rather than model-driven on purpose: this runs on the task
 * completion path, where a provider call is not affordable and a failure to
 * scrub means the agent keeps being told to do the thing that kept failing.
 */
export function scrubRetiredLines(text: string, retired: readonly string[]): string {
  if (!text.trim() || retired.length === 0) return text;
  const keys = retired.map((what) => normalizeForComparison(what));
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const claim = bareClaim(line);
    if (
      claim.length >= MIN_INSTRUCTIVE_LENGTH &&
      keys.some(
        (key) => tokenOverlap(key, normalizeForComparison(claim)) >= RETIRED_MATCH_THRESHOLD,
      )
    ) {
      // Drop the continuation lines that belong to this bullet as well.
      const base = indentOf(line);
      while (i + 1 < lines.length) {
        const next = lines[i + 1] as string;
        if (!next.trim() || indentOf(next) <= base) break;
        i++;
      }
      continue;
    }
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Whether a scrubbed document still says anything actionable.
 *
 * Chrome does not count. A skill addendum keeps its title and its standing
 * "read these as refinements of the bundled skill" blockquote no matter how
 * many rules are removed, so testing for "any long line" would report an
 * addendum with nothing left in it as still having content.
 */
export function hasDirectiveContent(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) return false;
    if (/^-{3,}\s*$/.test(trimmed)) return false;
    // The `*Distilled … · N directives*` footer is a stamp, not a directive.
    if (/^\*[^*].*\*$/.test(trimmed)) return false;
    return bareClaim(line).length >= MIN_INSTRUCTIVE_LENGTH;
  });
}

/**
 * Retired directives worth warning the distiller about: the ones it could only
 * resurrect from an existing document.
 *
 * A directive the agent has since written again is deliberately excluded. The
 * whole reason retirement archives rather than deletes is that a rule can be
 * right about a project that has since changed; if the role re-learned it, it
 * is back in the buffer with a fresh record and has earned its second chance.
 */
export function retiredDirectivesToWarnAbout(
  role: string,
  currentDirectives: readonly string[],
  projectRoot?: string,
  skill?: string,
): string[] {
  const currentKeys = currentDirectives.map((text) => normalizeForComparison(text));
  return readQuarantinedDirectives(role, projectRoot)
    .filter((entry) => (skill ? entry.skill === skill : true))
    .map((entry) => entry.what)
    .filter(
      (what) =>
        !currentKeys.some(
          (key) => tokenOverlap(key, normalizeForComparison(what)) >= RETIRED_MATCH_THRESHOLD,
        ),
    );
}
