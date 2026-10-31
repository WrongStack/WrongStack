export interface SettingField {
  key: string;
  label: string;
  description: string;
  kind: 'toggle' | 'number' | 'select' | 'lines';
  options?: readonly string[];
  unit?: string;
  /** Stored value per displayed unit: a millisecond setting shown in seconds has 1000. */
  scale?: number;
  min?: number;
}
export const settingsSections = [
  {
    id: 'execution',
    title: 'Execution & permissions',
    description: 'Defaults for new conversations and agent runs.',
    fields: [
      {
        key: 'autonomy',
        label: 'Continuation mode',
        description: 'Choose how WrongStack continues after completing a step.',
        kind: 'select',
        options: ['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'],
      },
      {
        key: 'maxIterations',
        label: 'Iteration budget',
        description:
          'Maximum iterations for a new agent run. Zero means unlimited. Running conversations keep their current budget.',
        kind: 'number',
        min: 0,
      },
      {
        key: 'autoProceedMaxIterations',
        label: 'Automatic continuation budget',
        description:
          'Maximum continuation steps before another user decision is needed. Zero uses the engine’s unlimited setting.',
        kind: 'number',
        min: 0,
      },
      {
        key: 'autonomyDelayMs',
        label: 'Continuation delay',
        description: 'Wait between autonomous continuation steps.',
        kind: 'number',
        min: 0,
        unit: 'seconds',
        scale: 1000,
      },
      {
        key: 'breakerEnabled',
        label: 'Circuit breaker',
        description: 'Stop repeated failures and runaway tool loops.',
        kind: 'toggle',
      },
      {
        key: 'breakerAutoKillResetMs',
        label: 'Breaker reset delay',
        description: 'How long the circuit breaker waits before resetting.',
        kind: 'number',
        min: 0,
        unit: 'seconds',
        scale: 1000,
      },
    ],
  },
  {
    id: 'context',
    title: 'Context & reasoning',
    description: 'Control how new conversations use context and model reasoning.',
    fields: [
      {
        key: 'contextMode',
        label: 'Context profile',
        description:
          'Balanced for everyday work, frugal for smaller context, or deep for detailed analysis.',
        kind: 'select',
        options: ['balanced', 'frugal', 'deep'],
      },
      {
        key: 'contextStrategy',
        label: 'Context strategy',
        description: 'How the engine selects and compresses conversation context.',
        kind: 'select',
        options: ['hybrid', 'intelligent', 'selective'],
      },
      {
        key: 'contextAutoCompact',
        label: 'Automatic compaction',
        description: 'Compact older context when the conversation approaches its window limit.',
        kind: 'toggle',
      },
      {
        key: 'tokenSavingTier',
        label: 'Token saving',
        description: 'Balance prompt detail against token usage.',
        kind: 'select',
        options: ['auto', 'off', 'minimal', 'light', 'medium', 'aggressive'],
      },
      {
        key: 'reasoningMode',
        label: 'Model reasoning',
        description: 'Follow provider defaults, request reasoning, or disable it when supported.',
        kind: 'select',
        options: ['auto', 'on', 'off'],
      },
      {
        key: 'reasoningEffort',
        label: 'Reasoning effort',
        description: 'Requested effort for providers that support this control.',
        kind: 'select',
        options: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        key: 'reasoningPreserve',
        label: 'Preserve reasoning',
        description: 'Retain provider reasoning context when the model supports it.',
        kind: 'toggle',
      },
      {
        key: 'systemPromptVariant',
        label: 'Agent identity',
        description:
          'Choose the identity for new runs: Lite, Standard or Pro coding guidance, general-purpose Scout, or minimal Quick.',
        kind: 'select',
        options: ['lite', 'default', 'pro', 'scout', 'quick'],
      },
      {
        key: 'includeGlobalAgents',
        label: 'Global AGENTS.md',
        description: 'Load ~/.wrongstack/AGENTS.md into the system prompt of new runs.',
        kind: 'toggle',
      },
      {
        key: 'includeProjectAgents',
        label: 'Project AGENTS.md',
        description: "Load the project's root AGENTS.md into the system prompt of new runs.",
        kind: 'toggle',
      },
    ],
  },
  {
    id: 'capabilities',
    title: 'Capabilities',
    description: 'Choose which WrongStack systems are available in new runs.',
    fields: [
      {
        key: 'featureMemory',
        label: 'Project memory',
        description: 'Use SAGE to preserve and retrieve durable project knowledge.',
        kind: 'toggle',
      },
      {
        key: 'featureSkills',
        label: 'Skills',
        description: 'Discover and use installed workflow instructions.',
        kind: 'toggle',
      },
      {
        key: 'featureMcp',
        label: 'MCP connections',
        description: 'Expose enabled external tool servers to the engine.',
        kind: 'toggle',
      },
      {
        key: 'featurePlugins',
        label: 'Plugins',
        description: 'Load configured WrongStack extensions.',
        kind: 'toggle',
      },
      {
        key: 'featureToolCoach',
        label: 'Tool coach',
        description: 'Help the agent choose and use available tools effectively.',
        kind: 'toggle',
      },
      {
        key: 'featureModelsRegistry',
        label: 'Model registry',
        description: 'Use model capability and availability catalogs.',
        kind: 'toggle',
      },
      {
        key: 'indexOnStart',
        label: 'Index code at startup',
        description: 'Prepare the codebase index when a project runtime starts.',
        kind: 'toggle',
      },
    ],
  },
  {
    id: 'routing',
    title: 'Agents & fallbacks',
    description: 'Shared concurrency and fallback defaults for new work.',
    fields: [
      {
        key: 'maxConcurrent',
        label: 'Concurrent agents',
        description: 'Maximum simultaneous agents allowed by the engine.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'fallbackAuto',
        label: 'Automatic model fallback',
        description: 'Try the configured fallback chain when a provider or model is unavailable.',
        kind: 'toggle',
      },
      {
        key: 'cacheTtl',
        label: 'Prompt cache lifetime',
        description: 'Requested cache lifetime for providers that support prompt caching.',
        kind: 'select',
        options: ['default', '5m', '1h'],
      },
    ],
  },
  {
    id: 'logging',
    title: 'Logs & diagnostics',
    description: 'Control the detail recorded by WrongStack.',
    fields: [
      {
        key: 'logLevel',
        label: 'Log detail',
        description: 'Choose the minimum severity recorded in engine logs.',
        kind: 'select',
        options: ['debug', 'info', 'warn', 'error'],
      },
      {
        key: 'auditLevel',
        label: 'Audit detail',
        description: 'How much evidence is retained for tool execution and decisions.',
        kind: 'select',
        options: ['minimal', 'standard', 'full'],
      },
      {
        key: 'debugStream',
        label: 'Stream diagnostics',
        description:
          'Record additional provider streaming diagnostics while investigating a problem.',
        kind: 'toggle',
      },
    ],
  },
] as const satisfies readonly {
  id: string;
  title: string;
  description: string;
  fields: readonly SettingField[];
}[];
export function changedSettings(
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(base[key]),
    ),
  );
}
