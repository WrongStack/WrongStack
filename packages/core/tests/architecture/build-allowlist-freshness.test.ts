import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WS-072 / DEP-005 — `allowBuilds` and `onlyBuiltDependencies` must not
 * pre-authorise install lifecycle scripts for packages that are not in the
 * tree.
 *
 * pnpm refuses to run a dependency's install scripts unless it is named in
 * these lists. That refusal is the review gate: adding an entry is the moment
 * someone is supposed to ask what the script does. An entry for an ABSENT
 * package spends that gate in advance — whenever the package next appears, for
 * any reason and via any transitive path, its scripts run with no review at
 * all. `better-sqlite3` sat in both lists while appearing nowhere in the
 * lockfile (the codebase uses `node:sqlite`), which is how this was found.
 *
 * The fix that matters is not the removal — it is this check, because the same
 * staleness accrues silently every time a native dependency is dropped.
 *
 * Deliberately checks the LOCKFILE, not `package.json`: these lists apply to
 * transitive dependencies too, so a package can legitimately need an entry
 * without any workspace member declaring it.
 */
const repoRoot = resolve(import.meta.dirname, '../../../..');
const workspaceYaml = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
const lockfile = readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8');

/** Strip YAML quoting from a scalar. */
function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

/**
 * Entries of a top-level block, handling both shapes in use: `allowBuilds` is
 * a map (`name: true`), `onlyBuiltDependencies` is a sequence (`- name`).
 * Comment and blank lines are skipped; the block ends at the next line that
 * starts in column 0.
 */
function blockEntries(key: string): string[] {
  const lines = workspaceYaml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  expect(start, `${key} block must exist`).toBeGreaterThan(-1);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length > 0 && !/^\s/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const seq = /^-\s*(.+)$/.exec(trimmed);
    if (seq?.[1] !== undefined) {
      out.push(unquote(seq[1].trim()));
      continue;
    }
    const map = /^(.+?):\s*\S/.exec(trimmed);
    if (map?.[1] !== undefined) out.push(unquote(map[1].trim()));
  }
  return out;
}

/** Whether the lockfile resolves this package at any version, at any depth. */
function inLockfile(name: string): boolean {
  // pnpm lockfile keys are `/name@version` or `name@version:` depending on the
  // section and version; match the name followed by `@`, anchored so `esbuild`
  // does not match `esbuild-wasm`.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[/\\s'"])${escaped}@`, 'm').test(lockfile);
}

/**
 * The installed `package.json` for a dependency, wherever pnpm put it.
 *
 * A DIRECT dependency is hoisted to `node_modules/<name>`, but a transitive
 * one — `electron-winstaller`, which arrives under `electron-builder` — only
 * ever exists inside the content-addressed store at
 * `node_modules/.pnpm/<name>@<version>[_<peerhash>]/node_modules/<name>`.
 * Looking only at the top level reported every transitive entry as "not
 * installed", which is the opposite of the truth and would have pushed a
 * maintainer to delete a genuinely required authorisation.
 *
 * Scoped names are stored with `/` replaced by `+` in the store directory
 * name (`@scope/pkg` -> `@scope+pkg@1.0.0`) but keep the real nested path.
 */
function resolveInstalledPackage(name: string): string | null {
  const direct = resolve(repoRoot, 'node_modules', name, 'package.json');
  if (existsSync(direct)) return direct;

  const store = resolve(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  const prefix = `${name.replace('/', '+')}@`;
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith(prefix)) continue;
    const nested = resolve(store, entry, 'node_modules', name, 'package.json');
    if (existsSync(nested)) return nested;
  }
  return null;
}

const PHRASE = 'allows lifecycle builds for';

describe('build-script allowlists stay in sync with the tree (WS-072)', () => {
  const allowBuilds = blockEntries('allowBuilds');
  const onlyBuilt = blockEntries('onlyBuiltDependencies');

  it('parses both blocks', () => {
    // Guards the parser itself: a silently-empty parse would make every
    // assertion below vacuously pass, which is exactly the failure mode this
    // test exists to prevent elsewhere.
    expect(allowBuilds.length).toBeGreaterThan(0);
    expect(onlyBuilt.length).toBeGreaterThan(0);
  });

  it('every allowBuilds entry is a package that actually exists', () => {
    expect(allowBuilds.filter((name) => !inLockfile(name))).toEqual([]);
  });

  it('every onlyBuiltDependencies entry is a package that actually exists', () => {
    expect(onlyBuilt.filter((name) => !inLockfile(name))).toEqual([]);
  });

  // I4 (SC-SUPPLY-003 / Phase 3 S4 bonus): a stronger version of the
  // staleness check — a name in `allowBuilds` / `onlyBuiltDependencies`
  // must not only exist in the tree, it must also actually declare
  // an install lifecycle script. The previous reviewer-gate-spends-
  // in-advance shape was: an entry for a package with NO install
  // script authorises nothing today, but the moment the package gains
  // a `postinstall` (via npm-publish, a transitive update, anything)
  // the gate fires silently. The fix is the test below: every entry
  // must point to a `package.json` that already declares
  // `preinstall` / `install` / `postinstall` / `prepare` — and a
  // missing node_modules is also flagged, since "package exists in
  // the lockfile but is not installed" is the same shape.
  it('every allowBuilds entry resolves to a package.json that declares an install script', () => {
    const missing: string[] = [];
    const deadEntries: string[] = [];
    for (const name of allowBuilds) {
      const pkgPath = resolveInstalledPackage(name);
      if (!pkgPath) {
        missing.push(name);
        continue;
      }
      let pkg: { scripts?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      } catch {
        missing.push(name);
        continue;
      }
      const scripts = pkg.scripts ?? {};
      const hasInstall = ['preinstall', 'install', 'postinstall', 'prepare'].some(
        (k) => typeof scripts[k] === 'string' && scripts[k]!.length > 0,
      );
      if (!hasInstall) deadEntries.push(name);
    }
    expect(missing, 'allowBuilds entries that are not installed in node_modules').toEqual([]);
    expect(
      deadEntries,
      'allowBuilds entries whose package.json declares no install lifecycle script — ' +
        'these spend the review gate in advance. Remove from pnpm-workspace.yaml ' +
        'and re-add when (and only when) the package gains a real script.',
    ).toEqual([]);
  });

  it('the removed better-sqlite3 authorisation has not crept back', () => {
    // Named explicitly so a re-add has to be a deliberate act with a reason,
    // rather than a copy-paste that quietly re-opens the gate. If the project
    // genuinely adopts better-sqlite3, delete this case along with the
    // SECURITY.md list entry — the two generic checks above then cover it.
    expect(workspaceYaml).not.toContain('better-sqlite3');
  });

  it('SECURITY.md lists exactly the packages authorised to run build scripts', () => {
    // SECURITY.md enumerates the allowlist as a security claim. Letting the two
    // drift means the documented posture stops describing the real one.
    const securityMd = readFileSync(resolve(repoRoot, 'SECURITY.md'), 'utf8');
    const claim = securityMd
      .split(/\r?\n/)
      .find((line) => line.includes('allows lifecycle builds for'));
    expect(claim, 'SECURITY.md must state which packages may run build scripts').toBeDefined();

    // Both directions. Containment alone let the claim name FIVE packages that
    // were no longer authorised (`@biomejs/biome`, `electron`,
    // `onnxruntime-node`, `protobufjs`, `sharp`) while still passing, because
    // a superset contains every real entry. An over-broad claim is the more
    // dangerous drift of the two: it documents a wider install-script
    // authorisation than the repo actually grants. So the sentence is parsed
    // as a set and compared for equality.
    //
    // Only the leading clause is the list; the prose after the first sentence
    // explains individual entries and legitimately names other packages.
    const listClause = claim!.slice(claim!.indexOf(PHRASE) + PHRASE.length).split('.')[0] ?? '';
    const claimed = [...listClause.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).sort();
    expect(claimed, 'the packages SECURITY.md claims may run build scripts').toEqual(
      [...onlyBuilt].sort(),
    );
    expect(claim).not.toContain('better-sqlite3');
  });
});

/**
 * VF-31 (security report Phase 4): CI installs with `--ignore-scripts` and
 * rebuilds an explicit, workflow-pinned list of native dependencies, so a
 * fork PR cannot widen its own allowlist via pnpm-workspace.yaml. The same
 * package set now lives in three places, and drift in any of them is silent
 * without this check:
 *
 *   1. `pnpm-workspace.yaml` `allowBuilds` — the LOCAL-DEV source of truth
 *   2. `.github/workflows/ci.yml` — every job's `pnpm rebuild <list>` step
 *   3. `.github/workflows/release.yml` — the `pack` job's rebuild step
 *
 * Adding to the workspace file without the workflows means CI silently lacks
 * the native binary; adding to a workflow without the workspace file means
 * local dev and CI disagree about what lifecycle code runs. Both fail here.
 */
describe('build-allowlist freshness across workflows (VF-31)', () => {
  const workspace = new Set(blockEntries('allowBuilds'));

  /**
   * Extract every `pnpm rebuild <list>` package set from a workflow or script.
   *
   * Comment lines are skipped. Both `#` (YAML, sh, PowerShell) and `//` count,
   * because a comment that merely NAMES the command — "keep this in step with
   * the rebuild in ci.yml" — would otherwise be parsed as a package list and
   * fail the comparison with prose.
   */
  function workflowRebuildLists(relPath: string): Array<{ where: string; pkgs: Set<string> }> {
    const lines = readFileSync(resolve(repoRoot, relPath), 'utf8').split('\n');
    const lists: Array<{ where: string; pkgs: Set<string> }> = [];
    lines.forEach((line, i) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) return;
      const m = line.match(/pnpm rebuild\s+([^\n#]+)/);
      if (!m || !m[1]) return;
      lists.push({ where: `${relPath}:${i + 1}`, pkgs: new Set(m[1].trim().split(/\s+/)) });
    });
    return lists;
  }

  // dev.sh / dev.ps1 joined this set on 2026-09-10, when they were switched to
  // `--ignore-scripts` + an explicit rebuild to match CI. That took the number
  // of places holding this list from three to five — which is precisely the
  // drift this block exists to catch, so they are scanned here too.
  const lists = [
    ...workflowRebuildLists('.github/workflows/ci.yml'),
    ...workflowRebuildLists('.github/workflows/release.yml'),
    ...workflowRebuildLists('dev.sh'),
    ...workflowRebuildLists('dev.ps1'),
  ];

  it('the workflow files actually contain rebuild lists to compare', () => {
    // 10 CI install jobs + the release pack job. Guards the parser: an
    // empty result would make the suite below vacuously green.
    expect(lists.length).toBeGreaterThanOrEqual(13);
  });

  it.each(lists.map((l) => [l.where, l] as const))(
    'rebuild list at %s matches pnpm-workspace.yaml allowBuilds',
    (_where, list) => {
      expect([...list.pkgs].sort()).toEqual([...workspace].sort());
    },
  );
});

/**
 * WS-SEC-17 follow-up: `minimumReleaseAgeExclude` entries must not outlive the
 * version they were written for.
 *
 * `minimumReleaseAge: 1440` is, in this repo's own words, "the single most
 * effective defence against a compromised-maintainer / npm account takeover".
 * Every entry in the exclude list is a standing hole in it. The hole is
 * acceptable while it is doing a job — someone needed a just-published version
 * and accepted the risk once, in review. It stops being acceptable the moment
 * the lockfile moves on: the entry then authorises nothing anyone needs, and
 * sits there waiting for that exact version string to reappear, at which point
 * the cooldown is skipped with no review at all.
 *
 * This is the same shape as the `allowBuilds` staleness above — a review gate
 * spent in advance — and it had the same outcome: three of five entries were
 * already stale when this test was written (`electron@43.0.0` while the
 * lockfile had 43.6.0, `ai@7.0.73` -> 7.0.77, `@ai-sdk/gateway@4.0.59` ->
 * 4.0.62). Unlike `allowBuilds`, nothing was pinning this list.
 */
describe('cooldown exclusions stay in sync with the tree (WS-SEC-17)', () => {
  const excludes = blockEntries('minimumReleaseAgeExclude');

  /**
   * Every version the lockfile resolves for a package name.
   *
   * Scoped names are single-quoted in the lockfile (`'@ai-sdk/gateway@4.0.62':`)
   * and unscoped ones are not. An unquoted-only pattern reports every scoped
   * entry as absent — which, when this was first measured by hand, under-counted
   * the stale entries and would have understated the finding.
   */
  function lockfileVersions(name: string): string[] {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^  '?${escaped}@([^:']+)'?:`, 'gm');
    const out = new Set<string>();
    for (const m of lockfile.matchAll(re)) {
      // Strip pnpm's peer-suffix: `4.0.62(zod@4.4.3)` is still 4.0.62.
      out.add((m[1] as string).split('(')[0] as string);
    }
    return [...out].sort();
  }

  it('parses the exclude block', () => {
    // Same vacuity guard as the blocks above: an empty parse would make the
    // assertion below pass while checking nothing.
    expect(excludes.length).toBeGreaterThan(0);
    expect(excludes.every((e) => e.lastIndexOf('@') > 0)).toBe(true);
  });

  it('every exclusion names a version the lockfile actually resolves', () => {
    const stale: string[] = [];
    for (const entry of excludes) {
      const at = entry.lastIndexOf('@');
      const name = entry.slice(0, at);
      const version = entry.slice(at + 1);
      const resolved = lockfileVersions(name);
      if (resolved.length === 0) {
        stale.push(`${entry} (package absent from the lockfile)`);
        continue;
      }
      if (!resolved.includes(version)) {
        stale.push(`${entry} (lockfile has ${resolved.join(', ')})`);
      }
    }

    expect(
      stale,
      'Stale cooldown exclusions: each one skips the 24h publish delay for a version ' +
        'nothing in the tree uses. Delete them from pnpm-workspace.yaml — and re-add ' +
        'only when a new version genuinely needs the exception, which is the moment ' +
        'someone is supposed to weigh the risk.',
    ).toEqual([]);
  });
});
