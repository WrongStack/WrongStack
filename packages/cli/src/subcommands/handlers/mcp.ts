import { allServers } from '@wrongstack/core/infrastructure';
import {
  expectDefined,
  jsonObjectFileExists,
  readJsonObjectFile,
  removeJsonPath,
  setJsonPath,
  updateJsonObjectFile,
} from '@wrongstack/core/utils';
import { serveMcpStdio } from '../../mcp-serve.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';

const BUILT_IN_MCP = allServers();

export const mcpCmd: SubcommandHandler = async (args, deps) => {
  // `parseArgs` strips these before the dispatcher calls us — see restoreFlags.
  // Without them `mcp add filesystem --enable` wrote `enabled: false`.
  args = restoreFlags(args, deps, ['enable', 'e', 'transport', 'url', 'command']);
  const sub = args[0];
  if (sub === 'serve') {
    // Run WrongStack as an MCP server over stdio. Blocks until stdin closes.
    // Flags (--yolo/--tools) come via deps.flags — the dispatcher strips them
    // from positional args. The remaining positionals are forwarded so
    // `--tools read,grep` (boolean flag + positional CSV, because `tools` is
    // a BOOLEAN_FLAGS member) can recover its whitelist.
    return serveMcpStdio(deps, args.slice(1));
  }
  if (!sub || sub === 'list') {
    const servers = deps.config.mcpServers ?? {};
    if (Object.keys(servers).length === 0) {
      deps.renderer.write('No MCP servers configured.\n');
      deps.renderer.write('Use `wstack mcp add <name>` or set mcpServers in your config.\n');
      return 0;
    }
    for (const [name, cfg] of Object.entries(servers)) {
      const status = cfg.enabled === false ? 'disabled' : 'enabled';
      const desc = cfg.description ? `  # ${cfg.description}` : '';
      deps.renderer.write(`  ${name.padEnd(20)} ${cfg.transport.padEnd(16)} ${status}${desc}\n`);
    }
    return 0;
  }
  if (sub === 'add') {
    return addMcpServer(args, deps);
  }
  if (sub === 'remove') {
    const name = args[1];
    if (!name) {
      deps.renderer.writeError('Usage: wstack mcp remove <name>\n');
      return 1;
    }
    return removeMcpServer(name, deps);
  }
  if (sub === 'restart') {
    deps.renderer.writeWarning(
      'mcp restart is only available in REPL mode. Use /mcp restart instead.',
    );
    return 0;
  }
  deps.renderer.writeError(`Unknown mcp subcommand: ${sub}`);
  return 1;
};

async function addMcpServer(args: string[], deps: SubcommandDeps): Promise<number> {
  const configPath = activeProfileConfigPath(deps.paths, deps.config);
  const name = args[1];
  const enable = args.includes('--enable') || args.includes('-e');
  if (!name) {
    deps.renderer.writeError('Usage: wstack mcp add <name>\n');
    deps.renderer.write('Available servers:\n');
    for (const [sname, scfg] of Object.entries(deps.config.mcpServers ?? {}))
      deps.renderer.write(`  ${sname.padEnd(20)} ${scfg.description ?? scfg.transport}\n`);
    if (Object.keys(deps.config.mcpServers ?? {}).length === 0)
      for (const k of Object.keys(BUILT_IN_MCP)) {
        const s = expectDefined(BUILT_IN_MCP[k]);
        deps.renderer.write(`  ${k.padEnd(20)} ${s.description}\n`);
      }
    deps.renderer.write('\nRun `wstack mcp add <name> --enable` to enable immediately.\n');
    return 1;
  }
  const factory = BUILT_IN_MCP[name];
  if (!factory) {
    deps.renderer.writeError(
      `Unknown server "${name}". Run \`wstack mcp add\` without args to see available servers.\n`,
    );
    return 1;
  }
  const serverCfg = { ...factory };
  serverCfg.enabled = enable;
  const existing = await readJsonObjectFile(configPath);
  const mcpServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  if (mcpServers[name])
    deps.renderer.writeWarning(`Server "${name}" already in config. Updating.\n`);
  await updateJsonObjectFile(configPath, (config) => {
    setJsonPath(config, ['mcpServers', name], serverCfg);
  });
  const verb = enable ? 'Enabled' : 'Added (disabled — set enabled:true to activate)';
  deps.renderer.writeInfo(
    `${verb} "${name}" (${serverCfg.transport}). Config written to ${configPath}.\n`,
  );
  return 0;
}

async function removeMcpServer(name: string, deps: SubcommandDeps): Promise<number> {
  const configPath = activeProfileConfigPath(deps.paths, deps.config);
  if (!(await jsonObjectFileExists(configPath))) {
    deps.renderer.writeError('No config file found.\n');
    return 1;
  }
  const existing = await readJsonObjectFile(configPath);
  const mcpServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
  if (!mcpServers[name]) {
    deps.renderer.writeError(`Server "${name}" not in config.\n`);
    return 1;
  }
  await updateJsonObjectFile(configPath, (config) => {
    removeJsonPath(config, ['mcpServers', name]);
  });
  deps.renderer.writeInfo(`Removed "${name}" from config.\n`);
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
