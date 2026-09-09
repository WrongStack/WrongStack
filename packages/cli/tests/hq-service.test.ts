import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';
import { hqServiceCmd, renderHqServiceAssets } from '../src/hq-service.js';
import { hqCmd } from '../src/subcommands/handlers/hq.js';

describe('HQ systemd service assets', () => {
  it('renders an always-on, least-privilege HQ service without embedding its password', () => {
    const assets = renderHqServiceAssets({
      wstackBin: '/usr/local/bin/wstack',
      packageManager: 'npm',
      packageName: 'wrongstack',
      password: 'safe"pass\\word',
      port: 3499,
      publicOrigin: 'https://hq.example.com',
      ipAllowlist: '203.0.113.4,10.0.0.0/8',
    });

    expect(assets.service).toContain('DynamicUser=yes');
    expect(assets.service).toContain('Managed by WrongStack HQ service installer');
    expect(assets.service).toContain('StateDirectory=wrongstack-hq');
    expect(assets.service).toContain('ExecStart="/usr/local/bin/wstack" hq serve');
    expect(assets.service).toContain('Restart=always');
    expect(assets.service).toContain('ProtectSystem=strict');
    expect(assets.service).toContain('WRONGSTACK_HQ_SUPPRESS_STARTUP_SECRETS=1');
    expect(assets.service).not.toContain('safe"pass');
    expect(assets.updateService).not.toContain('safe"pass');
    expect(assets.updateScript).not.toContain('safe"pass');
    expect(assets.environment).toContain('WRONGSTACK_HQ_PASSWORD="safe\\"pass\\\\word"');
    expect(assets.environment).toContain('WRONGSTACK_HQ_PUBLIC_URL="https://hq.example.com"');
    expect(assets.environment).toContain('WRONGSTACK_HQ_ALLOWLIST="203.0.113.4,10.0.0.0/8"');
    expect(assets.service).toContain('--host 127.0.0.1');
  });

  it('renders a persistent timer and a rollback-capable, service-restoring updater', () => {
    const assets = renderHqServiceAssets({
      wstackBin: '/usr/bin/wstack',
      packageManager: 'pnpm',
      packageName: '@wrongstack/cli',
      password: 'long-enough-password',
      port: 4400,
    });

    expect(assets.updateTimer).toContain('Persistent=true');
    expect(assets.updateTimer).toContain('RandomizedDelaySec=1h');
    expect(assets.updateScript).toContain('update --check-only');
    expect(assets.updateScript).toContain('systemctl stop "$SERVICE"');
    expect(assets.updateScript).toContain('trap ensure_started EXIT INT TERM');
    expect(assets.updateScript).toContain(
      '\'pnpm\' add -g --ignore-scripts "@wrongstack/cli@$PREVIOUS_VERSION"',
    );
    expect(assets.updateScript).toContain("export PNPM_HOME='/usr/bin'");
    expect(assets.updateScript).toContain('systemctl is-active --quiet "$SERVICE"');
    expect(assets.updateScript).toContain('systemctl stop "$SERVICE" || true\n  SERVICE_STOPPED=1');
    expect(assets.updateService).toContain('ProtectHome=yes');
    expect(assets.service).toContain('--host 0.0.0.0');
    expect(assets.environment).not.toContain('WRONGSTACK_HQ_ALLOWLIST');
  });

  it('produces a shell-syntax-valid updater when bash is available', () => {
    const script = renderHqServiceAssets({
      wstackBin: '/usr/local/bin/wstack',
      packageManager: 'npm',
      packageName: 'wrongstack',
      password: 'long-enough-password',
      port: 3499,
    }).updateScript;
    const result = spawnSync('bash', ['-n', '-s'], { input: script, encoding: 'utf8' });
    if (result.error && 'code' in result.error && result.error.code === 'ENOENT') return;
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects newline injection in generated secret files', () => {
    expect(() =>
      renderHqServiceAssets({
        wstackBin: '/usr/bin/wstack',
        packageManager: 'npm',
        packageName: 'wrongstack',
        password: 'validpass\nINJECTED=yes',
        port: 3499,
      }),
    ).toThrow('line breaks');
  });

  it('parses --no-auto-update without consuming the service action', () => {
    expect(parseArgs(['hq', 'service', 'install', '--no-auto-update'])).toMatchObject({
      positional: ['hq', 'service', 'install'],
      flags: { 'no-auto-update': true },
    });
  });

  it('prints service-specific help without touching systemd', async () => {
    const writes: string[] = [];
    const code = await hqServiceCmd(['help'], {
      renderer: { write: (value: string) => writes.push(value) },
    } as never);
    expect(code).toBe(0);
    expect(writes.join('')).toContain('sudo -E wstack hq service install');
  });

  it('routes the nested HQ service command through the public hq handler', async () => {
    const writes: string[] = [];
    const code = await hqCmd(['service', 'help'], {
      renderer: { write: (value: string) => writes.push(value) },
    } as never);
    expect(code).toBe(0);
    expect(writes.join('')).toContain('wstack hq service status');
  });
});
