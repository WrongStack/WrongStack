/**
 * Every Agent-constructing host must wire the runaway safety net.
 *
 * An `Agent` is built in six places reached by different doors — the CLI/TUI
 * pipeline, the ACP agent, both subagent factories, and the WebUI backend's two
 * sites. Two guards decide whether a wedged run can ever end:
 *
 *   - `loopDetection` — the per-iteration repeat/cycle detector. A host that
 *     omits it hands the model an unpoliced loop.
 *   - `maxIterations`  — the turn budget. A host that ignores `tools.maxIterations`
 *     silently substitutes its own number, so the same setting means different
 *     things depending on which door the work came through.
 *
 * Both failures shipped. `tools.maxIterations` was read by the pipeline and the
 * WebUI backend and ignored by the ACP agent and both subagent factories, so an
 * operator's turn budget applied on the CLI and vanished in a subagent. This
 * test enumerates the hosts by walking the source — the same shape as the
 * kanban-governance parity test — so a seventh host cannot be added silently.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const PACKAGES = path.join(repositoryRoot, 'packages');

/** Every file that constructs a core `Agent`, as `<package>/<path>`. */
const HOSTS = [
  'cli/acp-server-agent.ts',
  'cli/fleet/host-subagent-factory.ts',
  'cli/wiring/pipeline.ts',
  'runtime/fleet/light-subagent-factory.ts',
  'webui-server/server/backend-services.ts',
  'webui-server/server/session-agent-registry.ts',
] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);

/**
 * `new Agent({` at a statement position. Excluded: comment/JSDoc mentions, and
 * unrelated `Agent` classes from other libraries (undici's connection Agent is
 * constructed with a positional options object on one line, never a
 * multi-line literal opened by `({`).
 */
const AGENT_CTOR = /(?<!\*\s)(?<!\/\/\s)new Agent\(\{/;

async function findAgentHosts(): Promise<Array<{ id: string; source: string }>> {
  const found: Array<{ id: string; source: string }> = [];
  const pkgs = await fs.readdir(PACKAGES, { withFileTypes: true });
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    const src = path.join(PACKAGES, pkg.name, 'src');
    await walk(src, pkg.name, src, found).catch(() => undefined);
  }
  return found;
}

async function walk(
  dir: string,
  pkgName: string,
  srcRoot: string,
  out: Array<{ id: string; source: string }>,
): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, pkgName, srcRoot, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const source = await fs.readFile(full, 'utf8');
    if (!AGENT_CTOR.test(source)) continue;
    // The core package defines the Agent; its own docs and helpers are not hosts.
    if (pkgName === 'core' || pkgName === 'tools') continue;
    const rel = path.relative(srcRoot, full).split(path.sep).join('/');
    out.push({ id: `${pkgName}/${rel}`, source });
  }
}

describe('agent loop-safety host parity', () => {
  it('the workspace constructs an Agent only in the known hosts', async () => {
    const found = await findAgentHosts();
    expect(found.map((h) => h.id).sort()).toEqual([...HOSTS].sort());
  });

  it('every host wires the loop detector from tools.loopDetection', async () => {
    const found = await findAgentHosts();
    for (const host of found) {
      expect(host.source, `${host.id} never sets loopDetection`).toMatch(/loopDetection:/);
      // session-agent-registry forwards the template Agent's resolved value.
      expect(host.source, `${host.id} must resolve loopDetection from config`).toMatch(
        /loopDetection:\s*(config\.tools|template\.loopDetection|params\.config\.tools)/,
      );
    }
  });

  it('every host resolves the turn budget from tools.maxIterations', async () => {
    const found = await findAgentHosts();
    for (const host of found) {
      expect(host.source, `${host.id} never sets maxIterations`).toMatch(/maxIterations/);
      expect(host.source, `${host.id} must resolve maxIterations from config`).toMatch(
        /maxIterations:\s*(config\.tools|template\.maxIterations|params\.config\.tools)|config\.tools\.maxIterations/,
      );
    }
  });

  it('no host hard-codes a turn budget', async () => {
    const found = await findAgentHosts();
    for (const host of found) {
      expect(host.source, `${host.id} hard-codes maxIterations`).not.toMatch(
        /maxIterations:\s*\d+\s*,/,
      );
    }
  });
});
