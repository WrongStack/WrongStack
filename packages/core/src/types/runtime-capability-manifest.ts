/**
 * Stable runtime capabilities for roster agents and prompt contracts.
 *
 * Agent definitions refer to these capability ids; concrete tool names remain
 * an implementation detail of the active host. Optional providers (MCP,
 * browser automation, plugins) are represented by their stable gateway tools
 * instead of server-specific names.
 */
export type RuntimeCapabilityPack =
  | 'core'
  | 'development'
  | 'memory'
  | 'fleet'
  | 'browser'
  | 'mcp'
  | 'admin';

export type RuntimeCapabilityExposure = 'direct' | 'on-demand' | 'internal';

export interface RuntimeCapabilityDefinition {
  id: string;
  pack: RuntimeCapabilityPack;
  exposure: RuntimeCapabilityExposure;
  tools: readonly string[];
  aliases?: Readonly<Record<string, string>> | undefined;
}

const PLAYWRIGHT_ALIASES = {
  playwright_navigate: 'browser_navigate',
  playwright_screenshot: 'browser_screenshot',
  playwright_click: 'browser_click',
  playwright_type: 'browser_type',
  playwright_evaluate: 'browser_evaluate',
  playwright_select_option: 'browser_select',
  playwright_hover: 'browser_hover',
  playwright_fill_form: 'browser_type',
  playwright_wait_for: 'browser_wait',
  playwright_press_key: 'browser_press',
  playwright_drag: 'browser_drag',
} as const;

export const RUNTIME_CAPABILITY_MANIFEST = [
  {
    id: 'filesystem.read',
    pack: 'core',
    exposure: 'direct',
    tools: ['read', 'grep', 'glob', 'tree'],
  },
  {
    id: 'code.inspect',
    pack: 'core',
    exposure: 'direct',
    tools: [
      'codebase-stats',
      'codebase-search',
      'codebase-incoming-calls',
      'codebase-outgoing-calls',
      'codebase-index',
      'codebase-skeleton',
      'codebase-repo-map',
      'codebase-impact-analysis',
      'codebase-invariant-check',
      'dead-code-scan',
      'diff',
      'json',
      'logs',
    ],
  },
  {
    id: 'filesystem.write',
    pack: 'development',
    exposure: 'direct',
    tools: ['write', 'edit', 'replace', 'patch', 'codebase-ast-replace'],
  },
  {
    id: 'execution.shell',
    pack: 'development',
    exposure: 'direct',
    tools: ['bash', 'exec', 'pwsh', 'language', 'language_info', 'language_package'],
  },
  {
    id: 'verification.run',
    pack: 'development',
    exposure: 'direct',
    tools: ['lint', 'format', 'typecheck', 'test', 'e2e_plan', 'codebase-targeted-test'],
  },
  {
    id: 'version-control.manage',
    pack: 'development',
    exposure: 'direct',
    tools: ['git'],
  },
  {
    id: 'dependencies.manage',
    pack: 'development',
    exposure: 'on-demand',
    tools: ['install', 'outdated', 'audit'],
  },
  {
    id: 'documentation.author',
    pack: 'development',
    exposure: 'on-demand',
    tools: ['document', 'design', 'scaffold'],
  },
  {
    id: 'web.research',
    pack: 'core',
    exposure: 'direct',
    tools: ['search', 'fetch'],
  },
  {
    id: 'work.plan',
    pack: 'core',
    exposure: 'direct',
    tools: ['todo', 'plan', 'task', 'kanban', 'nextsteps'],
  },
  {
    id: 'coordination.mailbox',
    pack: 'fleet',
    exposure: 'direct',
    // `session_note` sits beside mailbox rather than in its own capability:
    // both are "one agent speaks to another". The split that matters is
    // durability — mailbox persists and crosses sessions, a note is
    // in-process and dies with the session — and that is a property of the
    // tool, not of who is allowed to talk.
    tools: ['mailbox', 'mail_send', 'mail_inbox', 'fleet_status', 'session_note'],
  },
  {
    id: 'fleet.delegate',
    pack: 'fleet',
    exposure: 'on-demand',
    tools: [
      'delegate',
      'spawn_subagent',
      'assign_task',
      'kanban_queue',
      'await_tasks',
      'ask_subagent',
      'ask_result',
      'roll_up',
      'quality_gate',
      'terminate_subagent',
      'terminate_all',
      'work_complete',
      'collab_debug',
      'fleet_emit',
      'fleet',
    ],
  },
  {
    id: 'reasoning.oneshot',
    pack: 'core',
    exposure: 'on-demand',
    tools: ['llm', 'council'],
  },
  {
    id: 'memory.manage',
    pack: 'memory',
    exposure: 'on-demand',
    tools: ['remember', 'search_memory', 'find_related_memories', 'forget'],
  },
  {
    id: 'memory.curate',
    pack: 'memory',
    exposure: 'on-demand',
    tools: [
      'memory_candidates',
      'memory_update',
      'memory_delete',
      'memory_recover',
      'memory_backfill_recoverable',
      'memory_for_file',
      'memory_for_path',
      'memory_search',
      'memory_graph',
      'memory_gather_batch',
      'memory_verify',
      'memory_hygiene',
    ],
  },
  {
    id: 'browser.interact',
    pack: 'browser',
    exposure: 'on-demand',
    tools: [
      'browser_open',
      'browser_status',
      'browser_list',
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_hover',
      'browser_drag',
      'browser_wait',
      'browser_evaluate',
      'browser_upload',
      'browser_close',
    ],
    aliases: PLAYWRIGHT_ALIASES,
  },
  {
    id: 'mcp.dynamic',
    pack: 'mcp',
    exposure: 'on-demand',
    tools: ['mcp_use'],
  },
  {
    id: 'automation.manage',
    pack: 'admin',
    exposure: 'on-demand',
    tools: ['cron_schedule', 'cron_list', 'cron_cancel', 'watch_start', 'watch_list', 'watch_stop'],
  },
  {
    id: 'context.pin',
    pack: 'admin',
    exposure: 'on-demand',
    tools: ['pin_add', 'pin_list', 'pin_remove'],
  },
  {
    id: 'quality.analyze',
    pack: 'development',
    exposure: 'on-demand',
    tools: [
      'dead_code_scan',
      'detect_duplicate_code',
      'secret_scanner_test',
      'error_lens_history',
      'security-ast-scan',
    ],
  },
  {
    id: 'release.manage',
    pack: 'development',
    exposure: 'on-demand',
    tools: ['git_autocommit', 'semver_current', 'semver_bump', 'semver_changelog'],
  },
  {
    id: 'messaging.telegram',
    pack: 'fleet',
    exposure: 'on-demand',
    tools: ['telegram_send', 'telegram_read', 'telegram_approve'],
  },
  {
    id: 'tools.discover',
    pack: 'admin',
    exposure: 'direct',
    tools: ['tool_search', 'tool_use', 'tool_help', 'batch_tool_use', 'clarify'],
  },
  {
    id: 'runtime.admin',
    pack: 'admin',
    exposure: 'internal',
    tools: ['set_working_dir', 'context_manager', 'mode', 'skill', 'mcp_control'],
  },
] as const satisfies readonly RuntimeCapabilityDefinition[];

export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_MANIFEST)[number]['id'];

const CAPABILITY_BY_ID = new Map<string, RuntimeCapabilityDefinition>(
  RUNTIME_CAPABILITY_MANIFEST.map((definition) => [definition.id, definition]),
);

const CAPABILITY_BY_TOOL = new Map<string, RuntimeCapabilityId>();
const TOOL_ALIASES = new Map<string, string>();
for (const definition of RUNTIME_CAPABILITY_MANIFEST as readonly RuntimeCapabilityDefinition[]) {
  for (const tool of definition.tools) {
    CAPABILITY_BY_TOOL.set(tool, definition.id as RuntimeCapabilityId);
  }
  for (const [alias, tool] of Object.entries(definition.aliases ?? {})) {
    TOOL_ALIASES.set(alias, tool);
  }
}

export function toolsForRuntimeCapabilities(
  capabilityIds: readonly RuntimeCapabilityId[],
): string[] {
  return [
    ...new Set(
      capabilityIds.flatMap((id) => {
        const definition = CAPABILITY_BY_ID.get(id);
        if (!definition) throw new Error(`Unknown runtime capability: "${id}"`);
        return definition.tools;
      }),
    ),
  ];
}

export function normalizeRuntimeToolName(name: string): string {
  return TOOL_ALIASES.get(name) ?? name;
}

export function runtimeCapabilityForTool(name: string): RuntimeCapabilityId | undefined {
  return CAPABILITY_BY_TOOL.get(normalizeRuntimeToolName(name));
}

export function isKnownRuntimeCapability(id: string): id is RuntimeCapabilityId {
  return CAPABILITY_BY_ID.has(id);
}

export function inferRuntimeCapabilities(toolNames: readonly string[]): RuntimeCapabilityId[] {
  const ids = new Set<RuntimeCapabilityId>();
  for (const rawName of toolNames) {
    const id = runtimeCapabilityForTool(rawName);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function missingRuntimeCapabilities(
  required: readonly string[] | undefined,
  toolNames: readonly string[],
): string[] {
  if (!required || required.length === 0) return [];
  const available = new Set<string>(inferRuntimeCapabilities(toolNames));
  return required.filter((id) => !CAPABILITY_BY_ID.has(id) || !available.has(id));
}

export function missingRequiredRuntimeTools(
  required: readonly string[] | undefined,
  toolNames: readonly string[],
): string[] {
  if (!required || required.length === 0) return [];
  const available = new Set(toolNames.map(normalizeRuntimeToolName));
  return required
    .map(normalizeRuntimeToolName)
    .filter((name) => !CAPABILITY_BY_TOOL.has(name) || !available.has(name));
}

/**
 * Extract tool-shaped references from skill/instruction prose. Canonical names
 * are recognized anywhere inside inline code. Unknown names are included only
 * when the prose presents them imperatively or explicitly calls them a tool,
 * avoiding false positives for ordinary APIs and config fields.
 */
export function runtimeToolReferencesFromText(text: string): string[] {
  const references = new Set<string>();
  for (const match of text.matchAll(/`([a-z][a-z0-9_-]+)`/gi)) {
    const name = normalizeRuntimeToolName(match[1] ?? '');
    if (CAPABILITY_BY_TOOL.has(name)) references.add(name);
  }
  for (const pattern of [
    /\b(?:call|use|invoke|run)\s+`([a-z][a-z0-9_-]+)`/gi,
    /`([a-z][a-z0-9_-]+)`\s+tool\b/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      references.add(normalizeRuntimeToolName(match[1] ?? ''));
    }
  }
  return [...references];
}

export function isDeprecatedRuntimeToolAlias(name: string): boolean {
  return TOOL_ALIASES.has(name) || name.startsWith('mcp__');
}
