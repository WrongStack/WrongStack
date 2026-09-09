import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  ACP_PROTOCOL_VERSION,
  type ClientCapabilities,
  type McpServer,
  type RequestPermissionOutcome,
  type RunTurnApi,
  type SessionConfigOption,
  type SessionMode,
  WRONGSTACK_VERSION,
} from './protocol-contract.js';

const WRONGSTACK_AUTH_METHODS = [
  {
    id: 'wrongstack-auth',
    name: 'Run wstack auth',
    description: 'Configure a WrongStack model provider in an interactive terminal.',
    type: 'terminal',
    args: ['auth'],
  },
];

/** Single global mode id, sufficient for v1. */
export const DEFAULT_MODE_ID = 'code';
export const DEFAULT_MAX_SESSIONS = 64;

export const DEFAULT_MODES: readonly SessionMode[] = [
  {
    id: DEFAULT_MODE_ID,
    name: 'Code',
    description: 'Default agent mode for code-generation tasks.',
  },
];

/**
 * Validate the `mcpServers` array a client sends with `session/new`,
 * `session/load` or `session/fork`.
 *
 * Malformed entries are dropped rather than rejecting the whole request: an
 * editor that ships one bad server config should still get a working session.
 * A dropped entry is reported through `onSkipped` so the caller can tell the
 * client instead of silently discarding what it asked for — silent discard is
 * exactly how this array came to be ignored in the first place.
 */
export function parseMcpServers(raw: unknown, onSkipped?: (reason: string) => void): McpServer[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServer[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      onSkipped?.('entry is not an object');
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (name === '') {
      onSkipped?.('entry has no name');
      continue;
    }
    const type = typeof e.type === 'string' ? e.type : 'stdio';
    if (type === 'http' || type === 'sse') {
      if (typeof e.url !== 'string' || e.url === '') {
        onSkipped?.(`"${name}": ${type} server has no url`);
        continue;
      }
      const headers = parseNameValuePairs(e.headers);
      const url = e.url;
      // Written as two pushes rather than one with a `type` variable: the
      // discriminated union only narrows against a literal.
      out.push(
        type === 'http'
          ? { type: 'http', name, url, ...(headers ? { headers } : {}) }
          : { type: 'sse', name, url, ...(headers ? { headers } : {}) },
      );
      continue;
    }
    if (type !== 'stdio') {
      onSkipped?.(`"${name}": unknown transport "${type}"`);
      continue;
    }
    if (typeof e.command !== 'string' || e.command === '') {
      onSkipped?.(`"${name}": stdio server has no command`);
      continue;
    }
    const args = Array.isArray(e.args)
      ? e.args.filter((a): a is string => typeof a === 'string')
      : undefined;
    const env = parseNameValuePairs(e.env);
    out.push({
      name,
      command: e.command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
    });
  }
  return out;
}

/**
 * ACP passes env vars and headers as `{name, value}[]`, not as an object.
 * The wire shape is kept as-is here — converting to a record is the
 * consumer's job — so this only drops entries that are not two strings.
 * Returns undefined when there is nothing usable so callers can spread
 * conditionally under `exactOptionalPropertyTypes`.
 */
function parseNameValuePairs(raw: unknown): Array<{ name: string; value: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ name: string; value: string }> = [];
  for (const pair of raw) {
    if (typeof pair !== 'object' || pair === null) continue;
    const p = pair as Record<string, unknown>;
    if (typeof p.name === 'string' && p.name !== '' && typeof p.value === 'string') {
      out.push({ name: p.name, value: p.value });
    }
  }
  return out.length > 0 ? out : undefined;
}

export async function resolveSessionCwd(requested: string): Promise<string | null> {
  if (!path.isAbsolute(requested)) return null;
  const resolved = path.resolve(requested);
  try {
    const stat = await fsp.stat(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export function errorToJsonRpc(err: unknown): { code: number; message: string; data?: unknown } {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof e.code === 'number' && typeof e.message === 'string') {
      const result: { code: number; message: string; data?: unknown } = {
        code: e.code,
        message: e.message,
      };
      if (e.data !== undefined) result.data = e.data;
      return result;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: -32603, message };
}

export function createRunTurnApi(
  sessionId: string,
  clientCapabilities: ClientCapabilities,
  request: (method: string, params: unknown) => Promise<unknown>,
): RunTurnApi {
  return {
    clientCapabilities,
    requestPermission: async (req) => {
      const res = await request('session/request_permission', {
        sessionId,
        toolCall: req.toolCall,
        options: req.options,
      });
      const outcome = (res as { outcome?: RequestPermissionOutcome } | undefined)?.outcome;
      return outcome ?? { outcome: 'cancelled' };
    },
    readTextFile: async (params) => {
      const res = await request('fs/read_text_file', { sessionId, ...params });
      return String((res as { content?: unknown })?.content ?? '');
    },
    writeTextFile: async (params) => {
      await request('fs/write_text_file', { sessionId, ...params });
    },
    runTerminal: async ({ command, args, cwd }) => {
      const created = (await request('terminal/create', {
        sessionId,
        command,
        ...(args ? { args } : {}),
        ...(cwd ? { cwd } : {}),
      })) as { terminalId?: string };
      const terminalId = created?.terminalId;
      if (!terminalId) return { output: '', exitCode: null };
      try {
        const exit = (await request('terminal/wait_for_exit', {
          sessionId,
          terminalId,
        })) as {
          exitCode?: number | null;
        };
        const out = (await request('terminal/output', { sessionId, terminalId })) as {
          output?: unknown;
        };
        return {
          output: String(out?.output ?? ''),
          exitCode: typeof exit?.exitCode === 'number' ? exit.exitCode : null,
        };
      } finally {
        try {
          await request('terminal/release', { sessionId, terminalId });
        } catch {
          // best-effort release
        }
      }
    },
  };
}

export function buildInitializeResult(
  agentName: string,
  modes: readonly SessionMode[],
  configOptions: readonly SessionConfigOption[],
) {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      // All three ACP transports are supported. stdio is mandatory per spec
      // and cannot be declined; http and sse are declared here because the
      // agent now actually connects them (see `parseMcpServers` above and the
      // per-session MCP registry in `buildAcpServerAgentFactory`). Before that
      // wiring existed the array was destructured and thrown away at every
      // entry point, so a client got a successful `session/new` and no tools —
      // flip these back to false if that connection path is ever removed.
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      sessionCapabilities: {
        close: {},
        list: {},
        delete: {},
        resume: {},
        fork: {},
      },
      auth: {
        logout: {},
      },
    },
    agentInfo: {
      name: agentName,
      title: 'WrongStack',
      version: WRONGSTACK_VERSION,
    },
    authMethods: WRONGSTACK_AUTH_METHODS,
    modes,
    configOptions,
  };
}
