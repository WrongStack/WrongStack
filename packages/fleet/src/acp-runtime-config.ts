import { createHash } from 'node:crypto';
import {
  ACPSession,
  applyAcpRuntimeValues,
  readOnlyPermissionPolicy,
  resolveAcpAgentCommand,
} from '@wrongstack/acp';
import type { Config } from '@wrongstack/contracts/types';
import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { acpRuntimeValuesError } from '@wrongstack/contracts/types/acp-runtime';
import { installedBridgeAgents } from './acp-wrongstack-bridge.js';

const pending = new Map<string, Promise<AcpRuntimeOptionsResult>>();
let active = 0;
/** No prompt, MCP injection or file writes: just an authenticated private session and its selectors. */
export function inspectAcpRuntime(
  config: Config,
  projectRoot: string,
  agentId: string,
  values: AcpRuntimeValues = {},
): Promise<AcpRuntimeOptionsResult> {
  const invalid = acpRuntimeValuesError(values);
  if (invalid) return Promise.reject(new Error(invalid));
  if (
    !installedBridgeAgents(config.acp).includes(agentId) ||
    config.disabledProviders?.includes('acp')
  )
    return Promise.reject(new Error('ACP agent is not enabled in the installed agent list'));
  const cmd = resolveAcpAgentCommand(agentId, config.acp?.agents);
  if (!cmd) return Promise.reject(new Error(`Unknown ACP agent: ${agentId}`));
  const desiredValues = { ...config.modelRuntime?.acp?.[agentId], ...values };
  const key = createHash('sha256')
    .update(JSON.stringify([agentId, projectRoot, cmd, desiredValues]))
    .digest('hex');
  const existing = pending.get(key);
  if (existing) return existing;
  if (active >= 2)
    return Promise.reject(new Error('Agent settings discovery is busy. Retry shortly.'));
  active++;
  const request = (async () => {
    let session: ACPSession | undefined;
    const deadline = setTimeout(() => {
      void session?.close({ graceMs: 0 });
    }, 90_000);
    try {
      session = await ACPSession.start({
        ...cmd,
        role: agentId,
        cwd: projectRoot,
        projectRoot,
        timeoutMs: 45_000,
        permissionPolicy: readOnlyPermissionPolicy,
      });
      await session.openSession();
      const options = await applyAcpRuntimeValues(session, desiredValues);
      return { agentId, options, applied: { ...values } };
    } finally {
      clearTimeout(deadline);
      try {
        await session?.close({ graceMs: 1000 });
      } finally {
        active--;
        pending.delete(key);
      }
    }
  })();
  pending.set(key, request);
  return request;
}
