import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectDefined } from '@wrongstack/core/utils';

export type BumpType = 'major' | 'minor' | 'patch' | 'auto';

export interface ConventionalCommit {
  hash: string;
  type: string;
  scope?: string | undefined;
  message: string;
  breaking: boolean;
}

export function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf-8',
        cwd,
        timeout: 30_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout.trim());
          return;
        }
        const failure = err as Error & { code?: number | string; status?: number };
        reject(Object.assign(failure, { stderr: stderr || undefined }));
      },
    );
  });
}

export async function runGit(args: string[], cwd?: string): Promise<string> {
  try {
    return await runCommand('git', args, cwd);
  } catch (err: unknown) {
    const e = err as {
      code?: number | string | undefined;
      message?: string | undefined;
      status?: number | undefined;
      stderr?: string | undefined;
    };
    if (e.status === 128 || e.code === 128) throw new Error('Not a git repository');
    /* v8 ignore next -- child process errors carry .message; the stderr/String fallbacks are defensive. */
    throw new Error(`git failed: ${e.message ?? e.stderr ?? String(err)}`);
  }
}

export async function getPackageJson(cwd?: string): Promise<{ version: string } | null> {
  const path = cwd ? `${cwd}/package.json` : 'package.json';
  try {
    await access(path);
    return JSON.parse((await readFile(path, 'utf-8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Every package.json that must share the repo version: the root manifest plus
 * workspace packages under packages/* and apps/* (mirrors
 * scripts/bump-version.mjs). Single-package repos degrade to just the root.
 */
export async function collectManifests(root: string): Promise<string[]> {
  const paths: string[] = [];
  const rootPkg = join(root, 'package.json');
  try {
    await access(rootPkg);
    paths.push(rootPkg);
  } catch {
    /* absent */
  }
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    let entries;
    try {
      entries = await readdir(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(groupDir, entry.name, 'package.json');
      try {
        await access(candidate);
        paths.push(candidate);
      } catch {
        /* absent */
      }
    }
  }
  return paths;
}

export function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [
    Number.parseInt(expectDefined(m[1]), 10),
    Number.parseInt(expectDefined(m[2]), 10),
    Number.parseInt(expectDefined(m[3]), 10),
  ];
}

export function bumpVersion(version: string, part: BumpType): string {
  let [major, minor, patch] = parseVersion(version);
  // A prerelease precedes its release (SemVer §11), so bumping it first lands
  // on that release, as `npm version` does: 1.2.3-beta.1 → patch = 1.2.3,
  // 1.3.0-rc.1 → minor = 1.3.0, 2.0.0-rc.1 → major = 2.0.0. Incrementing
  // unconditionally skipped the release the prerelease was building toward.
  const prerelease = /^v?\d+\.\d+\.\d+-/.test(version);

  if (part === 'major') {
    if (!(prerelease && minor === 0 && patch === 0)) major++;
    minor = 0;
    patch = 0;
  } else if (part === 'minor') {
    if (!(prerelease && patch === 0)) minor++;
    patch = 0;
  } else if (part === 'patch') {
    if (!prerelease) patch++;
  } else {
    /* v8 ignore next -- callers resolve 'auto' to a concrete part before calling bumpVersion; this return is defensive. */
    return version; // auto requires commit analysis
  }

  return `${major}.${minor}.${patch}`;
}

const BREAKING_MENTION = /(?:^|\W)(BREAKING[ -]CHANGES?)(?!\w)/gi;
/** Words that deny the mention right before it: "no", "not (a)", "without", "zero", "non-". */
const NEGATED_BEFORE = /(?:\bno|\bnot(?:\s+an?)?|\bwithout|\bzero|\bnon)[\s-]*$/i;

/**
 * A body mention of a breaking change, unless that mention is negated —
 * "No breaking changes." and "non-breaking change" are the commonest
 * lowercase uses, and each forced a MAJOR bump.
 */
function bodyAnnouncesBreaking(body: string): boolean {
  for (const m of body.matchAll(BREAKING_MENTION)) {
    const start = m.index + m[0].length - m[1]!.length;
    if (!NEGATED_BEFORE.test(body.slice(Math.max(0, start - 16), start))) return true;
  }
  return false;
}

/** Parse a conventional-commit subject line and optional body. Accepts the breaking `!` both
 * before and after the scope (`feat!: x`, `feat(api)!: x`), and checks body for BREAKING CHANGE. */
export function parseConventional(subject: string, body = ''): Omit<ConventionalCommit, 'hash'> {
  const m = subject.match(/^(\w+)(!)?(?:\(([^)]+)\))?(!)?:\s+(.+)/);
  const hasBreakingInSubject = !!(m?.[2] ?? m?.[4]);
  // Prose-aware: spec footers (`BREAKING CHANGE: …` / `BREAKING-CHANGE: …`)
  // AND plain mentions ("this is a BREAKING CHANGE for consumers") both count,
  // so a breaking commit can no longer fold into a minor bump by omitting the
  // footer colon. Subject `!` handling is unchanged.
  const hasBreakingInBody = bodyAnnouncesBreaking(body);
  return {
    // Types are case-insensitive (Conventional Commits §16), and
    // commit-validator lowercases them before validating: `Feat: x` passed
    // the gate as a feat but missed `type === 'feat'` here and bumped patch.
    type: m?.[1]?.toLowerCase() ?? 'chore',
    breaking: hasBreakingInSubject || hasBreakingInBody,
    scope: m?.[3],
    message: m?.[5] ?? subject,
  };
}

export function parseGitLogOutput(output: string): ConventionalCommit[] {
  if (!output) return [];

  if (output.includes('\x1e') || output.includes('\x1f')) {
    return output
      .split('\x1e')
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => {
        const parts = block.split('\x1f');
        const hash = parts[0] ?? '';
        const subject = parts[1] ?? '';
        const body = parts[2] ?? '';
        return { hash, ...parseConventional(subject, body) };
      });
  }

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) {
        return { hash: line, ...parseConventional('') };
      }
      const hash = line.slice(0, spaceIdx);
      const message = line.slice(spaceIdx + 1);
      return { hash, ...parseConventional(message) };
    });
}

export async function getRecentCommits(
  sinceTag?: string,
  cwd?: string,
): Promise<ConventionalCommit[]> {
  const range = sinceTag ? `${sinceTag}..HEAD` : '-30';
  const output = await runGit(['log', range, '--format=%H%x1f%s%x1f%b%x1e'], cwd);
  return parseGitLogOutput(output);
}

export function determineBump(commits: ConventionalCommit[]): BumpType {
  if (commits.some((c) => c.breaking)) return 'major';
  if (commits.some((c) => c.type === 'feat')) return 'minor';
  return 'patch';
}

export function generateChangelog(commits: ConventionalCommit[]): string {
  const sections = {
    breaking: [] as ConventionalCommit[],
    feat: [] as ConventionalCommit[],
    fix: [] as ConventionalCommit[],
    perf: [] as ConventionalCommit[],
    docs: [] as ConventionalCommit[],
    refactor: [] as ConventionalCommit[],
    test: [] as ConventionalCommit[],
    chore: [] as ConventionalCommit[],
    other: [] as ConventionalCommit[],
  };
  type SectionKey = keyof typeof sections;

  for (const c of commits) {
    if (c.breaking) {
      sections.breaking.push(c);
    } else if (Object.hasOwn(sections, c.type)) {
      sections[c.type as SectionKey].push(c);
    } else {
      sections.other.push(c);
    }
  }

  const lines: string[] = ['# Changelog\n'];

  if (sections.breaking.length > 0) {
    lines.push('## ⚠️ BREAKING CHANGES\n');
    for (const c of sections.breaking) {
      lines.push(`- **${c.hash.slice(0, 7)}** ${c.message} (${c.type})`);
    }
    lines.push('');
  }

  const ordered = ['feat', 'fix', 'perf', 'docs', 'refactor', 'test', 'chore', 'other'] as const;
  const labels: Record<SectionKey, string> = {
    breaking: 'Breaking',
    feat: 'Features',
    fix: 'Bug Fixes',
    perf: 'Performance',
    docs: 'Documentation',
    refactor: 'Refactoring',
    test: 'Tests',
    chore: 'Chores',
    other: 'Other Changes',
  };

  for (const key of ordered) {
    const items = sections[key];
    if (items.length === 0) continue;
    lines.push(`## ${labels[key]}\n`);
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}**: ` : '';
      lines.push(`- **${c.hash.slice(0, 7)}** ${scope}${c.message}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
