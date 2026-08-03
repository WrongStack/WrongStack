import { describe, expect, it } from 'vitest';
import {
  allServers,
  awsServer,
  blockServer,
  braveSearchServer,
  codebaseIndexServer,
  context7Server,
  everArtServer,
  filesystemServer,
  githubServer,
  googleMapsServer,
  kanbanServer,
  mailboxServer,
  miniMaxVisionServer,
  playwrightServer,
  requirementIntakeServer,
  sentinelServer,
  sshManagerServer,
  slackServer,
  zaiVisionServer,
} from '../../src/infrastructure/mcp-servers.js';
import type { MCPServerConfig } from '../../src/types/config.js';

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
    ['context7', context7Server],
    ['brave-search', braveSearchServer],
    ['block', blockServer],
    ['everart', everArtServer],
    ['slack', slackServer],
    ['aws', awsServer],
    ['google-maps', googleMapsServer],
    ['sentinel', sentinelServer],
    ['zai-vision', zaiVisionServer],
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
});
