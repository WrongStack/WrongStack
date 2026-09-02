import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core/utils';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSettingsCommand } from '../src/slash-commands/settings.js';

function makeCtx(config: Record<string, unknown> = {}): {
  ctx: SlashCommandContext;
  globalConfig: string;
  inProjectConfig: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-settings-test-'));
  const globalConfig = path.join(dir, 'global', 'config.json');
  const inProjectConfig = path.join(dir, 'project', 'config.json');
  const store = {
    get: vi.fn(() => config),
    update: vi.fn(),
  };
  const ctx = {
    configStore: store,
    paths: { globalConfig, profileConfig: () => globalConfig, inProjectConfig },
  } as never as SlashCommandContext;
  return { ctx, globalConfig, inProjectConfig };
}

describe('/settings slash command', () => {
  // ── Bare display (currentView) ──

  it('bare /settings shows the refiner config in display', async () => {
    const { ctx } = makeCtx({
      autonomy: { refinerProvider: 'opencode-go', refinerModel: 'deepseek-v4-flash' },
    });
    const text = stripAnsi(
      ((await buildSettingsCommand(ctx).run!('')) as { message?: string })?.message ?? '',
    );
    expect(text).toContain('refiner-provider:           opencode-go');
    expect(text).toContain('refiner-model:              deepseek-v4-flash');
  });

  it('bare /settings shows the new UX toggles', async () => {
    const { ctx } = makeCtx();
    const text = stripAnsi(
      ((await buildSettingsCommand(ctx).run!('')) as { message?: string })?.message ?? '',
    );
    expect(text).toContain('fleet chat:                 off');
    expect(text).toContain('completion chime:           off');
    expect(text).toContain('confirm before exit:        on');
  });

  it('bare /settings shows feature toggles', async () => {
    const { ctx } = makeCtx({ features: { mcp: false, plugins: false } });
    const text = stripAnsi(
      ((await buildSettingsCommand(ctx).run!('')) as { message?: string })?.message ?? '',
    );
    expect(text).toContain('MCP features:               off');
    expect(text).toContain('plugin features:            off');
    expect(text).toContain('memory features:            on');
    expect(text).toContain('skills features:            on');
    expect(text).toContain('models registry:            on');
  });

  it('bare /settings shows iteration/safety limits', async () => {
    const { ctx } = makeCtx();
    const text = stripAnsi(
      ((await buildSettingsCommand(ctx).run!('')) as { message?: string })?.message ?? '',
    );
    expect(text).toContain('max concurrent:             4');
    expect(text).toContain('max iterations:             default');
    expect(text).toContain('auto-proceed max iters:     unlimited');
  });

  it('bare /settings shows TUI visual settings', async () => {
    const { ctx } = makeCtx({
      autonomy: { thinkingWord: 'vibing', statuslineMode: 'minimum', animationStyle: 'wave' },
    });
    const text = stripAnsi(
      ((await buildSettingsCommand(ctx).run!('')) as { message?: string })?.message ?? '',
    );
    expect(text).toContain('thinking word:              vibing');
    expect(text).toContain('statusline mode:            minimum');
    expect(text).toContain('animation style:            wave');
  });

  it('bare /settings shows system toggles', async () => {
    const { ctx } = makeCtx({
      indexing: { onSessionStart: true },
      log: { level: 'debug' },
      session: { auditLevel: 'full' },
    });
    const text = stripAnsi(
      ((await buildSettingsCommand(ctx).run!('')) as { message?: string })?.message ?? '',
    );
    expect(text).toContain('index on start:             on');
    expect(text).toContain('log level:                  debug');
    expect(text).toContain('audit level:                full');
  });

  // ── Refiner subcommands ──

  it('refiner-provider persists autonomy.refinerProvider', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('refiner-provider opencode-go');
    expect(stripAnsi(res!.message!)).toContain('refiner-provider → opencode-go');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.refinerProvider).toBe('opencode-go');
  });

  it('refiner-model persists autonomy.refinerModel', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('refiner-model deepseek-v4-flash');
    expect(stripAnsi(res!.message!)).toContain('refiner-model → deepseek-v4-flash');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.refinerModel).toBe('deepseek-v4-flash');
  });

  it('refiner-clear clears both autonomy.refinerProvider and refinerModel', async () => {
    const { ctx, globalConfig } = makeCtx({
      autonomy: { refinerProvider: 'openai', refinerModel: 'gpt-4o-mini' },
    });
    const res = await buildSettingsCommand(ctx).run!('refiner-clear');
    expect(stripAnsi(res!.message!)).toContain('Refiner config cleared');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.refinerProvider).toBeUndefined();
    expect(written.autonomy.refinerModel).toBeUndefined();
  });

  it('refiner-provider shows current value on bare call', async () => {
    const { ctx } = makeCtx({ autonomy: { refinerProvider: 'anthropic' } });
    const res = await buildSettingsCommand(ctx).run!('refiner-provider');
    expect(stripAnsi(res!.message!)).toContain('Current: anthropic');
  });

  it('help lists the refiner subcommands', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('refiner-provider');
    expect(cmd.help).toContain('refiner-model');
    expect(cmd.help).toContain('refiner-clear');
  });

  // ── Stream-fleet (fleet-chat verbosity) ──

  it('stream-fleet off persists the enum', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('stream-fleet off');
    expect(stripAnsi(res!.message!)).toContain('fleet chat → off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.fleetChatVerbosity).toBe('off');
  });

  it('stream-fleet maps legacy "on" to full', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('stream-fleet on');
    expect(stripAnsi(res!.message!)).toContain('fleet chat → full');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.fleetChatVerbosity).toBe('full');
  });

  it('stream-fleet rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('stream-fleet maybe');
    expect(stripAnsi(res!.message!)).toContain('stream-fleet off|full');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the stream-fleet subcommand', () => {
    const { ctx } = makeCtx();
    expect(buildSettingsCommand(ctx).help).toContain('stream-fleet off|full');
  });

  // ── Chime ──

  it('chime persists autonomy.chime', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('chime on');
    expect(stripAnsi(res!.message!)).toContain('completion chime → on');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.chime).toBe(true);
  });

  // ── Confirm-exit ──

  it('confirm-exit persists autonomy.confirmExit', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('confirm-exit off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.confirmExit).toBe(false);
  });

  // ── MCP feature toggle ──

  it('mcp persists features.mcp', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('mcp off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.mcp).toBe(false);
  });

  it('plugins persists features.plugins', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('plugins off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.plugins).toBe(false);
  });

  it('memory persists features.memory', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('memory off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.memory).toBe(false);
  });

  it('skills persists features.skills', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('skills off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.skills).toBe(false);
  });

  it('models-registry persists features.modelsRegistry', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('models-registry off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.modelsRegistry).toBe(false);
  });

  it('feature toggles reject invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    for (const sub of ['mcp', 'plugins', 'memory', 'skills', 'models-registry']) {
      const res = await buildSettingsCommand(ctx).run!(sub + ' maybe');
      expect(stripAnsi(res!.message!)).toContain(sub + ' on|off');
    }
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the feature toggle subcommands', () => {
    const help = buildSettingsCommand(makeCtx().ctx).help!;
    for (const sub of ['mcp', 'plugins', 'memory', 'skills', 'models-registry']) {
      expect(help).toContain(sub);
    }
  });

  // ── Max-iterations ──

  it('max-iterations persists tools.maxIterations', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('max-iterations 300');
    expect(stripAnsi(res!.message!)).toContain('max iterations → 300');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.maxIterations).toBe(300);
  });

  it('max-iterations rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('max-iterations -1');
    expect(stripAnsi(res!.message!)).toContain('Invalid number');
    expect(existsSync(globalConfig)).toBe(false);
  });

  // ── Auto-proceed-max-iterations ──

  it('auto-proceed-max-iterations persists autonomy.autoProceedMaxIterations', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('auto-proceed-max-iterations 25');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.autoProceedMaxIterations).toBe(25);
  });

  // ── Index-on-start ──

  it('index-on-start persists indexing.onSessionStart', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('index-on-start off');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.indexing.onSessionStart).toBe(false);
  });

  // ── Log-level ──

  it('log-level persists log.level', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('log-level debug');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.log.level).toBe('debug');
  });

  it('log-level rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('log-level verbose');
    expect(stripAnsi(res!.message!)).toContain('log-level error|warn|info|debug|trace');
    expect(existsSync(globalConfig)).toBe(false);
  });

  // ── Audit-level ──

  it('audit-level persists session.auditLevel', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('audit-level minimal');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.session.auditLevel).toBe('minimal');
  });

  // ── Thinking-word ──

  it('thinking-word persists autonomy.thinkingWord', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('thinking-word vibing');
    expect(stripAnsi(res!.message!)).toContain('thinking word → vibing');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.thinkingWord).toBe('vibing');
  });

  it('thinking-word rejects empty input', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('thinking-word');
    expect(stripAnsi(res!.message!)).toContain('Usage');
  });

  // ── Statusline ──

  it('statusline persists autonomy.statuslineMode', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('statusline minimum');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.statuslineMode).toBe('minimum');
  });

  it('statusline rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('statusline compact');
    expect(stripAnsi(res!.message!)).toContain('statusline minimum|detailed|no-color');
    expect(existsSync(globalConfig)).toBe(false);
  });

  // ── Animation ──

  it('animation persists autonomy.animationStyle', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('animation pulse');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.animationStyle).toBe('pulse');
  });

  it('animation rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('animation sparkle');
    expect(stripAnsi(res!.message!)).toContain(
      'animation rainbow|wave|pulse|dots|breathe|static|cycle',
    );
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('animation accepts the static style (no-animation working chip)', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('animation static');
    expect(stripAnsi(res!.message!)).toContain('animation style → static');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.animationStyle).toBe('static');
  });

  // ── Help text for the new sections ──

  it('help lists all new subcommands', () => {
    const help = buildSettingsCommand(makeCtx().ctx).help!;
    for (const sub of [
      'stream-fleet',
      'chime',
      'confirm-exit',
      'max-iterations',
      'auto-proceed-max-iterations',
      'index-on-start',
      'log-level',
      'audit-level',
      'thinking-word',
      'statusline',
      'animation',
    ]) {
      expect(help).toContain(sub);
    }
  });
  it('bare /settings shows the semver default part (factory default: patch)', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('semver default part:        patch');
    expect(text).toContain('/settings semver-part');
  });

  it('view reflects a configured semver default part', async () => {
    const { ctx } = makeCtx({ extensions: { 'semver-bump': { defaultPart: 'minor' } } });
    const res = await buildSettingsCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('semver default part:        minor');
  });

  it('semver-part persists extensions["semver-bump"].defaultPart to the global config', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('semver-part minor');
    expect(stripAnsi(res!.message!)).toContain('semver default part → minor');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.extensions['semver-bump'].defaultPart).toBe('minor');
  });

  it('semver-part writes to the global config even when configScope is project', async () => {
    // extensions is not in PROJECT_SAFE_FIELDS — a project-scope write would
    // silently drop it, so the subcommand must always target the global file.
    const { ctx, globalConfig, inProjectConfig } = makeCtx({ configScope: 'project' });
    await buildSettingsCommand(ctx).run!('semver-part auto');

    expect(existsSync(inProjectConfig)).toBe(false);
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.extensions['semver-bump'].defaultPart).toBe('auto');
  });

  it('semver-part preserves other semver-bump options on update', async () => {
    const { ctx, globalConfig } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    await cmd.run!('semver-part minor');
    await cmd.run!('semver-part major');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.extensions['semver-bump'].defaultPart).toBe('major');
  });

  it('semver-part rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('semver-part bogus');
    expect(stripAnsi(res!.message!)).toContain('semver-part patch|minor|major|auto');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the semver-part subcommand', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('semver-part patch|minor|major|auto');
  });

  it('bare /settings shows filesystem access (default: unrestricted)', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('filesystem access:          unrestricted');
    expect(text).toContain('/settings fs-access unrestricted|project');
  });

  it('bare /settings shows materialized defaults and the active persistence target', async () => {
    const { ctx } = makeCtx({ configScope: 'project' });
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);

    expect(text).toContain('max concurrent:             4');
    expect(text).toContain('Persisted to <project>/.wrongstack/config.json');
  });

  it('view reflects a configured project-only filesystem scope', async () => {
    const { ctx } = makeCtx({ tools: { restrictToProjectRoot: true } });
    const res = await buildSettingsCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('filesystem access:          project');
  });

  it('fs-access project persists tools.restrictToProjectRoot=true', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('fs-access project');
    expect(stripAnsi(res!.message!)).toContain('filesystem access → project');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(true);
  });

  it('fs-access unrestricted persists tools.restrictToProjectRoot=false', async () => {
    const { ctx, globalConfig } = makeCtx({ tools: { restrictToProjectRoot: true } });
    await buildSettingsCommand(ctx).run!('fs-access unrestricted');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(false);
  });

  it('fs-access rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('fs-access bogus');
    expect(stripAnsi(res!.message!)).toContain('fs-access unrestricted|project');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the fs-access subcommand', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('fs-access unrestricted|project');
  });

  it('token-saving persists features.tokenSavingMode', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('token-saving light');
    expect(stripAnsi(res!.message!)).toContain('token-saving → light');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.tokenSavingMode).toBe('light');
  });

  it('bare /settings shows the circuit breaker (default: off)', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('circuit breaker:            off');
    expect(text).toContain('/settings breaker on|off');
  });

  it('view reflects an enabled circuit breaker with its timeout', async () => {
    const { ctx } = makeCtx({ circuitBreaker: { enabled: true, autoKillResetMs: 45_000 } });
    const res = await buildSettingsCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('circuit breaker:            on');
  });

  it('breaker on persists circuitBreaker.enabled=true', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('breaker on');
    expect(stripAnsi(res!.message!)).toContain('circuit breaker → on');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.circuitBreaker.enabled).toBe(true);
  });

  it('breaker-timeout persists circuitBreaker.autoKillResetMs', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('breaker-timeout 90');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.circuitBreaker.autoKillResetMs).toBe(90_000);
  });

  it('breaker-timeout rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('breaker-timeout abc');
    expect(stripAnsi(res!.message!)).toContain('Invalid number');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the breaker subcommands', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('breaker on|off');
    expect(cmd.help).toContain('breaker-timeout');
  });

  it('title-animation off persists autonomy.terminalTitleAnimation (NOT top-level titleAnimation)', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('title-animation off');
    expect(stripAnsi(res!.message!)).toContain('title animation → off');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    // Canonical key — the one execution.ts reads and the TUI picker writes.
    expect(written.autonomy.terminalTitleAnimation).toBe(false);
    // The old broken key must NOT be written.
    expect(written.titleAnimation).toBeUndefined();
  });

  it('view reflects title animation (default on) and disabled state', async () => {
    const onCtx = makeCtx();
    const onRes = await buildSettingsCommand(onCtx.ctx).run!('');
    expect(stripAnsi(onRes!.message!)).toContain('title animation:            on');

    const offCtx = makeCtx({ autonomy: { terminalTitleAnimation: false } });
    const offRes = await buildSettingsCommand(offCtx.ctx).run!('');
    expect(stripAnsi(offRes!.message!)).toContain('title animation:            off');
  });
});
