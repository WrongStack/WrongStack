import type { MCPServerConfig } from '@wrongstack/contracts/types/config';
import { describe, expect, it } from 'vitest';
import {
  allServers,
  awsServer,
  blockServer,
  braveSearchServer,
  codebaseIndexServer,
  context7Server,
  dockerServer,
  everArtServer,
  fetchServer,
  filesystemServer,
  githubServer,
  gitlabServer,
  gitServer,
  googleMapsServer,
  kanbanServer,
  mailboxServer,
  memoryServer,
  miniMaxVisionServer,
  playwrightServer,
  postgresServer,
  puppeteerServer,
  requirementIntakeServer,
  sentinelServer,
  sentryServer,
  sequentialThinkingServer,
  slackServer,
  sqliteServer,
  sshManagerServer,
  zaiVisionServer,
  zaiWebReaderServer,
  zaiWebSearchServer,
} from '../../src/infrastructure/mcp-servers.js';

/**
 * V0-D: every built-in MCP preset returns a config that passes the
 * minimum shape the registry requires. We don't try to validate every
 * field — that's the registry's job — but we pin the contract that
 * matters: name, transport, and the transport-specific required keys.
 */

const VALID_TRANSPORTS = new Set<MCPServerConfig['transport']>(['stdio', 'sse', 'streamable-http']);

function assertValidShape(cfg: MCPServerConfig): void {
  expect(typeof cfg.name).toBe('string');
  expect(cfg.name.length).toBeGreaterThan(0);
  expect(VALID_TRANSPORTS.has(cfg.transport)).toBe(true);

  if (cfg.transport === 'stdio') {
    expect(cfg.command, `${cfg.name} stdio: command must be set`).toBeTruthy();
  } else {
    expect(cfg.url, `${cfg.name} ${cfg.transport}: url must be set`).toBeTruthy();
  }

  // Permission must be one of the known kinds (the registry will reject
  // an unknown value at boot, but it's cheaper to catch it here too).
  if (cfg.permission !== undefined) {
    expect(['auto', 'confirm', 'deny']).toContain(cfg.permission);
  }
}

describe('built-in MCP server presets (V0-D)', () => {
  const presets: Array<[string, () => MCPServerConfig]> = [
    ['filesystem', filesystemServer],
    ['github', githubServer],
    ['gitlab', gitlabServer],
    ['postgres', postgresServer],
    ['sqlite', sqliteServer],
    ['git', gitServer],
    ['memory', memoryServer],
    ['sequential-thinking', sequentialThinkingServer],
    ['puppeteer', puppeteerServer],
    ['docker', dockerServer],
    ['fetch', fetchServer],
    ['sentry', sentryServer],
    ['context7', context7Server],
    ['brave-search', braveSearchServer],
    ['block', blockServer],
    ['everart', everArtServer],
    ['slack', slackServer],
    ['aws', awsServer],
    ['google-maps', googleMapsServer],
    ['sentinel', sentinelServer],
    ['zai-vision', zaiVisionServer],
    ['zai-web-search', zaiWebSearchServer],
    ['zai-web-reader', zaiWebReaderServer],
    ['minimax-vision', miniMaxVisionServer],
    ['playwright', playwrightServer],
    ['ssh', sshManagerServer],
    ['requirement-intake', requirementIntakeServer],
    ['kanban', kanbanServer],
    ['mailbox', mailboxServer],
    ['codebase-index', codebaseIndexServer],
  ];

  for (const [label, factory] of presets) {
    it(`${label} returns a valid MCPServerConfig`, () => {
      assertValidShape(factory());
    });
  }

  it('factories are pure — calling twice yields equivalent (but distinct) objects', () => {
    const a = filesystemServer();
    const b = filesystemServer();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('allServers() returns every preset keyed by config.name', () => {
    const all = allServers();
    const names = Object.keys(all).sort();
    expect(names).toContain('filesystem');
    expect(names).toContain('github');
    expect(names).toContain('context7');
    expect(names).toContain('zai-vision');
    expect(names).toContain('zai-web-search');
    expect(names).toContain('zai-web-reader');
    expect(names).toContain('minimax-vision');
    expect(names).toContain('playwright');
    expect(names).toContain('ssh');
    expect(names).toContain('requirement-intake');
    expect(names).toContain('kanban');
    expect(names).toContain('mailbox');
    expect(names).toContain('codebase-index');
    // Each entry's key matches its config.name.
    for (const [key, cfg] of Object.entries(all)) {
      expect(key).toBe(cfg.name);
      assertValidShape(cfg);
    }
  });

  it('vision presets are read-only adapter candidates by default', () => {
    const zai = zaiVisionServer();
    expect(zai.permission).toBe('auto');
    expect(zai.allowedTools).toContain('image_analysis');
    expect(zai.allowedTools).toContain('diagnose_error_screenshot');

    const minimax = miniMaxVisionServer();
    expect(minimax.permission).toBe('auto');
    expect(minimax.command).toBe('uvx');
    expect(minimax.allowedTools).toEqual(['understand_image']);
  });

  it('every preset shipped without enabled:true so adoption stays opt-in', () => {
    // It's fine for `enabled` to be undefined, but it must NOT be true by default.
    for (const [label, factory] of presets) {
      const cfg = factory();
      expect(cfg.enabled, `${label} must not default to enabled:true`).not.toBe(true);
    }
  });

  it('project-scoped presets satisfy their child CLI required flags', () => {
    // The shape contract above cannot detect a dead-on-arrival preset: a
    // preset whose args the spawned binary rejects at startup (e.g. the
    // mailbox CLI exits 2 without --actor). Pin each project-scoped
    // binary's mandatory flags here.
    const REQUIRED_ARGS: Record<string, string[]> = {
      'requirement-intake': ['--project-root'],
      kanban: ['--project-root'],
      mailbox: ['--project-root', '--actor'],
      'codebase-index': ['--project-root'],
    };
    const served = new Set<string>();
    for (const [label, factory] of presets) {
      const cfg = factory();
      // Project servers launch as `wstack mcp serve <name>`.
      const [sub, verb, server] = cfg.args ?? [];
      const required =
        cfg.command === 'wstack' && sub === 'mcp' && verb === 'serve' && server
          ? REQUIRED_ARGS[server]
          : undefined;
      if (!required) continue;
      served.add(server as string);
      const args = cfg.args ?? [];
      for (const flag of required) {
        expect(args, `${label}: preset args must include required flag ${flag}`).toContain(flag);
      }
    }
    // Every project preset goes through `wstack`: the separate `wstack-*-mcp`
    // bins are absent from the standalone binary, so naming one breaks there.
    expect([...served].sort()).toEqual(Object.keys(REQUIRED_ARGS).sort());
    for (const [label, factory] of presets) {
      expect(factory().command ?? '', label).not.toMatch(/^wstack-.+-mcp$/);
    }
  });

  it('no preset embeds process.env API keys — prevents plaintext leakage to config files', () => {
    // Presets must not read process.env at definition time. API keys
    // should be configured by the user (encrypted via vault) and passed
    // to MCP child processes through buildChildEnv's `extra` merge.
    const secretPattern = /(?:KEY|TOKEN|SECRET|PASSWORD|PWD)/i;
    for (const [label, factory] of presets) {
      const cfg = factory();
      if (!cfg.env) continue;
      for (const [key, value] of Object.entries(cfg.env)) {
        // Non-empty values that look like they came from process.env are a leak.
        // Static defaults (like 'ZAI', 'url', paths) are fine.
        if (value && secretPattern.test(key)) {
          expect(
            value,
            `${label}: env.${key} looks like a secret — presets must not embed process.env values`,
          ).toBe('');
        }
      }
    }
  });

  /**
   * security-check 2026-09-17 (DEP-NOTE-001).
   *
   * `npx`/`uvx` resolve a preset's package at every server start, so a floating
   * tag executes whatever was published most recently — outside
   * `pnpm-lock.yaml` and outside the `minimumReleaseAge: 1440` cooldown that
   * SECURITY.md calls the single most effective defence against a
   * compromised-maintainer publish.
   *
   * Enumerated over every preset rather than grepped as a pattern, so a NEW
   * preset that reintroduces a floating tag fails here too.
   */
  it('no preset pins a floating version tag', () => {
    const floating = /@(?:latest|next|canary|beta|alpha)$/;
    for (const [label, factory] of presets) {
      for (const arg of factory().args ?? []) {
        expect(
          floating.test(arg),
          `${label}: "${arg}" is a floating tag — pin an exact version (it bypasses the lockfile and the install cooldown)`,
        ).toBe(false);
      }
    }
  });

  it('the presets added in 2026-09 require confirmation before running', () => {
    // `fetch` is the load-bearing one: mcp-server-fetch performs arbitrary URL
    // fetches WITHOUT the SSRF controls in tools/src/_fetch-guard.ts that the
    // built-in `fetch` tool is held to, so running it unprompted would be a
    // cleaner egress path than the guarded tool it resembles.
    expect(fetchServer().permission).toBe('confirm');
    expect(memoryServer().permission).toBe('confirm');
    expect(sequentialThinkingServer().permission).toBe('confirm');
  });
});
