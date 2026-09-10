// ---------------------------------------------------------------------------
// Combined plugin audit catalog — single source of truth.
//
// The *official* (published) plugin audit entries are generated into
// `../audit/index.js` by scripts/generate-plugin-projections.mjs. The
// *host-owned* plugins below are bundled by the CLI host and are NOT
// published by @wrongstack/plugins, so they cannot live in the generated
// file. This hand-maintained module joins the two into one frozen catalog
// that both the CLI plugin manager (`/plugin`, `plugin_manager` tool) and
// the WebUI settings panel consume, so the two surfaces can never drift.
//
// Pure data only — no node: imports — so the WebUI browser bundle can
// import the `./plugin-audit-catalog` subpath without pulling in any
// plugin factory code.
//
// Lives at `src/plugin-audit-catalog/index.ts` (not a flat file) because
// scripts/build-package.mjs `pluginEntries()` maps every `./<name>` export
// subpath to the `src/<name>/index.ts` entry convention shared by `./audit`,
// `./manifest`, and every per-plugin subpath.
// ---------------------------------------------------------------------------

import { OFFICIAL_PLUGIN_AUDIT_ENTRIES } from '../audit/index.js';

export interface PluginAuditEntry {
  name: string;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  defaultState: 'active' | 'inactive';
  canDisable: boolean;
}

/**
 * Host-owned plugins that are not published by @wrongstack/plugins.
 * Mirrors the entries the CLI host previously defined inline in
 * `packages/cli/src/plugin-management.ts`.
 */
export const HOST_PLUGIN_AUDIT_ENTRIES: readonly PluginAuditEntry[] = [
  {
    name: 'wstack-prompts',
    risk: 'medium',
    summary: 'Prompt library and prompt authoring commands.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'wstack-sync',
    risk: 'medium',
    summary: 'Cloud sync commands for prompts, skills, settings, memory, and history.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'wstack-cloud-config-sync',
    risk: 'medium',
    summary: 'my.wrongstack.com config synchronization over the namespaced sync API.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'wstack-chimera',
    risk: 'medium',
    summary: 'Spawns a post-session code review subagent when explicitly enabled.',
    defaultState: 'inactive',
    canDisable: true,
  },
  {
    name: 'wstack-auto-review',
    risk: 'medium',
    summary: 'Tracks changed files and requests bounded mid-session Chimera reviews.',
    defaultState: 'inactive',
    canDisable: true,
  },
  {
    name: 'wstack-specialist-triggers',
    risk: 'medium',
    summary: 'Spawns roster specialists when files matching their patterns change.',
    defaultState: 'inactive',
    canDisable: true,
  },
  {
    name: 'wstack-skills',
    risk: 'medium',
    summary: 'Skill library, authoring, install, update, and uninstall commands.',
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: '@wrongstack/plug-lsp',
    risk: 'medium',
    summary: 'Language Server Protocol tools and slash commands.',
    // Active by default: with `autoStart: 'lazy'` nothing is spawned until a
    // file of a matching language is touched, and auto-discovery only adopts
    // servers from the user's own environment — never from the opened
    // repository. That second clause used to read "already installed on the
    // machine", which was wrong: the resolver preferred
    // `<repo>/node_modules/.bin` over PATH on an existence check alone, so a
    // cloned repo could supply the executable and have it spawned unprompted
    // (WS-SEC-01). Provenance is now decided by where the binary lives; see
    // `plug-lsp/src/utils/command-resolver.ts`. Disable the plugin with
    // `{ name: 'lsp', enabled: false }` in config.plugins.
    defaultState: 'active',
    canDisable: true,
  },
  {
    name: 'telegram',
    risk: 'medium',
    summary: 'Telegram bridge for messages, approvals, and notifications.',
    defaultState: 'inactive',
    canDisable: true,
  },
] as const;

/**
 * Every plugin the host knows about: host-owned first (preserving the CLI's
 * historical ordering), then the generated official catalog. Frozen so no
 * consumer can mutate the shared catalog at runtime.
 */
export const PLUGIN_AUDIT_ENTRIES: readonly PluginAuditEntry[] = Object.freeze([
  ...HOST_PLUGIN_AUDIT_ENTRIES,
  ...OFFICIAL_PLUGIN_AUDIT_ENTRIES,
]);
