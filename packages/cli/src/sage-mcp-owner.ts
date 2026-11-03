/**
 * WM-407: one memory tool owner per project.
 *
 * When `Sage.service` hands the project's memory to the WrongMemory service,
 * WrongStack's own SAGE MCP server (`wstack sage mcp`, `wstack mcp serve
 * sage`) would be a second owner of the same knowledge: it attaches to (or
 * spawns) the SAGE project server, which is either a competing writer of an
 * adopted store or a different store altogether for a managed one. It would
 * also run under the host's authority, while WrongMemory gives external
 * clients scoped grants. In that mode the MCP entry points (also what ACP
 * workers launch) hand the client to WrongMemory's own bridge under the
 * project's `read-propose` grant, and `wstack sage connect` refuses and points
 * at `wrongmemory connect`. No client configuration is edited automatically.
 */
import {
  probeWrongMemoryProject,
  resolveSageServiceMode,
  type SageServiceSelection,
} from '@wrongstack/sage';

export interface WrongMemoryOwner {
  projectId?: string | undefined;
}

/**
 * The WrongMemory owner of this project, or `undefined` when the in-process
 * SAGE project server owns it. `auto` resolves like the host does: WrongMemory
 * only when a daemon is reachable and the project registered (never started).
 */
export async function wrongMemorySageOwner(
  projectRoot: string,
  service: SageServiceSelection | undefined,
  probe: typeof probeWrongMemoryProject = probeWrongMemoryProject,
): Promise<WrongMemoryOwner | undefined> {
  const mode = resolveSageServiceMode(service);
  if (mode === 'local') return undefined;
  if (mode === 'wrongmemory') return { projectId: service?.projectId };
  const project = await probe({
    projectRoot,
    projectId: service?.projectId,
    dataRoot: service?.dataRoot,
  });
  return project ? { projectId: project.projectId } : undefined;
}

/** What to run instead: WrongMemory's MCP bridge with a scoped grant. */
export function wrongMemoryBridgeHint(owner: WrongMemoryOwner, what: string): string {
  const project = owner.projectId ?? '<project-id>';
  return [
    `${what}: this project's memory is owned by the WrongMemory service (Sage.service.mode),`,
    "so WrongStack's own SAGE MCP server is not started (it would be a second owner).",
    'Connect MCP clients through WrongMemory with a scoped grant instead:',
    `  wrongmemory connect <claude-code|codex|cursor|antigravity> --project ${project} --create-grant`,
    `Existing wrongstack-sage entries can be removed with: wstack sage disconnect <client>`,
  ].join('\n');
}

/**
 * Serve the project's memory MCP endpoint through WrongMemory's own bridge
 * under the project's scoped `read-propose` grant (stdio passed through).
 * Falls back to the refusal hint when the bridge cannot be prepared.
 */
export async function serveWrongMemoryMcp(
  owner: WrongMemoryOwner,
  projectRoot: string,
  service: SageServiceSelection | undefined,
  origin: string,
  what: string,
): Promise<number> {
  const { prepareWrongMemoryMcpBridge } = await import('@wrongstack/sage');
  let launch: Awaited<ReturnType<typeof prepareWrongMemoryMcpBridge>>;
  try {
    launch = await prepareWrongMemoryMcpBridge({ projectRoot, service, origin });
  } catch (error) {
    process.stderr.write(
      `${what}: cannot prepare the WrongMemory MCP bridge (${error instanceof Error ? error.message : String(error)}).\n${wrongMemoryBridgeHint(owner, what)}\n`,
    );
    return 3;
  }
  process.stderr.write(
    `${what}: serving through WrongMemory (project ${launch.projectId}, grant ${launch.grantId}, read-propose)\n`,
  );
  const { spawn } = await import('node:child_process');
  const { buildChildEnv } = await import('@wrongstack/core/utils');
  return new Promise<number>((resolve) => {
    const child = spawn(launch.command, launch.args, {
      stdio: 'inherit',
      windowsHide: true,
      env: buildChildEnv(),
    });
    child.on('error', (error) => {
      process.stderr.write(`${what}: ${error.message}\n${wrongMemoryBridgeHint(owner, what)}\n`);
      resolve(3);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
