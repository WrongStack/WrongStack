import type { MCPServerConfig } from '@wrongstack/contracts/types';

/**
 * `${VAR}` / `${VAR:-default}` placeholders in an MCP server's command, args,
 * env, url and headers — the `.mcp.json` convention (`--mcp-config`,
 * `import-claude-code`) that WrongStack used to pass through literally, so a
 * header like `Authorization: Bearer ${GITHUB_TOKEN}` reached the server as
 * that exact text.
 *
 * Expanded when the client is built, never when the config is written, so a
 * secret never lands in a config file or in `mcp list` output. Server entries
 * only come from the user's own config, a `--mcp-config` they passed, or an
 * import they applied — an in-project config cannot declare `mcpServers` at all
 * (see the in-project policy) — so reading their environment is theirs to allow.
 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

interface ExpandableFields {
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** Every environment variable a server entry reads through placeholders, sorted. */
export function mcpEnvPlaceholders(cfg: Partial<ExpandableFields>): string[] {
  const names = new Set<string>();
  const scan = (value: string | undefined) => {
    if (!value) return;
    for (const match of value.matchAll(PLACEHOLDER)) if (match[1]) names.add(match[1]);
  };
  scan(cfg.command);
  scan(cfg.url);
  for (const arg of cfg.args ?? []) scan(arg);
  for (const value of Object.values(cfg.env ?? {})) scan(value);
  for (const value of Object.values(cfg.headers ?? {})) scan(value);
  return [...names].sort();
}

/**
 * The expandable fields with every placeholder resolved from `env`. A variable
 * that is unset (or empty) with no default is an error naming it: sending the
 * literal `${TOKEN}` would only fail later, as an opaque 401.
 */
export function expandMcpEnvPlaceholders(
  cfg: Readonly<MCPServerConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ExpandableFields {
  const missing = new Set<string>();
  const expand = (value: string): string =>
    value.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => {
      const resolved = Object.hasOwn(env, name) ? env[name] : undefined;
      if (resolved !== undefined && resolved !== '') return resolved;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return '';
    });
  const mapValues = (record: Record<string, string> | undefined) =>
    record
      ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]))
      : undefined;
  const expanded: ExpandableFields = {
    command: cfg.command === undefined ? undefined : expand(cfg.command),
    args: cfg.args?.map(expand),
    env: mapValues(cfg.env),
    url: cfg.url === undefined ? undefined : expand(cfg.url),
    headers: mapValues(cfg.headers),
  };
  if (missing.size > 0) {
    throw new Error(
      `MCP server "${cfg.name}" needs environment variable${missing.size === 1 ? '' : 's'} ${[
        ...missing,
      ].join(', ')} (referenced as \${…} in its config)`,
    );
  }
  return expanded;
}
