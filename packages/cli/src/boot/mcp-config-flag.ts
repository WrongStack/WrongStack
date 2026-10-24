/**
 * `--mcp-config <file|json>` and `--strict-mcp-config`: MCP servers for this
 * process only, never written to config.
 *
 * Accepts Claude Code's `.mcp.json` shape (`{"mcpServers": {name: {type,
 * command, args, env, url, headers}}}`) as well as WrongStack's own
 * `MCPServerConfig` (`transport: 'stdio' | 'sse' | 'streamable-http'`), with or
 * without the `mcpServers` wrapper. An entry with neither `type` nor
 * `transport` is stdio when it has a `command`, and otherwise falls through to
 * the bundled preset of the same name (`{"github": {}}`).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MCPServerConfig } from '@wrongstack/contracts/types';

export type LaunchMcpServers = Record<string, Partial<MCPServerConfig>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new Error(`${where} must be an object of strings`);
  }
  return value as Record<string, string>;
}

/**
 * Normalize one server entry (Claude Code `type` or WrongStack `transport`
 * form). Throws with the server name on anything unusable. The result carries
 * no `enabled` decision — callers own that.
 */
export function normalizeMcpServerEntry(name: string, raw: unknown): Partial<MCPServerConfig> {
  if (!isRecord(raw)) throw new Error(`server "${name}" must be an object`);
  const where = `server "${name}"`;
  const { type, transport: rawTransport, ...rest } = raw;
  let transport: MCPServerConfig['transport'] | undefined;
  if (rawTransport !== undefined) {
    if (rawTransport !== 'stdio' && rawTransport !== 'sse' && rawTransport !== 'streamable-http') {
      throw new Error(`${where}: unknown transport "${String(rawTransport)}"`);
    }
    transport = rawTransport;
  } else if (type !== undefined) {
    if (type === 'http') transport = 'streamable-http';
    else if (type === 'sse' || type === 'stdio') transport = type;
    else throw new Error(`${where}: unknown type "${String(type)}"`);
  } else if (typeof rest['command'] === 'string') {
    transport = 'stdio';
  }
  if (transport === 'stdio' && typeof rest['command'] !== 'string') {
    throw new Error(`${where}: stdio needs a "command"`);
  }
  if ((transport === 'sse' || transport === 'streamable-http') && typeof rest['url'] !== 'string') {
    throw new Error(`${where}: ${transport} needs a "url"`);
  }
  if (rest['args'] !== undefined && !Array.isArray(rest['args'])) {
    throw new Error(`${where}: "args" must be an array`);
  }
  const env = stringRecord(rest['env'], `${where} "env"`);
  const headers = stringRecord(rest['headers'], `${where} "headers"`);
  return {
    ...(rest as Partial<MCPServerConfig>),
    ...(transport ? { transport } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
  };
}

/** Parse a document already read from disk or given inline. */
export function parseLaunchMcpServers(text: string, source: string): LaunchMcpServers {
  let doc: unknown;
  try {
    // A leading UTF-8 BOM (PowerShell 5 `Set-Content -Encoding UTF8`, Notepad)
    // is ignorable per RFC 8259; config loading strips it the same way.
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`--mcp-config: ${source} is not valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(doc)) throw new Error(`--mcp-config: ${source} must be a JSON object`);
  const servers = isRecord(doc['mcpServers']) ? doc['mcpServers'] : doc;
  const out: LaunchMcpServers = {};
  for (const [name, raw] of Object.entries(servers)) {
    try {
      // Named on the command line: the operator asked for it to run.
      out[name] = { ...normalizeMcpServerEntry(name, raw), enabled: true };
    } catch (err) {
      throw new Error(`--mcp-config: ${source}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Resolve the flag: inline JSON when the value starts with `{`, otherwise a
 * path relative to `cwd`. `undefined` when the flag is absent.
 */
export async function resolveLaunchMcpServers(
  flags: Readonly<Record<string, string | boolean>>,
  cwd: string,
): Promise<LaunchMcpServers | undefined> {
  const value = flags['mcp-config'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('--mcp-config needs a JSON file path or an inline JSON object');
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return parseLaunchMcpServers(trimmed, 'inline JSON');
  const file = path.resolve(cwd, trimmed);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(`--mcp-config: cannot read ${file} (${reason})`);
  }
  return parseLaunchMcpServers(text, file);
}

/**
 * The server set this process starts: config servers (unless strict) with the
 * launch servers layered on top — a launch entry replaces a config entry of the
 * same name rather than merging into it.
 */
export function effectiveMcpServers(
  configured: Readonly<Record<string, Partial<MCPServerConfig>>> | undefined,
  launch: LaunchMcpServers | undefined,
  strict: boolean,
): Record<string, Partial<MCPServerConfig>> {
  return { ...(strict ? {} : (configured ?? {})), ...(launch ?? {}) };
}
