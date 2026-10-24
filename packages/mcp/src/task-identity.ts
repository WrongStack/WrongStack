import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { Tool } from '@wrongstack/contracts/types';
import type { MCPClientOptions } from './client-types.js';

export type MCPTaskContext = Parameters<Tool['execute']>[1];

export interface MCPTaskOwner {
  sessionId: string;
  agentId: string;
}

export function taskOwner(context: MCPTaskContext | undefined): MCPTaskOwner | undefined {
  const sessionId = context?.eventSessionId?.() ?? context?.session?.id;
  const agentId = context?.agentId;
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId.length > 256 ||
    typeof agentId !== 'string' ||
    !agentId ||
    agentId.length > 256
  )
    return undefined;
  return { sessionId, agentId };
}

export function sameTaskOwner(a: MCPTaskOwner, b: MCPTaskOwner | undefined): boolean {
  return a.sessionId === b?.sessionId && a.agentId === b.agentId;
}

/** No credential leaves this digest. Custom auth providers must supply a stable grant identity. */
export async function taskBinding(opts: MCPClientOptions): Promise<string | undefined> {
  if (opts.authorizationProvider && !opts.authorizationProvider.getTaskIdentity) return undefined;
  const grant = await opts.authorizationProvider?.getTaskIdentity?.();
  if (opts.authorizationProvider && grant === undefined) return undefined;
  const sorted = (value: Record<string, string> | undefined) =>
    Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(
      JSON.stringify({
        server: opts.name,
        transport: opts.transport,
        command: opts.command,
        args: opts.args,
        cwd: await realpath(opts.cwd ?? process.cwd()),
        url: opts.url,
        env: sorted(opts.env),
        headers: sorted(opts.headers),
        bearerTokenEnv: opts.bearerTokenEnv,
        bearer: opts.bearerTokenEnv ? process.env[opts.bearerTokenEnv] : undefined,
        passthrough: (opts.passthroughEnv ?? [])
          .map((key) => [key, process.env[key]])
          .sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')),
        grant,
      }),
    )
    .digest('hex');
}
