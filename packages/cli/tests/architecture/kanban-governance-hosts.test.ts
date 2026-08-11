/**
 * Every ToolExecutor host must resolve `requireKanbanGovernance` the same way.
 *
 * The flag decides whether a mutating tool is refused until the run is bound
 * to a ready, running managed Kanban card. Six places across the workspace
 * build a ToolExecutor, and they are reached by different entry points — the
 * CLI/TUI pipeline, `wstack mcp serve`, the ACP agent, both subagent
 * factories, and the WebUI backend. If one disagrees, the contract changes
 * with the door the work came through: a subagent could mutate freely while
 * the leader that dispatched it was held to a card, or the same repo would
 * govern under `wstack` and not in the browser.
 *
 * Two distinct failure modes have already happened here, which is why this
 * test checks the set of hosts and not just the value:
 *
 *  1. Four hosts hard-coded `false`. They agreed, but the flag was then
 *     unreachable — `true` appeared nowhere outside a unit test, so the gate
 *     was dead code with a config surface that did not exist.
 *  2. Two hosts (`runtime` light subagent factory, `webui-server` backend)
 *     never set the option at all. They were invisible to a grep for the
 *     option name and silently defaulted to off — harmless while the others
 *     were pinned to `false`, and a real split the moment the flag became
 *     configurable.
 *
 * So: enumerate the hosts by walking the source, and require each one to read
 * the config key.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.join(process.cwd(), 'packages');

/** Every file that constructs a ToolExecutor, as `<package>/<path>`. */
const HOSTS = [
  'cli/acp-server-agent.ts',
  'cli/fleet/host-subagent-factory.ts',
  'cli/mcp-serve.ts',
  'cli/wiring/pipeline.ts',
  'runtime/fleet/light-subagent-factory.ts',
  'webui-server/server/backend-services.ts',
] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo']);

async function findExecutorHosts(): Promise<Array<{ id: string; source: string }>> {
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
    if (!/new ToolExecutor\(/.test(source)) continue;
    const rel = path.relative(srcRoot, full).split(path.sep).join('/');
    out.push({ id: `${pkgName}/${rel}`, source });
  }
}

describe('kanban governance host parity', () => {
  it('the workspace builds a ToolExecutor only in the known hosts', async () => {
    const found = await findExecutorHosts();
    expect(found.map((h) => h.id).sort()).toEqual([...HOSTS].sort());
  });

  it('every host resolves the flag from tools.kanbanGovernance', async () => {
    const found = await findExecutorHosts();
    for (const host of found) {
      const assignment = /requireKanbanGovernance:\s*([\s\S]*?),\n/.exec(host.source);
      expect(assignment, `${host.id} does not set requireKanbanGovernance`).not.toBeNull();
      expect(assignment?.[1], `${host.id} must read config.tools.kanbanGovernance`).toContain(
        'kanbanGovernance',
      );
    }
  });

  it('no host hard-codes a governance decision', async () => {
    const found = await findExecutorHosts();
    for (const host of found) {
      expect(host.source, `${host.id} hard-codes requireKanbanGovernance`).not.toMatch(
        /requireKanbanGovernance:\s*(true|false)\s*,/,
      );
    }
  });
});
