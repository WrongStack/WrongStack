import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  ACP_PROTOCOL_VERSION,
  type ClientCapabilities,
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
      mcpCapabilities: {
        http: false,
        sse: false,
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
