import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { API_VERSION } from '../../version.js';
import type { SubcommandHandler } from '../contracts.js';
import {
  clearStaleDaemonEndpoints,
  collectDaemonReports,
  type DaemonReport,
} from './daemon-inventory.js';

export const diagCmd: SubcommandHandler = async (_args, deps) => {
  const cfg = deps.config;
  const age = await deps.modelsRegistry.ageSeconds();
  const lines = [
    color.bold('WrongStack diagnostics'),
    `  apiVersion:    ${API_VERSION}`,
    `  cwd:           ${deps.cwd}`,
    `  projectRoot:   ${deps.projectRoot}`,
    `  projectHash:   ${deps.paths.projectHash}`,
    `  projectDir:    ${deps.paths.projectDir}`,
    `  globalRoot:    ${deps.paths.globalRoot}`,
    `  modelsCache:   ${deps.paths.modelsCache}`,
    `  cacheAge:      ${isFinite(age) ? `${Math.round(age / 60)}m` : 'never'}`,
    `  node:          ${process.version}`,
    `  os:            ${os.platform()} ${os.release()}`,
    `  provider:      ${cfg.provider ?? '<unset>'}`,
    `  model:         ${cfg.model ?? '<unset>'}`,
    `  tools:         ${deps.toolRegistry?.list().length ?? 0}`,
    `  plugins:       ${cfg.plugins?.length ?? 0}`,
    `  mcpServers:    ${Object.keys(cfg.mcpServers ?? {}).length}`,
  ];
  deps.renderer.write(lines.join('\n') + '\n');
  return 0;
};

/**
 * `wstack doctor --daemons` — the operator's window into project IPC.
 *
 * Deliberately a command rather than anything shown at startup. Daemons are
 * shared by every surface for the project, so "is one running?" has a correct
 * answer that never needs a human (reuse it) and "should I kill these?" is a
 * question the launcher cannot answer safely — another live session, a WebUI,
 * or a fleet agent may be connected to exactly the daemon being offered up for
 * a restart. Asking at startup would put that decision in front of a user who
 * has no way to make it and no reason to care while things work.
 *
 * So the split is: self-healing by default, one warning line when self-healing
 * fails, and this command when someone actually wants to look.
 */
async function reportDaemons(
  deps: Parameters<SubcommandHandler>[1],
  opts: { readonly clear: boolean },
): Promise<number> {
  const inventory = { projectRoot: deps.projectRoot, projectDir: deps.paths.projectDir };
  let reports: readonly DaemonReport[] = await collectDaemonReports(inventory);
  deps.renderer.write(color.bold('WrongStack project daemons\n\n'));
  const icon = (status: DaemonReport['status']): string =>
    status === 'live' ? color.green('✓') : status === 'stale' ? color.red('✗') : color.dim('·');
  for (const report of reports) {
    const suffix = report.pid === undefined ? '' : ` pid ${report.pid}`;
    deps.renderer.write(
      `  ${icon(report.status)} ${report.name.padEnd(16)} ${report.status.padEnd(8)}` +
        `${color.dim(report.endpoint + suffix)}\n`,
    );
  }
  const stale = reports.filter((report) => report.status === 'stale');
  if (stale.length === 0) {
    deps.renderer.write(color.green('\nNo wedged endpoints.\n'));
    return 0;
  }
  if (!opts.clear) {
    deps.renderer.write(
      color.amber(
        `\n${stale.length} stale endpoint${stale.length === 1 ? '' : 's'}: ` +
          `${stale.map((report) => report.name).join(', ')}\n`,
      ),
    );
    deps.renderer.write(
      color.dim(
        '  A daemon died without releasing its endpoint. Current daemons reclaim\n' +
          '  this automatically on next start; clear it now with:\n' +
          '    wstack doctor --daemons --clear-stale\n',
      ),
    );
    return 1;
  }
  const cleared = await clearStaleDaemonEndpoints(inventory);
  reports = await collectDaemonReports(inventory);
  const remaining = reports.filter((report) => report.status === 'stale');
  if (cleared.length > 0) {
    deps.renderer.write(color.green(`\nCleared: ${cleared.join(', ')}\n`));
  }
  if (remaining.length > 0) {
    deps.renderer.write(
      color.red(`Still wedged: ${remaining.map((report) => report.name).join(', ')}\n`),
    );
    return 1;
  }
  deps.renderer.write(color.dim('Daemons restart on demand — no further action needed.\n'));
  return 0;
}

export const doctorCmd: SubcommandHandler = async (args, deps) => {
  // Flags arrive already-parsed in `deps.flags` — the top-level parser strips
  // them from positionals. `args` is checked too so the handler stays callable
  // directly (tests, and the `wstack diag` alias path).
  const flagged = (name: string): boolean =>
    deps.flags?.[name] === true || deps.flags?.[name] === 'true' || args.includes(`--${name}`);
  if (flagged('daemons')) {
    return reportDaemons(deps, { clear: flagged('clear-stale') });
  }
  type CheckResult = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string };
  const checks: CheckResult[] = [];
  const cfg = deps.config;
  if (!cfg.provider)
    checks.push({
      name: 'provider',
      status: 'fail',
      detail: 'no provider configured — run `wstack auth` to set up',
    });
  else checks.push({ name: 'provider', status: 'ok', detail: cfg.provider });
  if (!cfg.model)
    checks.push({
      name: 'model',
      status: 'fail',
      detail: 'no model configured — run `wstack auth` to configure',
    });
  else checks.push({ name: 'model', status: 'ok', detail: cfg.model });
  if (cfg.provider) {
    const providerCfg = (
      cfg.providers as
        | Record<string, { apiKey?: string | undefined; envVars?: string[] | undefined }>
        | undefined
    )?.[cfg.provider];
    const hasVaultKey = typeof providerCfg?.apiKey === 'string' && providerCfg.apiKey.length > 0;
    const envHit = providerCfg?.envVars?.some((v) => process.env[v]) ?? false;
    if (hasVaultKey || envHit)
      checks.push({
        name: 'api key',
        status: 'ok',
        detail: hasVaultKey ? 'found in vault' : 'found in env',
      });
    else
      checks.push({
        name: 'api key',
        status: 'fail',
        detail: `no key for "${cfg.provider}" in vault or env — run \`wstack auth ${cfg.provider}\``,
      });
  }
  try {
    const age = await deps.modelsRegistry.ageSeconds();
    if (!isFinite(age))
      checks.push({
        name: 'models cache',
        status: 'warn',
        detail: 'never fetched — run `wstack models refresh`',
      });
    else if (age > 7 * 24 * 3600)
      checks.push({
        name: 'models cache',
        status: 'warn',
        detail: `${Math.round(age / 86400)} days old — run \`wstack models refresh\``,
      });
    else
      checks.push({ name: 'models cache', status: 'ok', detail: `${Math.round(age / 60)}m old` });
  } catch (err) {
    checks.push({
      name: 'models cache',
      status: 'warn',
      detail: `read failed: ${toErrorMessage(err)}`,
    });
  }
  try {
    await fs.access(deps.paths.secretsKey);
    checks.push({ name: 'secret vault', status: 'ok', detail: deps.paths.secretsKey });
  } catch {
    checks.push({
      name: 'secret vault',
      status: 'warn',
      detail: 'not yet initialized (created lazily on first encrypt)',
    });
  }
  try {
    await fs.mkdir(deps.paths.projectSessions, { recursive: true });
    const probe = path.join(deps.paths.projectSessions, `.probe-${Date.now()}`);
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    checks.push({ name: 'sessions writable', status: 'ok', detail: deps.paths.projectSessions });
  } catch (err) {
    checks.push({
      name: 'sessions writable',
      status: 'fail',
      detail: `cannot write to ${deps.paths.projectSessions}: ${toErrorMessage(err)}`,
    });
  }
  const mcpEntries = Object.entries(cfg.mcpServers ?? {}) as [
    string,
    {
      enabled?: boolean | undefined;
      transport?: string | undefined;
      command?: string | undefined;
      url?: string | undefined;
    },
  ][];
  for (const [name, srv] of mcpEntries) {
    if (!srv.enabled) continue;
    if ((srv.transport === 'sse' || srv.transport === 'streamable-http') && !srv.url)
      checks.push({ name: `mcp:${name}`, status: 'fail', detail: 'transport requires url' });
    else if (srv.transport === 'stdio' && !srv.command)
      checks.push({
        name: `mcp:${name}`,
        status: 'fail',
        detail: 'stdio transport requires command',
      });
    else
      checks.push({
        name: `mcp:${name}`,
        status: 'ok',
        detail: `${srv.transport} ${srv.command ?? srv.url ?? ''}`.trim(),
      });
  }
  const major = Number.parseInt(process.version.replace(/^v/, '').split('.')[0] ?? '0', 10);
  if (major < 22)
    checks.push({ name: 'node', status: 'fail', detail: `${process.version} (need ≥22)` });
  else checks.push({ name: 'node', status: 'ok', detail: process.version });
  deps.renderer.write(color.bold('WrongStack doctor\n\n'));
  let failed = 0;
  let warned = 0;
  for (const c of checks) {
    const icon =
      c.status === 'ok'
        ? color.green('✓')
        : c.status === 'warn'
          ? color.amber('●')
          : color.red('✗');
    deps.renderer.write(`  ${icon} ${c.name.padEnd(20)} ${color.dim(c.detail)}\n`);
    if (c.status === 'fail') failed++;
    if (c.status === 'warn') warned++;
  }
  deps.renderer.write('\n');
  if (failed > 0) {
    deps.renderer.write(
      color.red(`${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}\n`),
    );
    return 1;
  }
  if (warned > 0) {
    deps.renderer.write(
      color.amber(`All checks passed (${warned} warning${warned === 1 ? '' : 's'})\n`),
    );
    return 0;
  }
  deps.renderer.write(color.green('All checks passed.\n'));
  return 0;
};
