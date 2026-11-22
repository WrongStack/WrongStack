import { existsSync, readFileSync } from 'node:fs';
import { withinProject } from '../runtime/index.js';
import type { MigrationPlannerConfig } from './migration-config.js';

// ---------------------------------------------------------------------------
// Changelog parsing
// ---------------------------------------------------------------------------

function normalizeVersion(v: string): string {
  // Range operators as package.json spells the installed version (`^1.2.3`).
  return v
    .trim()
    .replace(/^(?:[\^~]|[<>]?=?)\s*/, '')
    .replace(/^v/i, '');
}

export function readChangelog(
  packageName: string,
  cfg: MigrationPlannerConfig,
): { source: string; content: string } | null {
  const candidates = cfg.changelogPaths.map((p) => p.replace(/<package>/g, packageName));
  candidates.push(`node_modules/${packageName}/CHANGELOG.md`);
  candidates.push(`node_modules/${packageName}/changelog.md`);

  for (const candidate of candidates) {
    if (!withinProject(candidate)) continue;
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        return { source: candidate, content: content.slice(0, cfg.maxChars) };
      } catch {
        // best-effort: try next candidate
      }
    }
  }
  return null;
}

interface VersionSection {
  version: string;
  header: string;
  body: string;
}

export function extractVersionSections(
  changelog: string,
  fromVersion: string,
  toVersion: string,
): string[] {
  const fromNv = normalizeVersion(fromVersion);
  const toNv = normalizeVersion(toVersion);

  const sections: VersionSection[] = [];
  let current: VersionSection | null = null;

  for (const line of changelog.split(/\r?\n/)) {
    // `#{2,3}` only: `#` is the document-title level in every common changelog
    // convention (keep-a-changelog's `# Changelog`), so a level-1 heading that
    // embeds a version (`# v1.0.0 — historical archive`) must not become a
    // release section — it would shift body attribution for the real sections.
    const match = line.match(/^#{2,3}\s+(\[?v?(\d+\.\d+\.\d+[^[\]\s]*)\]?)\s*(.*)$/);
    if (match) {
      if (current) sections.push(current);
      current = { version: normalizeVersion(match[2]!), header: match[1]!, body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) return [changelog];

  // Selected by version order, not by finding the two headings: a version
  // copied from package.json (`^1.0.0`) never equalled a heading, so the
  // from-release itself was attributed to the upgrade, and a `to` release the
  // changelog does not list returned the entire history.
  const from = parseVersion(fromNv);
  const to = parseVersion(toNv);
  const relevant: string[] = [];
  if (from && to) {
    for (const section of sections) {
      const version = parseVersion(section.version);
      if (version && compareVersions(version, from) > 0 && compareVersions(version, to) <= 0) {
        relevant.push(`## ${section.header}\n${section.body}`);
      }
    }
    // An empty upgrade range is an answer, not a parse failure: falling back to
    // the whole changelog attributed every listed release to it (F1116).
    return relevant.length > 0 || compareVersions(from, to) <= 0 ? relevant : [changelog];
  }
  for (const section of sections) {
    if (section.version === toNv) {
      relevant.push(`## ${section.header}\n${section.body}`);
    } else if (section.version === fromNv) {
      break;
    } else if (relevant.length > 0) {
      relevant.push(`## ${section.header}\n${section.body}`);
    }
  }

  return relevant.length > 0 ? relevant : [changelog];
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(text: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** SemVer precedence: core numbers, then a prerelease sorts before its release. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = a.core[i]! - b.core[i]!;
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const diff = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (diff !== 0) return diff;
  }
  return 0;
}

export function extractBreakingChanges(sectionText: string): string[] {
  const breaking: string[] = [];
  let inBreakingSection = false;

  for (const rawLine of sectionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^#{3,4}\s+(?:BREAKING\s+CHANGES?|Breaking\s+Changes?|Breaking)/i.test(line)) {
      inBreakingSection = true;
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      inBreakingSection = false;
      continue;
    }
    if (inBreakingSection) {
      const item = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
      if (item) breaking.push(item);
    } else if (
      /^\s*[-*]\s+.*(?:BREAKING|breaking|removed|deprecated|no longer supported)/i.test(rawLine)
    ) {
      breaking.push(line.replace(/^[-*]\s+/, ''));
    }
  }

  return breaking;
}

export function extractRecommendedSteps(sectionText: string): string[] {
  const steps: string[] = [];
  let inMigrationSection = false;

  for (const rawLine of sectionText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^#{3,4}\s+(?:Migration|Upgrade|How to|Steps|Recommended)/i.test(line)) {
      inMigrationSection = true;
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      inMigrationSection = false;
      continue;
    }
    if (inMigrationSection) {
      const item = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
      if (item) steps.push(item);
    }
  }

  if (steps.length === 0) {
    steps.push('Review the changelog for deprecated APIs.');
    steps.push('Update imports and call sites to new API signatures.');
    steps.push('Run the test suite and fix regressions.');
    steps.push('Verify type-checking passes with the new version.');
  }

  return steps;
}

export function buildGenericGuide(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  scope?: string,
): { breakingChanges: string[]; recommendedSteps: string[] } {
  return {
    breakingChanges: [
      `No changelog found for ${packageName}. Unknown breaking changes between ${fromVersion} and ${toVersion}.`,
    ],
    recommendedSteps: [
      `Visit ${packageName} release notes or GitHub releases for ${toVersion}.`,
      scope
        ? `Review ${scope} usage of ${packageName} for API changes.`
        : `Search the codebase for direct ${packageName} usage.`,
      `Update ${packageName} from ${fromVersion} to ${toVersion} in package.json.`,
      'Run install and the full test suite.',
      'Fix type errors and runtime regressions.',
    ],
  };
}
