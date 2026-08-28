import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, toErrorMessage } from '@wrongstack/core/utils';

export const WEBUI_SESSION_CHILD_PROTOCOL_VERSION = 1;

export const WEBUI_SESSION_CHILD_CAPABILITIES = [
  'multi-session-child',
  'single-port-http-ws',
  'session-affinity',
  'graceful-shutdown',
] as const;

type WebuiSessionChildPhase =
  | 'validate_args'
  | 'boot_config'
  | 'claim_session'
  | 'create_session'
  | 'resume_session'
  | 'bind_port'
  | 'register_instance'
  | 'register_session'
  | 'start_server'
  | 'unknown';

export interface WebuiSessionChildOptions {
  enabled: boolean;
  projectRoot: string;
  workingDir: string;
  sessionId?: string | undefined;
  resume: boolean;
  host?: string | undefined;
  port?: number | undefined;
  token?: string | undefined;
  publicUrl?: string | undefined;
  publicWsUrl?: string | undefined;
  requireToken?: boolean | undefined;
  strictPort: boolean;
  parentPid: number;
  parentShellId: string;
  runtimeId: string;
  readyFile: string;
  attachable: boolean;
  protocolVersion: number;
}

export interface WebuiSessionChildReadyPayload {
  type: 'webui.session_child.ready';
  protocolVersion: number;
  runtime: {
    role: 'session-child';
    runtimeId: string;
    pid: number;
    parentPid: number;
    parentShellId: string;
    startedAt: string;
  };
  project: {
    projectRoot: string;
    workingDir: string;
    projectSlug: string;
    projectName: string;
  };
  session: {
    sessionId: string;
    created: boolean;
    resumed: boolean;
    title?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
  };
  endpoint: {
    surface: 'webui';
    host: string;
    httpPort: number;
    url: string;
    publicUrl?: string | undefined;
    publicWsUrl?: string | undefined;
    requireToken: boolean;
    auth: {
      scheme: 'registry-token' | 'cookie-bootstrap' | 'none';
      tokenPresent: boolean;
      token?: string | undefined;
    };
  };
  registry: {
    webuiInstanceRegistered: boolean;
    sessionRegistered: boolean;
  };
  capabilities: string[];
}

interface WebuiSessionChildErrorPayload {
  type: 'webui.session_child.error';
  protocolVersion: number;
  runtimeId?: string | undefined;
  parentShellId?: string | undefined;
  pid: number;
  phase: WebuiSessionChildPhase;
  recoverable: boolean;
  message: string;
  details?: Record<string, unknown> | undefined;
}

function flagValue(flags: Record<string, string | boolean>, names: string[]): string | undefined {
  for (const name of names) {
    if (!Object.hasOwn(flags, name)) continue;
    const value = flags[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    throw new Error(`--${name} requires a value`);
  }
  return undefined;
}

function boolFlag(flags: Record<string, string | boolean>, names: string[]): boolean | undefined {
  for (const name of names) {
    if (!Object.hasOwn(flags, name)) continue;
    const value = flags[name];
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    throw new Error(`--${name} must be a boolean value`);
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  if (value === undefined) throw new Error(`${label} is required`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error('--port must be a port between 1 and 65535');
  }
  return parsed;
}

function requiredString(value: string | undefined, label: string): string {
  if (!value || value.trim() === '') throw new Error(`${label} is required`);
  return value.trim();
}

function requireAbsolutePath(value: string | undefined, label: string): string {
  const resolved = requiredString(value, label);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(resolved);
}

export function parseWebuiSessionChildOptions(
  flags: Record<string, string | boolean>,
): WebuiSessionChildOptions | null {
  if (flags['webui-session-child'] !== true) return null;
  const projectRoot = requireAbsolutePath(flagValue(flags, ['project-root']), '--project-root');
  const workingDir = requireAbsolutePath(flagValue(flags, ['working-dir']), '--working-dir');
  const relativeWorkingDir = path.relative(projectRoot, workingDir);
  if (relativeWorkingDir.startsWith('..') || path.isAbsolute(relativeWorkingDir)) {
    throw new Error('--working-dir must be inside --project-root');
  }
  const sessionId = flagValue(flags, ['session-id']);
  const resume = boolFlag(flags, ['resume']) ?? false;
  if (sessionId && !resume) throw new Error('--session-id requires --resume');
  if (resume && !sessionId) throw new Error('--resume requires --session-id in child mode');
  const host = flagValue(flags, ['webui-host', 'host']);
  const port = parsePort(flagValue(flags, ['webui-port', 'http-port', 'port', 'ws-port']));
  const token = flagValue(flags, ['webui-token', 'token']);
  const publicUrl = flagValue(flags, ['webui-public-url', 'public-url']);
  const publicWsUrl = flagValue(flags, ['webui-public-ws-url', 'public-ws-url']);
  const requireToken = boolFlag(flags, ['webui-require-token', 'require-token']);
  return {
    enabled: true,
    projectRoot,
    workingDir,
    ...(sessionId ? { sessionId } : {}),
    resume,
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(token ? { token } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(publicWsUrl ? { publicWsUrl } : {}),
    ...(requireToken !== undefined ? { requireToken } : {}),
    strictPort: boolFlag(flags, ['strict-port']) ?? false,
    parentPid: parsePositiveInteger(flagValue(flags, ['parent-pid']), '--parent-pid'),
    parentShellId: requiredString(flagValue(flags, ['parent-shell-id']), '--parent-shell-id'),
    runtimeId: requiredString(flagValue(flags, ['runtime-id']), '--runtime-id'),
    readyFile: requireAbsolutePath(flagValue(flags, ['ready-file']), '--ready-file'),
    attachable: boolFlag(flags, ['attachable']) ?? true,
    protocolVersion: parsePositiveInteger(
      flagValue(flags, ['protocol-version']) ?? String(WEBUI_SESSION_CHILD_PROTOCOL_VERSION),
      '--protocol-version',
    ),
  };
}

export async function writeWebuiSessionChildReady(
  readyFile: string,
  payload: WebuiSessionChildReadyPayload,
): Promise<void> {
  await fs.mkdir(path.dirname(readyFile), { recursive: true });
  await atomicWrite(readyFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export async function writeWebuiSessionChildError(
  readyFile: string,
  input: {
    protocolVersion?: number | undefined;
    runtimeId?: string | undefined;
    parentShellId?: string | undefined;
    phase: WebuiSessionChildPhase;
    recoverable: boolean;
    error: unknown;
    details?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const payload: WebuiSessionChildErrorPayload = {
    type: 'webui.session_child.error',
    protocolVersion: input.protocolVersion ?? WEBUI_SESSION_CHILD_PROTOCOL_VERSION,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.parentShellId ? { parentShellId: input.parentShellId } : {}),
    pid: process.pid,
    phase: input.phase,
    recoverable: input.recoverable,
    message: toErrorMessage(input.error),
    ...(input.details ? { details: input.details } : {}),
  };
  await fs.mkdir(path.dirname(readyFile), { recursive: true });
  await atomicWrite(readyFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}
