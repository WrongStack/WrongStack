import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const SYNC_IO = /\b(?:execFileSync|spawnSync|readFileSync|statSync|existsSync)\b/;
const SYNC_PROCESS = /\b(?:execSync|execFileSync|spawnSync)\b/;

const HOT_PATHS = [
  'packages/webui-server/src/server/goal-ws-handler.ts',
  'packages/webui-server/src/server/sdd-wizard-wiring.ts',
  'packages/webui-server/src/server/codebase-indexing.ts',
  'packages/cli/src/slash-commands/suggest.ts',
  'packages/core/src/coordination/single-instance-mailbox.ts',
  'packages/plugins/src/accessibility-auditor/index.ts',
  'packages/plugins/src/code-metrics/index.ts',
  'packages/plugins/src/duplicate-code-detector/index.ts',
  'packages/plugins/src/feature-flag-tracker/index.ts',
  'packages/plugins/src/interface-contract-guard/index.ts',
  'packages/plugins/src/refactor-suggester/index.ts',
  'packages/plugins/src/security-hotspot-scanner/index.ts',
  'packages/plugins/src/semver-bump/index.ts',
  'packages/plugins/src/checkpoint/index.ts',
  'packages/plugins/src/template-engine/index.ts',
  'packages/techstack/src/adapters/python.ts',
  'packages/techstack/src/adapters/npm.ts',
  'packages/techstack/src/adapters/dotnet.ts',
  'packages/techstack/src/adapters/gradle.ts',
] as const;

const PROCESS_HOT_PATHS = [
  'packages/techstack/src/advisory/native-audit.ts',
  'packages/plugins/src/dependency-vulnerability-gate/index.ts',
  'packages/plugins/src/test-flake-detector/index.ts',
  'packages/plugins/src/api-compatibility-gate/index.ts',
  'packages/plugins/src/diff-summary/index.ts',
  'packages/plugins/src/pr-drafter/index.ts',
  'packages/plugins/src/release-notes-generator/index.ts',
  'packages/plugins/src/semver-bump/index.ts',
  'packages/tools/src/codebase-index/rs-parser.ts',
  'packages/tools/src/codebase-index/py-parser.ts',
  'packages/cli/src/simpleui-dist.ts',
  'packages/cli/src/webui-server/static-serve.ts',
  'packages/bench/src/runner.ts',
] as const;

describe('non-blocking I/O hot-path guardrails', () => {
  it.each(HOT_PATHS)('%s does not use synchronous filesystem/process APIs', async (file) => {
    const source = await fs.readFile(path.resolve(REPO_ROOT, file), 'utf8');
    expect(source).not.toMatch(SYNC_IO);
  });

  it.each(PROCESS_HOT_PATHS)('%s does not use synchronous process APIs', async (file) => {
    const source = await fs.readFile(path.resolve(REPO_ROOT, file), 'utf8');
    expect(source).not.toMatch(SYNC_PROCESS);
  });

  it('keeps the HQ request handler asynchronous', async () => {
    const source = await fs.readFile(
      path.resolve(REPO_ROOT, 'packages/cli/src/hq-static-serve.ts'),
      'utf8',
    );
    const handler = source.slice(source.indexOf('export async function serveHqStatic'));

    expect(handler).not.toMatch(SYNC_IO);
  });
});
