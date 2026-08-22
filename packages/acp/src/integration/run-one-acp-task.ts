/**
 * One-shot ACP task runner, split out of acp-subagent-runner.ts so the
 * `client` entry (which only needs `makeACPSubagentRunner`) doesn't bundle
 * the SubagentBudget machinery. This is the shared engine behind
 * `wstack acp spawn` and `/acp <id> <task>`.
 */

import { SubagentBudget } from '@wrongstack/core/coordination';
import type { SubagentRunContext } from '@wrongstack/core/types';
import type { ACPProgressHandler } from '../client/acp-session.js';
import type { PermissionPolicy } from '../client/permission.js';
import { makeACPSubagentRunnerWithStop } from './acp-subagent-runner.js';

export interface RunOneAcpTaskOptions {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  /** Agent id / role label, surfaced in errors + the synthetic task id. */
  role?: string | undefined;
  /** The task description forwarded verbatim to the agent. */
  task: string;
  cwd?: string | undefined;
  projectRoot?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ACPProgressHandler | undefined;
  permissionPolicy?: PermissionPolicy | undefined;
}

export interface RunOneAcpTaskResult {
  result: string;
  iterations: number;
  toolCalls: number;
}

/**
 * Run a single task on one ACP agent and return its result. Spawns a fresh
 * process, runs one prompt turn, and tears everything down. Throws a
 * structured `SubagentError` on failure (spawn/init/prompt).
 */
export async function runOneAcpTask(opts: RunOneAcpTaskOptions): Promise<RunOneAcpTaskResult> {
  const role = opts.role ?? 'acp';
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const { runner, stop } = await makeACPSubagentRunnerWithStop({
    command: opts.command,
    ...(opts.args !== undefined ? { args: opts.args } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    role,
    timeoutMs,
    ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
    ...(opts.permissionPolicy !== undefined ? { permissionPolicy: opts.permissionPolicy } : {}),
  });
  try {
    const budget = new SubagentBudget({
      timeoutMs,
      maxIterations: 2000,
      maxToolCalls: 5000,
    });
    budget.start();
    const ctx: SubagentRunContext = {
      subagentId: role,
      config: { id: role, name: role, role, provider: 'acp', prompt: '' },
      budget,
      signal: opts.signal ?? new AbortController().signal,
      bridge: null,
    };
    const result = await runner({ id: `acp-${role}`, description: opts.task }, ctx);
    return {
      result: result.result == null ? '' : String(result.result),
      iterations: result.iterations,
      toolCalls: result.toolCalls,
    };
  } finally {
    try {
      await stop();
    } catch {
      // best-effort teardown
    }
  }
}
