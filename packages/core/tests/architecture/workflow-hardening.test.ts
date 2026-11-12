/**
 * Ratchet for the CI/CD supply-chain controls.
 *
 * WS-040 (release publishing), WS-041 (SHA-pinned actions) and WS-042
 * (`persist-credentials: false`) were all fixed by editing YAML — and nothing
 * stopped the next edit from undoing them. A workflow file is the one place in
 * the repo where a one-line change hands a third party the ability to run code
 * with the repository's credentials, so these properties need a test rather
 * than a memory.
 *
 * The assertions are deliberately textual. Adding a YAML parser dependency to
 * assert on two files is a worse trade than matching the exact strings the
 * controls consist of, and a textual match fails loudly on reformatting rather
 * than silently accepting a restructured file.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceMemberDirs } from '../../../../scripts/lib/publishable-packages.mjs';

const repoRoot = resolve(import.meta.dirname, '../../../..');
/** The deleted npm publish driver; spelled by parts so repo greps for it stay empty. */
const RETIRED_PUBLISHER = ['publish', 'workspace'].join('-');
const workflowDir = join(repoRoot, '.github', 'workflows');

function workflowFiles(): string[] {
  return readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

function read(name: string): string {
  return readFileSync(join(workflowDir, name), 'utf8');
}

/**
 * Drop whole-line `#` comments.
 *
 * The "must not appear" assertions below are about what the workflow
 * CONFIGURES, not what it discusses. release.yml explains at length why it
 * avoids `registry-url` and a long-lived token, and a raw-text match cannot
 * tell that explanation apart from a real usage — it would force the file to
 * stay silent about its own reasoning to keep the test green.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('every workflow (WS-041 / WS-042)', () => {
  it('pins third-party actions to a commit SHA, never a mutable tag', () => {
    // A tag is a pointer the upstream owner can move after review. `uses:` with
    // `@v4` means "whatever that owner publishes next runs in our CI".
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      for (const [i, line] of read(file).split('\n').entries()) {
        const match = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
        if (!match) continue;
        const ref = match[1]!;
        // Local composite actions (./.github/...) have no upstream to pin.
        if (ref.startsWith('./')) continue;
        const after = ref.split('@')[1] ?? '';
        if (!/^[0-9a-f]{40}$/.test(after)) offenders.push(`${file}:${i + 1} ${ref}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never leaves GITHUB_TOKEN in .git/config for postinstall scripts to read', () => {
    // Workspace postinstall scripts run in these jobs. Without this, any of
    // them can read the token out of the checkout's git config.
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const text = read(file);
      const checkouts = text.split(/uses:\s*actions\/checkout/).slice(1);
      for (const [i, block] of checkouts.entries()) {
        // Look only at the `with:` block that follows this checkout — stop at
        // the next step boundary.
        const upToNextStep = block.split(/\n\s*-\s+(?:uses|name):/)[0] ?? '';
        if (!upToNextStep.includes('persist-credentials: false')) {
          offenders.push(`${file} checkout #${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares an explicit top-level permissions block', () => {
    // Absent this, the job inherits the repository default, which may be
    // write-all.
    const files = workflowFiles();
    // If the glob ever stops matching, "every workflow declares permissions"
    // becomes vacuously true and the guard reports green while protecting
    // nothing — the failure mode a security check can least afford.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(read(file), file).toMatch(/^permissions:/m);
    }
  });
});

describe('release workflow (WS-040)', () => {
  const release = () => read('release.yml');

  it('exists — publishing must not be a laptop-only procedure', () => {
    expect(workflowFiles()).toContain('release.yml');
  });

  it('is tag-triggered, not push-to-branch', () => {
    const text = release();
    expect(text).toMatch(/tags:\s*\[\s*(['"])v\*\.\*\.\*\1\s*\]/);
    // A branch push must never be able to publish.
    expect(text).not.toMatch(/^\s*branches:\s*\[main\]/m);
  });

  it('neither publishes to nor reads from npm — GitHub Releases are the only channel', () => {
    // npm publishing is retired for good: every workspace package is
    // `"private": true` and there is no publish script. A tag push must not be
    // able to ship to the registry, and no job checks the registry any more.
    const text = withoutComments(release());
    expect(text).not.toMatch(/^ {2}(?:pack|publish):$/m);
    expect(text).not.toContain('npm-publish');
    expect(text).not.toContain(`  ${['npm', 'verify'].join('-')}:`);
    expect(text).not.toContain('--tarballs-dir');
    expect(text).not.toContain(RETIRED_PUBLISHER);
    expect(text).not.toMatch(/\b(?:npm|bun|pnpm) publish\b/);
  });

  it('does NOT set registry-url on setup-node', () => {
    // setup-node's registry-url writes `_authToken=${NODE_AUTH_TOKEN}`
    // unconditionally; with no token set, pnpm sends the literal unexpanded
    // placeholder as a bearer token and the OIDC exchange never happens. This
    // fails as a confusing 404, so it is worth pinning explicitly.
    expect(withoutComments(release())).not.toMatch(/registry-url/);
  });

  it('does not carry a long-lived npm token', () => {
    const text = withoutComments(release());
    expect(text).not.toMatch(/NPM_TOKEN/);
    expect(text).not.toMatch(/NODE_AUTH_TOKEN/);
  });

  it('never cancels a run that may be mid-publish', () => {
    // A cancelled multi-package publish leaves the workspace half-shipped.
    expect(release()).toMatch(/cancel-in-progress:\s*false/);
  });

  it('verifies downloaded standalone binaries before attaching them to a release', () => {
    const text = release();
    const releaseStart = text.indexOf('  github-release:');
    const githubReleaseJob = text.slice(releaseStart);

    const coverageCheck = githubReleaseJob.indexOf(
      'diff -u "$RUNNER_TEMP/release-binary-assets" "$RUNNER_TEMP/checksummed-binary-assets"',
    );
    // Run from dist-bin, not the workspace root: SHA256SUMS lists bare
    // filenames, so `sha256sum --check dist-bin/SHA256SUMS` resolved every
    // entry against the wrong directory and failed the job before it ever
    // created the release. Anchoring on the `cd` keeps that from coming back.
    const checksumCheck = githubReleaseJob.indexOf('(cd dist-bin && sha256sum --check SHA256SUMS)');
    const upload = githubReleaseJob.indexOf('gh release upload');

    // The manifest must cover EVERY published asset, not just the binaries:
    // the installers are uploaded from the same directory and are now
    // checksummed alongside them (binaries.yml appends their digests), so the
    // comparison set has to name them too or the two silently drift apart.
    expect(githubReleaseJob).toContain('find dist-bin -maxdepth 1 -type f');
    expect(githubReleaseJob).toContain("-name 'wstack-*'");
    expect(githubReleaseJob).toContain("-name 'install.sh'");
    expect(githubReleaseJob).toContain("-name 'install.ps1'");
    expect(githubReleaseJob).toContain("awk 'NF == 2");
    expect(coverageCheck).toBeGreaterThan(-1);
    expect(coverageCheck).toBeLessThan(checksumCheck);
    expect(checksumCheck).toBeLessThan(upload);
  });

  it('checksums the installers it publishes and attests what it built', () => {
    const binaries = read('binaries.yml');

    // The release gate refuses to upload an asset the manifest does not name,
    // so these two halves have to move together: binaries.yml puts the
    // installer digests IN the manifest, release.yml checks the whole set.
    expect(binaries).toContain('sha256sum install.sh install.ps1 >> SHA256SUMS');
    expect(binaries).toContain('(cd dist-bin && sha256sum --check SHA256SUMS)');

    // Provenance: the standalone executables -- the only distribution -- had
    // only a checksum file fetched from the same release as the binary. The
    // attestation has to be minted in the job that BUILT them, which is why
    // the permissions live here and on release.yml's call site (a called
    // workflow's permissions are capped by the caller's).
    expect(binaries).toContain('actions/attest-build-provenance@');
    expect(binaries).toContain('id-token: write');
    expect(binaries).toContain('attestations: write');

    const callSite = release().slice(release().indexOf('  binaries:'));
    expect(callSite).toContain('id-token: write');
    expect(callSite).toContain('attestations: write');
  });

  it('resolves draft and published releases before uploading standalone assets', () => {
    const text = withoutComments(release());
    expect(text).not.toContain('/releases/tags/$RELEASE_TAG');
    const lookup = `--json apiUrl --jq '.apiUrl | split("/") | last'`;
    expect(text.split(lookup)).toHaveLength(2);
  });

  it('keeps the operator runbook on the tag-first automated release path', () => {
    const runbook = readFileSync(join(repoRoot, 'docs', 'release.md'), 'utf8');

    expect(runbook).toContain('git push origin v<version>');
    expect(runbook).toContain('all eight `wstack-*` targets');
    expect(runbook).not.toContain('DESKTOP-SHA256SUMS');
    expect(runbook).not.toContain('no checked-in release workflow currently does this');
    expect(runbook).not.toContain('Test install: `npm install -g wrongstack');
  });
});

describe('release scripts (WS-040)', () => {
  const scripts = (): Record<string, string> =>
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;

  it('keeps --no-git-checks out of the LOCAL release path', () => {
    // On a laptop this flag removes pnpm's refusal to publish from a dirty
    // tree or the wrong branch, so the tarball need not match any commit.
    expect(scripts()['release']).toBeDefined();
    expect(scripts()['release']).not.toContain('--no-git-checks');
  });

  it('release is the gate alone — no npm publish path remains', () => {
    const all = scripts();
    expect(all['release']).toBe('bun run release:check');
    expect(all['release:fast']).toBe('bun scripts/release-check-matrix.mjs --profile release-fast');
    // Built by concatenation so a repo-wide grep for the retired names stays
    // empty outside the changelog.
    for (const removed of ['dry', 'ci', 'packages', 'plan', 'verify'].map((s) => `release:${s}`)) {
      expect(all[removed], removed).toBeUndefined();
    }
    for (const [name, command] of Object.entries(all)) {
      expect(command, name).not.toContain(RETIRED_PUBLISHER);
      expect(command, name).not.toMatch(/\b(?:npm|bun|pnpm) publish\b/);
    }
    // The root lifecycle hook refuses outright instead of running a guard.
    expect(all['prepublishOnly']).toContain('process.exit(1)');
    expect(all['prepublishOnly']).toContain('npm publishing is retired');
  });

  it('marks every workspace package private so no manual publish can reach npm', () => {
    const offenders = workspaceMemberDirs(repoRoot)
      .map((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
      .filter((manifest) => manifest.private !== true)
      .map((manifest) => manifest.name);
    expect(offenders).toEqual([]);
  });

  it('keeps architecture verification read-only in the release gate', () => {
    const releaseCheck = scripts()['release:check'];
    const architectureCheck = scripts()['check:architecture'];
    expect(releaseCheck).toBeDefined();
    // release:check delegates to the gate-matrix runner; the architecture
    // gate is defined there. Assert the delegation AND that the runner
    // wires the read-only variant — never the sync/--write maintenance one.
    expect(releaseCheck).toContain('release-check-matrix');
    const runner = readFileSync(join(repoRoot, 'scripts', 'release-check-matrix.mjs'), 'utf8');
    expect(runner).toContain("'bun run check:architecture'");
    expect(runner).not.toContain('check:architecture:sync');
    expect(architectureCheck).toBeDefined();
    expect(architectureCheck).not.toContain('--write');
    expect(architectureCheck).not.toContain('--report-only');
  });

  it('refreshes Core API evidence before committing staged source changes', () => {
    const hook = readFileSync(join(repoRoot, '.githooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('bun scripts/sync-core-public-api-snapshot.mjs');
  });

  it('does not gate git push; ci:local stays an explicit command', () => {
    // Pre-push gating was removed (2026-08): pushes are not gated locally.
    // The same matrix stays available on demand via `pnpm ci:local`.
    expect(existsSync(join(repoRoot, '.githooks', 'pre-push'))).toBe(false);
    expect(scripts()['ci:local']).toBe('bun scripts/release-check-matrix.mjs --profile local');
  });

  it('keeps coverage and e2e out of the laptop local profile', () => {
    const runner = readFileSync(join(repoRoot, 'scripts', 'release-check-matrix.mjs'), 'utf8');
    // `release-fast` is a third profile, so assert the local branch and the
    // remaining release title mapping independently instead of freezing the
    // old two-way conditional.
    expect(runner).toContain("profile === 'local' ? 'local CI'");
    expect(runner).toContain("profile === 'release-fast' ? 'release:fast' : 'release:check'");
    expect(runner).toContain('--profile');
    // The local id list is the source of truth for `pnpm ci:local`. It must
    // include the test suite GitHub CI runs, and must not silently grow a
    // 45-minute coverage gate onto every local run.
    const localBlock = runner.slice(runner.indexOf('local: [') + 'local: ['.length);
    const localIds = localBlock.slice(0, localBlock.indexOf('],'));
    expect(localIds).toContain("'lint'");
    expect(localIds).toContain("'typecheck'");
    expect(localIds).toContain("'test'");
    expect(localIds).toContain("'hqdash'");
    expect(localIds).toContain("'status-bar'");
    expect(localIds).not.toContain("'coverage'");
    expect(localIds).not.toContain("'audit'");
    expect(localIds).not.toContain('test:e2e');
  });

  it('uses the Bun command in active release-facing guidance', () => {
    const canonical = 'bun run release:check';
    const legacy = ['pnpm release', ':check'].join('');
    const releaseFacingFiles = [
      'docs/architecture.md',
      'docs/release-process.md',
      'docs/slash/dev.md',
      'packages/cli/src/slash-commands/dev.ts',
      'packages/sage/tests/retrieval-coverage.test.ts',
      'packages/webui/TESTING.md',
      'scripts/release-check-matrix.mjs',
      'scripts/test-affected.mjs',
      'scripts/vitest-affected-recorder.mjs',
    ];

    for (const file of releaseFacingFiles) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      expect(text, file).toContain(canonical);
      expect(text, file).not.toContain(legacy);
    }
  });
});

describe('website CI and Pages verification', () => {
  function jobBlock(text: string, name: string): string {
    const marker = `\n  ${name}:\n`;
    const start = text.indexOf(marker);
    expect(start, `workflow must contain the ${name} job`).toBeGreaterThan(-1);
    return text.slice(start + marker.length).split(/\n {2}[\w-]+:\n/)[0]!;
  }

  it('runs website compilation and tests in their existing CI jobs after workspace install', () => {
    const ci = withoutComments(read('ci.yml'));
    for (const [job, command] of [
      ['typecheck', 'bun run --filter wrongstack-website typecheck:tests'],
      ['test', 'bun run --filter wrongstack-website test'],
    ] as const) {
      const block = jobBlock(ci, job);
      const install = block.indexOf('run: bun install --frozen-lockfile --ignore-scripts');
      const check = block.indexOf(`run: ${command}`);
      expect(install).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(install);
    }
  });

  it('audits the website npm lockfile instead of re-auditing the root lockfile', () => {
    const audit = jobBlock(withoutComments(read('ci.yml')), 'audit');
    // The root dependency tree keeps the shared bun-based audit.
    expect(audit).toContain('run: bun scripts/audit-dependencies.mjs --audit-level=moderate');
    // website/ is a workspace member, so `bun audit` run there resolves the
    // WORKSPACE ROOT's bun.lock — the step then re-audited the root tree and
    // website/package-lock.json was never checked. The website step must
    // therefore run npm against website/'s own lockfile.
    expect(audit).toMatch(
      /- name: Audit website lockfile \(npm\)\n\s+working-directory: website\n\s+run: npm audit --audit-level=moderate --workspaces=false/,
    );
  });

  it('verifies Pages with workspace dependencies in a separate read-only job', () => {
    const verify = jobBlock(withoutComments(read('pages.yml')), 'website-checks');
    expect(verify).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(verify).not.toMatch(/(?:contents|pages|id-token):\s*write/);
    expect(verify).not.toMatch(/continue-on-error:|^ {4}if:/m);
    expect(verify).toContain('oven-sh/setup-bun@');
    const install = verify.indexOf('run: bun install --frozen-lockfile --ignore-scripts');
    const rebuild = verify.indexOf('run: bun run setup:native');
    const typecheck = verify.indexOf('run: bun run --filter wrongstack-website typecheck:tests');
    const tests = verify.indexOf('run: bun run --filter wrongstack-website test');
    expect(install).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(install);
    expect(typecheck).toBeGreaterThan(rebuild);
    expect(tests).toBeGreaterThan(typecheck);
    expect(verify).not.toContain('working-directory: website');
    expect(verify).not.toContain('npm ci');
  });

  it('blocks Pages build and deployment until verification succeeds', () => {
    const pages = withoutComments(read('pages.yml'));
    expect(jobBlock(pages, 'build')).toMatch(/^ {4}needs: website-checks$/m);
    const deploy = jobBlock(pages, 'deploy');
    expect(deploy).toMatch(/^ {4}needs: build$/m);
    expect(deploy).toContain('pages: write');
    expect(deploy).toContain('id-token: write');
    expect(deploy).toContain('name: github-pages');
  });

  it('preserves the standalone npm artifact build and deployment permission boundary', () => {
    const pages = withoutComments(read('pages.yml'));
    const build = jobBlock(pages, 'build');
    expect(build).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(build).not.toMatch(/(?:pages|id-token):\s*write/);
    expect(build).toContain('oven-sh/setup-bun@');
    expect(build).toMatch(
      /working-directory: website\n\s+run: bun install --frozen-lockfile --ignore-scripts/,
    );
    expect(build).toMatch(
      /working-directory: website\n\s+run: bun \.\.\/scripts\/audit-dependencies\.mjs --audit-level=moderate/,
    );
    expect(build).toMatch(/working-directory: website\n\s+run: bun run build/);
    expect(build).toContain('path: website/dist');
    expect(build).not.toContain('npm ci');
    expect(pages).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(pages).toContain('cancel-in-progress: false');
  });

  it('starts Pages only on manual dispatch', () => {
    const triggers = withoutComments(read('pages.yml')).split('\njobs:')[0]!;
    expect(triggers).toMatch(/^ {2}workflow_dispatch:/m);
    expect(triggers).not.toMatch(/^ {2}(?:push|pull_request|schedule):/m);
  });
});
