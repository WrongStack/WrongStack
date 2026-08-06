import type { PluginDetail } from './plugin-details';
import type { PluginCatalogEntry } from './runtime-catalog';

export type PluginLlmMode = 'deterministic' | 'optional' | 'provider-wire' | 'core-orchestrated';

export interface PluginLlmProfile {
  mode: PluginLlmMode;
  label: string;
  summary: string;
  routing: string;
  fallback: string;
}

interface DeclaredLlmProfile extends Omit<PluginLlmProfile, 'label'> {}

const llmProfiles: Record<string, DeclaredLlmProfile> = {
  'wstack-prompts': {
    mode: 'core-orchestrated',
    summary: 'Prompt generation can run an AI-guided authoring interview through the host runtime.',
    routing: 'Uses the active session provider and host-owned credentials.',
    fallback: 'Browsing and rendering saved prompts remain deterministic.',
  },
  'wstack-chimera': {
    mode: 'core-orchestrated',
    summary: 'A post-session event asks the host to spawn a dedicated review subagent.',
    routing:
      'Provider and model can be configured for the review without changing the leader model.',
    fallback:
      'No review is spawned when disabled, outside Git, or when the session changed no files.',
  },
  'wstack-auto-review': {
    mode: 'core-orchestrated',
    summary:
      'A mid-session file-change watcher asks the host to dispatch a bounded review subagent.',
    routing:
      'Provider and model can be configured for the review without changing the leader model.',
    fallback:
      'No review fires when disabled, outside Git, or when the quiet window sees no changes.',
  },
  'wstack-skills': {
    mode: 'core-orchestrated',
    summary:
      'Skill authoring can use an AI-guided workflow while install, update and discovery stay explicit.',
    routing:
      'Generation follows the active host provider; registry and filesystem operations do not.',
    fallback: 'Existing skills remain searchable and loadable without model access.',
  },
  'auto-doc': {
    mode: 'optional',
    summary: 'The LLM can replace placeholder prose with bounded JSDoc/TSDoc descriptions.',
    routing: 'Uses api.llm and supports a per-plugin provider/model override.',
    fallback: 'Deterministic entity detection and placeholder documentation are always retained.',
  },
  'git-autocommit': {
    mode: 'optional',
    summary: 'The LLM can draft a conventional commit subject from the staged diff.',
    routing: 'Uses api.llm; credentials never enter the plugin.',
    fallback:
      'The caller can provide type, scope and message explicitly when generation is unavailable.',
  },
  'changelog-writer': {
    mode: 'optional',
    summary: 'Collected changelog facts can be polished into user-facing wording.',
    routing: 'Uses api.llm only when polishing is requested.',
    fallback: 'The deterministic Keep-a-Changelog block remains authoritative.',
  },
  'commit-validator': {
    mode: 'optional',
    summary: 'An invalid subject can receive a one-line LLM correction suggestion.',
    routing: 'Uses api.llm after deterministic conventional-commit validation.',
    fallback: 'Validation and enforcement never depend on the model response.',
  },
  'dep-guard': {
    mode: 'optional',
    summary:
      'The LLM can review a suspected typosquat after deterministic similarity checks flag it.',
    routing: 'Uses api.llm as a second opinion, not as the install policy engine.',
    fallback: 'Deny lists, package-name validation and warnings remain deterministic.',
  },
  'error-lens': {
    mode: 'optional',
    summary: 'New failure digests can include a concise LLM-generated fix hint.',
    routing: 'Uses api.llm with bounded output and per-plugin routing.',
    fallback: 'Error extraction, stack-frame filtering and repeat detection remain deterministic.',
  },
  'migration-planner': {
    mode: 'optional',
    summary: 'The LLM adds a separate, evidence-bounded risk and verification analysis.',
    routing: 'Uses api.llm with JSON output; changelog text is treated as untrusted evidence.',
    fallback: 'Parsed breaking changes and the deterministic checklist stay authoritative.',
  },
  'pr-drafter': {
    mode: 'optional',
    summary: 'The LLM can turn session facts into a pull-request title and narrative.',
    routing: 'Uses api.llm and follows the plugin-specific route when configured.',
    fallback: 'A deterministic draft can still be assembled from commits and changed files.',
  },
  'release-notes-generator': {
    mode: 'optional',
    summary: 'The LLM can rewrite grouped commits for users, developers or operators.',
    routing: 'Uses api.llm and validates that every short commit hash survives the rewrite.',
    fallback: 'Any missing hash or invalid response restores deterministic grouped notes.',
  },
  'session-recap': {
    mode: 'optional',
    summary: 'A natural-language summary can be prepended to the factual session recap.',
    routing: 'Uses api.llm without exposing mailbox or provider credentials.',
    fallback: 'Usage, tool, commit and transcript-tail facts are still posted without AI.',
  },
  'test-generator': {
    mode: 'optional',
    summary: 'The LLM can author behavior-focused tests from bounded source context.',
    routing: 'Uses api.llm with cancellation and source-as-untrusted-data instructions.',
    fallback: 'Framework-correct Vitest, Jest or node:test skeletons are always available.',
  },
  'llm-cache': {
    mode: 'provider-wire',
    summary: 'Wraps deterministic provider calls and can return an exact safe cache match.',
    routing: 'It intercepts the session provider runner; it does not make a side LLM call.',
    fallback: 'Cache misses and unsafe requests pass through to the original provider.',
  },
  'model-router': {
    mode: 'provider-wire',
    summary: 'Selects a model from declarative size and tool-use rules for each provider call.',
    routing: 'Wraps the provider runner and changes only the effective model.',
    fallback: 'Unmatched requests retain the session model.',
  },
  'prompt-firewall': {
    mode: 'provider-wire',
    summary: 'Inspects provider-bound content for credential leaks before transport.',
    routing: 'Runs on the provider wire before the selected model sees the request.',
    fallback: 'Configured warn, redact or block policy is deterministic.',
  },
  'auto-escalate': {
    mode: 'provider-wire',
    summary: 'Moves to the next configured model after classified transient provider errors.',
    routing: 'Participates in the provider recovery path and preserves bounded escalation order.',
    fallback: 'Non-transient and exhausted errors return to the normal host recovery flow.',
  },
  'token-throttle': {
    mode: 'provider-wire',
    summary: 'Delays provider calls against a rolling tokens-per-minute window.',
    routing: 'Wraps calls without changing prompts, credentials or selected models.',
    fallback: 'Disabling the plugin restores the unwrapped provider path.',
  },
};

const llmLabels: Record<PluginLlmMode, string> = {
  deterministic: 'Deterministic',
  optional: 'Optional api.llm',
  'provider-wire': 'Provider wire',
  'core-orchestrated': 'Host orchestrated',
};

export function pluginLlmProfile(name: string): PluginLlmProfile {
  const declared = llmProfiles[name];
  if (declared) return { ...declared, label: llmLabels[declared.mode] };
  return {
    mode: 'deterministic',
    label: llmLabels.deterministic,
    summary: `${name} does not call a model. Its behavior is implemented with explicit rules, schemas and tool results.`,
    routing: 'No provider/model override or additional model cost is involved.',
    fallback: 'Not applicable: the deterministic path is the primary path.',
  };
}

function sentence(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0]?.trim();
  return first || text;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface OperationalStep {
  title: string;
  body: string;
}

export interface PluginOperationalProfile {
  executionLabel: string;
  toolCount: number;
  hookCount: number;
  configCount: number;
  mutatingTools: string[];
  confirmTools: string[];
  boundedOptions: string[];
  useCases: string[];
  workflow: OperationalStep[];
  safetyNotes: string[];
  llm: PluginLlmProfile;
}

export function buildPluginOperationalProfile(
  plugin: PluginCatalogEntry,
  detail: PluginDetail,
): PluginOperationalProfile {
  const toolNames = detail.tools.map((tool) => tool.name);
  const mutatingTools = detail.tools.filter((tool) => tool.mutating).map((tool) => tool.name);
  const confirmTools = detail.tools
    .filter((tool) => tool.permission === 'confirm')
    .map((tool) => tool.name);
  const boundedOptions = detail.configOptions
    .filter((option) =>
      /(?:max|limit|timeout|threshold|interval|budget|ttl|size|chars)/i.test(option.name),
    )
    .map((option) => option.name)
    .slice(0, 8);
  const llm = pluginLlmProfile(plugin.name);
  const executionLabel =
    llm.mode === 'provider-wire'
      ? 'provider wrapper'
      : detail.hooks.length > 0 && detail.tools.length > 0
        ? 'tools + hooks'
        : detail.hooks.length > 0
          ? 'hook driven'
          : detail.tools.length > 0
            ? 'tool driven'
            : plugin.source === 'Bridge'
              ? 'interface bridge'
              : 'host composed';

  const useCases = detail.tools.length
    ? detail.tools.slice(0, 3).map((tool) => tool.summary ?? `Invoke ${tool.name}.`)
    : [sentence(detail.longDescription)];

  const operateBody =
    toolNames.length > 0
      ? `Invoke ${joinNames(toolNames.slice(0, 4))}${toolNames.length > 4 ? ` and ${toolNames.length - 4} more registered tool(s)` : ''}.`
      : detail.hooks.length > 0
        ? `The plugin reacts through ${joinNames(detail.hooks.slice(0, 3))}.`
        : 'Use the host command or integration surface described by this plugin.';
  const statusTool = detail.tools.find((tool) => /(?:status|summary|list|health)$/.test(tool.name));

  const safetyNotes = [
    mutatingTools.length > 0
      ? `Filesystem or project state can change through ${joinNames(mutatingTools)}.`
      : 'Registered tools are read-only or the plugin exposes no direct tool mutation.',
    confirmTools.length > 0
      ? `The permission layer asks before ${joinNames(confirmTools)}.`
      : 'No registered tool in this plugin declares confirm permission.',
    detail.hooks.length > 0
      ? `Automatic behavior is visible through ${joinNames(detail.hooks.slice(0, 4))}.`
      : 'No lifecycle hook runs automatically for this plugin.',
    boundedOptions.length > 0
      ? `Operational bounds are configurable with ${joinNames(boundedOptions)}.`
      : `The ${plugin.risk}-risk classification remains the primary activation signal.`,
  ];

  return {
    executionLabel,
    toolCount: detail.tools.length,
    hookCount: detail.hooks.length,
    configCount: detail.configOptions.length,
    mutatingTools,
    confirmTools,
    boundedOptions,
    useCases,
    workflow: [
      {
        title: plugin.defaultState === 'active' ? 'Inspect' : 'Enable',
        body:
          plugin.defaultState === 'active'
            ? `It is active by default; inspect the effective row with wstack plugin report before changing plugins.${plugin.name}.`
            : `Opt in explicitly with wstack plugin enable ${plugin.name}, then review its validated config.`,
      },
      { title: 'Operate', body: operateBody },
      {
        title: 'Verify',
        body: statusTool
          ? `Read ${statusTool.name} and the plugin health result before depending on automation.`
          : 'Check the returned tool/command result and the plugin health entry in runtime diagnostics.',
      },
    ],
    safetyNotes,
    llm,
  };
}

export function pluginSearchTerms(name: string): string {
  const profile = pluginLlmProfile(name);
  return `${profile.mode} ${profile.label} ${profile.summary}`.toLowerCase();
}
