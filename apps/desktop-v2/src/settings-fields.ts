import {
  STREAM_WATCHDOG_DEFAULTS,
  STREAM_WATCHDOG_MAX_SECONDS,
} from '@wrongstack/contracts/types/config/runtime';

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
  max?: number;
  /** Words for a select's options, before the shared labels. */
  optionLabels?: Readonly<Record<string, string>>;
  /** A select whose options are numbers stored as numbers. */
  numeric?: boolean;
  /** For a setting that may stay unset: what unset means. Such a number may be left empty. */
  unsetNote?: string;
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
      {
        key: 'nextStepsMode',
        label: 'Require next steps',
        description:
          'Every finished turn ends with next steps or a completion marker, so automatic continuation keeps going until the agent declares the work complete. The continuation budget still pauses it.',
        kind: 'select',
        options: ['optional', 'required'],
        optionLabels: { optional: 'Optional', required: 'Required' },
      },
      {
        key: 'fsAccess',
        label: 'Filesystem access',
        description: 'Scope of the file tools. Applies on the next session.',
        kind: 'select',
        options: ['unrestricted', 'project'],
        optionLabels: {
          unrestricted: 'Unrestricted — any path',
          project: 'Project — confined to the project root',
        },
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
      {
        key: 'readSymbols',
        label: 'Read symbols',
        description: 'The read tool includes codebase-index symbols alongside file content.',
        kind: 'toggle',
      },
      {
        key: 'showSageMemoryInject',
        label: 'Show SAGE memory injection',
        description: 'Show the SAGE memory-injection blocks added to tool results.',
        kind: 'toggle',
      },
      {
        key: 'sageMemoryInjectThreshold',
        label: 'SAGE memory injection threshold',
        description: 'Minimum relation strength required for an injected SAGE memory.',
        kind: 'select',
        numeric: true,
        options: ['0.72', '0.75', '0.85', '0.90', '0.95'],
        optionLabels: {
          '0.72': '0.72 (relaxed)',
          '0.85': '0.85 (default)',
          '0.95': '0.95 (strict)',
        },
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
        key: 'favoriteModelsOnly',
        label: 'Favorites only',
        description:
          'When automatic fallback derives a chain, restrict it to your favorite models.',
        kind: 'toggle',
      },
      {
        key: 'streamTimeouts.hangTimeoutMs',
        label: 'Silence between chunks',
        description:
          'Longest pause allowed once a reply is streaming before the attempt is failed and retried. Raise it for models with long silent thinking phases. 0 turns it off.',
        kind: 'number',
        unit: 'seconds',
        scale: 1000,
        max: STREAM_WATCHDOG_MAX_SECONDS,
        unsetNote: `Default: ${STREAM_WATCHDOG_DEFAULTS.hangTimeoutMs / 1000} s (${STREAM_WATCHDOG_DEFAULTS.slowBackendHangTimeoutMs / 1000} s for MiniMax and Z.AI)`,
      },
      {
        key: 'streamTimeouts.headersTimeoutMs',
        label: 'Wait for response headers',
        description: 'How long to wait for the provider to start answering at all. 0 turns it off.',
        kind: 'number',
        unit: 'seconds',
        scale: 1000,
        max: STREAM_WATCHDOG_MAX_SECONDS,
        unsetNote: `Default: ${STREAM_WATCHDOG_DEFAULTS.headersTimeoutMs / 1000} s (${STREAM_WATCHDOG_DEFAULTS.slowBackendHeadersTimeoutMs / 1000} s for MiniMax and Z.AI)`,
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

const group = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A field's value; a dotted key (`streamTimeouts.hangTimeoutMs`) reads inside its setting. */
export function settingValue(values: Record<string, unknown>, key: string): unknown {
  const [top = key, inner] = key.split('.', 2);
  return inner === undefined ? values[top] : group(values[top])[inner];
}

/**
 * The top-level setting a field's new value changes: a dotted key rewrites its group, and an
 * emptied field is dropped from it so the engine falls back to its default.
 */
export function settingChange(
  values: Record<string, unknown>,
  key: string,
  value: unknown,
): [string, unknown] {
  const [top = key, inner] = key.split('.', 2);
  if (inner === undefined) return [top, value];
  const { [inner]: _previous, ...rest } = group(values[top]);
  return [top, value === undefined ? rest : { ...rest, [inner]: value }];
}
