import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const executableScripts = [
  'scripts/acp-smoke-test.mts',
  'scripts/analyze-cpuprofile.mjs',
  'scripts/bench.mjs',
  'scripts/brain-workload-report.mjs',
  'scripts/build-package.mjs',
  'scripts/build.mjs',
  'scripts/bump-version.mjs',
  'scripts/check-architecture-health.mjs',
  'scripts/check-browser-runtime.mjs',
  'scripts/check-build-lineage.mjs',
  'scripts/check-dep-path-separators.mjs',
  'scripts/check-file-size.mjs',
  'scripts/check-i18n-completeness.mjs',
  'scripts/check-node-pty.mjs',
  'scripts/check-package-contracts.mjs',
  'scripts/check-test-inventory.mjs',
  'scripts/check-test-skips.mjs',
  'scripts/check-test-typecheck.mjs',
  'scripts/coverage-lock.mjs',
  'scripts/coverage-matrix.mjs',
  'scripts/coverage-tmp-guard.mjs',
  'scripts/generate-plugin-projections.mjs',
  'scripts/generate-provider-catalog.mjs',
  'scripts/guard-against-corruption.mjs',
  'scripts/guard-mailbox-bridge-scripts.mjs',
  'scripts/guard-mailbox-bridge.mjs',
  'scripts/guard-unresolved-imports.mjs',
  'scripts/lib/architecture-health.mjs',
  'scripts/lib/publishable-packages.mjs',
  'scripts/lib/build-output-cleanup.mjs',
  'scripts/lib/build-lineage.mjs',
  'scripts/lib/test-inventory.mjs',
  'scripts/lib/test-skip-budget.mjs',
  'scripts/lint-console-logging.mjs',
  'scripts/lint-distributive-types.mjs',
  'scripts/list-publishable-packages.mjs',
  'scripts/perf-chronicle-append.mts',
  'scripts/perf-guard.mjs',
  'scripts/publish-workspace.mjs',
  'scripts/purge-stale-mailbox-entries.mjs',
  'scripts/sage-maintenance.mjs',
  'scripts/snapshot-core-public-api.mjs',
  'scripts/sync-core-public-api-snapshot.mjs',
  'scripts/sync-models.mjs',
  'scripts/run-vitest-coverage.mjs',
  'scripts/test-coverage.mjs',
  'scripts/tui-heap-soak.mjs',
] as const;

describe('executable script inventory', () => {
  it.each(executableScripts)('%s has valid module syntax', (relativePath) => {
    const result = spawnSync(process.execPath, ['--check', resolve(repoRoot, relativePath)], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${relativePath}\n${result.stderr}`).toBe(0);
  });

  it.each([
    ['scripts/build.mjs', ['--invalid'], 1, 'Unknown build option'],
    ['scripts/check-browser-runtime.mjs', ['--help'], 0, 'Usage:'],
    ['scripts/sage-maintenance.mjs', ['--help'], 0, 'USAGE'],
    ['scripts/tui-heap-soak.mjs', ['--help'], 0, 'Usage:'],
    ['scripts/analyze-cpuprofile.mjs', ['--help'], 0, 'Usage:'],
    ['scripts/analyze-cpuprofile.mjs', ['--bogus'], 2, 'Unknown argument'],
    ['scripts/analyze-cpuprofile.mjs', [], 2, 'required'],
    ['scripts/check-build-lineage.mjs', [], 2, 'Usage:'],
    ['scripts/check-file-size.mjs', ['--cap', 'invalid'], 2, 'Invalid'],
    ['scripts/check-test-typecheck.mjs', ['--invalid'], 2, 'Unknown argument'],
    ['scripts/publish-workspace.mjs', ['--help'], 0, 'Usage:'],
    ['scripts/publish-workspace.mjs', ['--invalid'], 2, 'Unknown argument'],
    ['scripts/publish-workspace.mjs', ['--verify-timeout', 'abc'], 2, 'Invalid value'],
    ['scripts/check-architecture-health.mjs', ['--invalid'], 2, 'Unknown argument'],
    ['scripts/check-test-skips.mjs', ['--invalid'], 2, 'Usage:'],
    ['scripts/sync-core-public-api-snapshot.mjs', ['--invalid'], 1, 'does not accept arguments'],
    ['scripts/sync-core-public-api-snapshot.mjs', ['--help'], 0, 'Usage:'],
  ] as const)(
    '%s exposes a deterministic safe CLI contract',
    (relativePath, args, expectedStatus, expectedText) => {
      const result = spawnSync(process.execPath, [resolve(repoRoot, relativePath), ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, NO_COLOR: '1' },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(expectedStatus);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedText);
    },
  );
});
