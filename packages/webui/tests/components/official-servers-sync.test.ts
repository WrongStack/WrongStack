/**
 * The WebUI "Recommended" MCP list is a hand-kept copy of the core presets
 * (a browser bundle cannot import the node-side preset module). Nothing kept
 * the two in step: by 2026-09-18 three WebUI entries pointed at npm packages
 * that do not exist (`@modelcontextprotocol/server-playwright`, `-aws`,
 * `-block`), so "Add" installed a server that could never start, and the
 * playwright entry had missed the version pin core took in security-check
 * 2026-09-17. Whatever `npx -y` will execute must be identical on both sides.
 */

import type { MCPServerConfig } from '@wrongstack/contracts/types';
import * as corePresets from '@wrongstack/core/infrastructure';
import { describe, expect, it } from 'vitest';
import { OFFICIAL_SERVERS } from '../../src/components/SettingsPanel/official-servers.js';

function corePresetsByName(): Map<string, MCPServerConfig> {
  const byName = new Map<string, MCPServerConfig>();
  for (const [exportName, value] of Object.entries(corePresets)) {
    if (!/Server$/.test(exportName) || typeof value !== 'function' || value.length !== 0) continue;
    let preset: unknown;
    try {
      preset = (value as () => unknown)();
    } catch {
      continue;
    }
    if (
      preset &&
      typeof preset === 'object' &&
      typeof (preset as { name?: unknown }).name === 'string'
    ) {
      const cfg = preset as MCPServerConfig;
      byName.set(cfg.name, cfg);
    }
  }
  return byName;
}

describe('WebUI official MCP servers stay in step with the core presets', () => {
  const core = corePresetsByName();

  it('found the core presets it is comparing against', () => {
    expect(core.size).toBeGreaterThan(10);
  });

  it.each(OFFICIAL_SERVERS.map((s) => [s.name, s] as const))(
    '%s launches exactly what the core preset launches',
    (name, webui) => {
      const preset = core.get(name);
      expect(
        preset,
        `no core preset named "${name}" — add one or drop the WebUI entry`,
      ).toBeDefined();
      if (!preset) return;
      expect({
        transport: webui.transport,
        command: webui.command,
        args: webui.args,
        url: webui.url,
        bearerTokenEnv: webui.bearerTokenEnv,
      }).toEqual({
        transport: preset.transport,
        command: preset.command,
        args: preset.args,
        url: preset.url,
        bearerTokenEnv: preset.bearerTokenEnv,
      });
    },
  );

  it('never launches a floating @latest tag', () => {
    for (const server of OFFICIAL_SERVERS) {
      for (const arg of server.args ?? []) expect(arg).not.toMatch(/@latest$/);
    }
  });
});
