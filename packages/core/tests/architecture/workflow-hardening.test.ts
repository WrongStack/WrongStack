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

const repoRoot = resolve(import.meta.dirname, '../../../..');
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
    for (const file of workflowFiles()) {
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
    expect(text).toMatch(/tags:\s*\['v\*\.\*\.\*'\]/);
    // A branch push must never be able to publish.
    expect(text).not.toMatch(/^\s*branches:\s*\[main\]/m);
  });

  it('gates the publish job behind an environment with required reviewers', () => {
    // The environment is what makes a tag push a *request* to publish. Without
    // it, anyone who can push a tag can ship to npm.
    expect(release()).toMatch(/environment:\s*npm-publish/);
  });

  it('gives the npm publish job OIDC and no repository write access', () => {
    const text = release();
    const publishJob = text.slice(text.indexOf('  publish:'), text.indexOf('  portable-windows:'));
    expect(publishJob).toMatch(/id-token:\s*write/);
    // npm trusted publishing needs OIDC only. Repository write access belongs
    // exclusively to the separate job that attaches the portable executable
    // to the GitHub release.
    expect(publishJob).not.toMatch(/contents:\s*write/);
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

  it('allows it only on the CI path, where a tag checkout is a detached HEAD', () => {
    // Here the check cannot pass by construction, and what it guarded is
    // replaced more strictly by the workflow's verify job.
    expect(scripts()['release:ci']).toContain('--no-git-checks');
  });

  it('runs the full gate before a local publish', () => {
    expect(scripts()['release']).toContain('release:check');
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
    expect(runner).toContain("'pnpm check:architecture'");
    expect(runner).not.toContain('check:architecture:sync');
    expect(architectureCheck).toBeDefined();
    expect(architectureCheck).not.toContain('--write');
    expect(architectureCheck).not.toContain('--report-only');
  });

  it('refreshes Core API evidence before committing staged source changes', () => {
    const hook = readFileSync(join(repoRoot, '.githooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('node scripts/sync-core-public-api-snapshot.mjs');
  });

  it('does not gate git push; ci:local stays an explicit command', () => {
    // Pre-push gating was removed (2026-08): pushes are not gated locally.
    // The same matrix stays available on demand via `pnpm ci:local`.
    expect(existsSync(join(repoRoot, '.githooks', 'pre-push'))).toBe(false);
    expect(scripts()['ci:local']).toBe('node scripts/release-check-matrix.mjs --profile local');
  });

  it('keeps coverage and e2e out of the laptop local profile', () => {
    const runner = readFileSync(join(repoRoot, 'scripts', 'release-check-matrix.mjs'), 'utf8');
    expect(runner).toContain("profile === 'local' ? 'local CI' : 'release:check'");
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
});
