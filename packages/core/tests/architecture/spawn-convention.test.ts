/**
 * Every child process this repo spawns follows one Windows convention, and the
 * convention lives in eleven files.
 *
 * The rule: a spawn that passes `detached` must also pass `windowsHide: true`.
 * On win32 the two flags interact — `bash.ts` documents the case that forced
 * the rule, where `DETACHED_PROCESS` (`detached: true`) makes CreateProcess
 * ignore `CREATE_NO_WINDOW` and the child's console grandchildren each pop a
 * visible window. The daemon spawns tolerate `detached: true` because their
 * children spawn nothing console-bearing; every one of them still sets
 * `windowsHide`, because the cost of setting it is zero and the cost of
 * discovering you needed it is a user staring at stray console windows.
 *
 * `boot/tui-project-spawn.ts` was the one site outside the convention: it
 * passed `detached: true` with no `windowsHide` and never `unref`'d the child.
 * It is the project-switch path — the most user-visible spawn in the CLI.
 *
 * A shared helper is not available here. `@wrongstack/kanban` sits BELOW core
 * in the workspace DAG (`package-boundaries.test.ts`) and cannot import a core
 * utility, so the convention cannot be centralised in code. A test is the only
 * place it can be centralised at all.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** How far from a `detached:` line the paired flag may sit. */
const PROXIMITY_LINES = 15;

/**
 * Spawns that legitimately omit `windowsHide`, with the reason.
 * Adding an entry is a decision; anything else is drift.
 */
const WINDOWS_HIDE_EXEMPT: Record<string, string> = {};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function packageSources(): string[] {
  const out: string[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = path.join(PACKAGES, pkg, 'src');
    try {
      if (statSync(src).isDirectory()) sourceFiles(src, out);
    } catch {
      // package without a src/ dir
    }
  }
  return out;
}

interface DetachedSite {
  readonly rel: string;
  readonly line: number;
  readonly hasWindowsHide: boolean;
}

function detachedSites(): DetachedSite[] {
  const sites: DetachedSite[] = [];
  for (const file of packageSources()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? '';
      // Option assignment only — skip comments, type declarations, and reads.
      if (!/^\s*detached:\s*\S/.test(text)) continue;
      // `detached: false` keeps the child on the parent's console; there is no
      // second window for `windowsHide` to suppress. (Whether every NON-
      // detached spawn that also redirects stdio should set the flag is a
      // wider sweep than this convention — those sites pop a console only when
      // they neither inherit nor detach.)
      if (/^\s*detached:\s*false/.test(text)) continue;
      const from = Math.max(0, i - PROXIMITY_LINES);
      const to = Math.min(lines.length, i + PROXIMITY_LINES + 1);
      const window = lines.slice(from, to).join('\n');
      sites.push({
        rel: path.relative(PACKAGES, file).split(path.sep).join('/'),
        line: i + 1,
        hasWindowsHide: /windowsHide:\s*true/.test(window),
      });
    }
  }
  return sites;
}

describe('Windows spawn convention', () => {
  const sites = detachedSites();

  it('finds the spawn sites it is meant to police', () => {
    // Guards every case below: an empty scan would pass vacuously.
    expect(sites.length).toBeGreaterThan(8);
  });

  it('every spawn that sets detached also sets windowsHide', () => {
    const missing = sites
      .filter((s) => !s.hasWindowsHide)
      .filter((s) => !Object.keys(WINDOWS_HIDE_EXEMPT).some((k) => s.rel.endsWith(k)))
      .map((s) => `${s.rel}:${s.line}`);
    expect(
      missing,
      `these pass detached without windowsHide: true — ${missing.join(', ')}. ` +
        `On win32 a detached console child (or its grandchildren) pops a visible ` +
        `window. Add the flag, or add the file to WINDOWS_HIDE_EXEMPT with a reason.`,
    ).toEqual([]);
  });

  it('the exemption list has no stale entries', () => {
    for (const [rel, reason] of Object.entries(WINDOWS_HIDE_EXEMPT)) {
      expect(reason.length, `${rel} needs a stated reason`).toBeGreaterThan(10);
      const matched = sites.filter((s) => s.rel.endsWith(rel));
      expect(matched.length, `${rel} no longer spawns detached — drop the entry`).toBeGreaterThan(
        0,
      );
      expect(
        matched.some((s) => !s.hasWindowsHide),
        `${rel} now sets windowsHide everywhere — drop it from WINDOWS_HIDE_EXEMPT`,
      ).toBe(true);
    }
  });
});
