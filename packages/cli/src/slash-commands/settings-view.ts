import type { FleetChatVerbosity } from '@wrongstack/core/types';
import { resolveFleetChatVerbosity } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { formatDelay } from '../utils/delay-format.js';
import type { SlashCommandContext } from './command-context.js';

export const SETTINGS_HELP = [
  'Usage:',
  '  /settings                     Show current settings',
  '  /settings delay <seconds>     Auto-proceed delay in auto mode (0 disables)',
  '  /settings mode <off|suggest|auto>   Default autonomy mode at startup',
  '  /settings stream-fleet off|full   Fleet-chat verbosity (on = full)',
  '  /settings chime on|off          Ring terminal bell when a run completes',
  '  /settings confirm-exit on|off   Ask for confirmation before interrupt/exit',
  '  /settings hints on|off        Show or suppress rotating launch hints',
  '  /settings debug-stream on|off   Raw SSE hex-dump to stderr for debugging',
  '  /settings config-scope global|project   Save settings globally or per-project',
  '  /settings fs-access unrestricted|project   File-tool access scope (project = confine to project root)',
  '  /settings refine on|off       Enable/disable prompt refinement',
  '  /settings refine-delay <seconds>   Countdown duration for refine preview',
  '  /settings refine-language original|english   Default language for refinement',
  '  /settings refiner-provider <providerId>          Provider for goal refinement (`/goal set`)',
  '  /settings refiner-model <modelId>                Model for goal refinement (must be favorite or active model)',
  '  /settings refiner-fallback-profile <name>        Named fallback profile for goal refinement',
  '  /settings refiner-clear                           Clear all refiner config (use session default)',
  '  /settings semver-part patch|minor|major|auto   Default part for /semver and the semver_bump tool',
  '  /settings breaker on|off   Enable/disable the process circuit breaker (gates bash/exec)',
  '  /settings breaker-timeout <seconds>   Auto kill/reset delay when the breaker trips (0 = manual)',
  '  /settings context-mode balanced|frugal|deep   Context window policy',
  '  /settings context-strategy hybrid|intelligent|selective   Compactor strategy',
  '  /settings context-auto-compact on|off   Auto-compact context when thresholds crossed',
  '  /settings token-saving off|minimal|light|medium|aggressive   Token-saving mode',
  '  /settings nextsteps-tool on|off   Give the leader a `nextsteps` tool alongside the <nextsteps> block (next session)',
  '  /settings mcp on|off            Load MCP servers declared in config',
  '  /settings plugins on|off        Load npm plugins declared in config',
  '  /settings memory on|off         Register remember/forget tools',
  '  /settings skills on|off         Discover and load skills from disk',
  '  /settings models-registry on|off   Fetch model catalog at startup',
  '  /settings max-concurrent <n>   Max concurrent subagents (0 = default)',
  '  /settings max-iterations <n>    Max agent iterations before pausing (0 = default)',
  '  /settings auto-proceed-max-iterations <n>   Max auto turns before pausing (0 = unlimited)',
  '  /settings title-animation on|off   Animate the terminal/window title while the agent is active',
  '  /settings thinking-word <word>   TUI status-chip word (single short word)',
  '  /settings statusline minimum|detailed|no-color   TUI statusline density',
  '  /settings animation rainbow|wave|pulse|dots|breathe|static|cycle   TUI working-chip animation',
  '  /settings read-symbols on|off   Include codebase-index symbols in read tool results',
  '  /settings reasoning auto|on|off   Reasoning mode (auto = provider default)',
  '  /settings reasoning-effort none|minimal|low|medium|high|xhigh|max   Reasoning effort',
  '  /settings reasoning-preserve on|off   Preserve thinking across turns',
  '  /settings cache-ttl 5m|1h   Prompt cache TTL (Anthropic)',
  '  /settings index-on-start on|off   Rebuild codebase index at session start',
  '  /settings log-level error|warn|info|debug|trace   Logging verbosity',
  '  /settings audit-level minimal|standard|full   Session audit detail',
  '  /settings hq on|off           Enable/disable HQ client publishing',
  '  /settings hq-url <url>        HQ URL for remote clients (http://host:3499)',
  '  /settings hq-token <token>    HQ client token for remote clients',
  '  /settings hq-raw on|off       Send raw content previews to HQ',
  '  /settings defaults            Show built-in default values',
  '',
  'Settings are persisted to the active config scope: profile (~/.wrongstack/profiles/<name>/config.json) or project (<project>/.wrongstack/config.json).',
].join('\n');

export function formatSettingsDefaults(): string {
  return [
    `${color.bold('Default Values')}`,
    '',
    `  auto-proceed delay:    ${color.cyan('45s')} ${color.dim('(WRONGSTACK_AUTO_PROCEED_DELAY_MS env)')}`,
    `  default autonomy mode: ${color.cyan('off')}`,
    `  launch hints:          ${color.cyan('on')}`,
    `  iteration timeout:     ${color.cyan('5 min')}`,
    `  session timeout:       ${color.cyan('30 min')}`,
    `  max iterations:        ${color.cyan('100')}`,
    `  max concurrent:        ${color.cyan('4')}`,
    `  semver default part:   ${color.cyan('patch')}`,
  ].join('\n');
}

export function formatCurrentSettingsView(opts: SlashCommandContext): string {
  const autonomy = opts.configStore.get().autonomy as
    | {
        autoProceedDelayMs?: number | undefined;
        defaultMode?: string | undefined;
        enhance?: boolean | undefined;
        enhanceDelayMs?: number | undefined;
        enhanceLanguage?: string | undefined;
      }
    | undefined;
  const delay = autonomy?.autoProceedDelayMs ?? 45_000;
  const mode = autonomy?.defaultMode ?? 'off';
  const hints = opts.configStore.get().hints !== false;
  const debugStream = opts.configStore.get().debugStream === true;
  const configScope = opts.configStore.get().configScope ?? 'global';
  const fsAccess =
    opts.configStore.get().tools?.restrictToProjectRoot === true ? 'project' : 'unrestricted';
  const enhanceEnabled = autonomy?.enhance ?? true;
  const enhanceDelay = autonomy?.enhanceDelayMs ?? 60_000;
  const enhanceLanguage = (autonomy?.enhanceLanguage as string) ?? 'original';
  const semverPart =
    ((
      opts.configStore.get().extensions?.['semver-bump'] as Record<string, unknown> | undefined
    )?.['defaultPart'] as string) ?? 'patch';
  const cb = opts.configStore.get().circuitBreaker;
  const breakerEnabled = cb?.enabled === true;
  const breakerTimeout = cb?.autoKillResetMs ?? 60_000;
  const context = opts.configStore.get().context as never as Record<string, unknown> | undefined;
  const contextMode = (context?.mode as string) ?? 'balanced';
  const contextStrategy = (context?.strategy as string) ?? 'hybrid';
  const contextAutoCompact = context?.autoCompact !== false;
  const features = opts.configStore.get().features as never as
    | Record<string, unknown>
    | undefined;
  const tokenSavingTier = (features?.tokenSavingMode as string) ?? 'off';
  const nextStepsToolEnabled = opts.configStore.get().tools?.nextsteps?.enabled === true;
  const maxConcurrent = opts.configStore.get().maxConcurrent ?? 4;
  const titleAnimation =
    (autonomy as { terminalTitleAnimation?: boolean } | undefined)?.terminalTitleAnimation !==
    false;
  const modelRuntime = opts.configStore.get().modelRuntime as
    | {
        reasoning?: { mode?: string; effort?: string; preserve?: boolean };
        cache?: { ttl?: string };
      }
    | undefined;
  const reasoningMode = modelRuntime?.reasoning?.mode ?? 'auto';
  const reasoningEffort = modelRuntime?.reasoning?.effort ?? '(unset)';
  const reasoningPreserve = modelRuntime?.reasoning?.preserve === true;
  const cacheTtl = modelRuntime?.cache?.ttl ?? 'default';
  const hq = (opts.configStore.get() as { hq?: unknown }).hq as
    | {
        enabled?: boolean;
        url?: string;
        token?: string;
        rawContent?: boolean;
        projectAlias?: string;
      }
    | undefined;
  const hqEnabled = hq?.enabled === true;
  const hqUrl = hq?.url ?? '(auto/local)';
  const hqToken = hq?.token
    ? `${hq.token.slice(0, 6)}…${hq.token.slice(-4)} (${hq.token.length} chars)`
    : '(auto/local)';
  const persistedTo =
    configScope === 'project'
      ? '<project>/.wrongstack/config.json'
      : `~/.wrongstack/profiles/${opts.configStore.get().activeProfile ?? 'default'}/config.json`;
  const au = autonomy as Record<string, unknown> | undefined;
  const tools = opts.configStore.get().tools as never as Record<string, unknown> | undefined;
  const log = opts.configStore.get().log as never as Record<string, unknown> | undefined;
  const feats = opts.configStore.get().features as never as Record<string, unknown> | undefined;
  const idx = opts.configStore.get().indexing as never as Record<string, unknown> | undefined;
  const sess = opts.configStore.get().session as never as Record<string, unknown> | undefined;
  return [
    `${color.bold('WrongStack')} ${color.dim('— Settings')}`,
    '',
    `  auto-proceed delay:          ${color.cyan(formatDelay(delay))}   ${color.dim('change: /settings delay <seconds>')}`,
    `  default autonomy mode:       ${color.cyan(mode)}   ${color.dim('change: /settings mode off|suggest|auto')}`,
    `  fleet chat:                 ${color.cyan(resolveFleetChatVerbosity(au as { fleetChatVerbosity?: FleetChatVerbosity } | undefined))}   ${color.dim('change: /settings stream-fleet off|full')}`,
    `  completion chime:           ${au?.chime === true ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings chime on|off')}`,
    `  confirm before exit:        ${au?.confirmExit !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings confirm-exit on|off')}`,
    `  launch hints:               ${hints ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hints on|off')}`,
    `  debug stream:               ${debugStream ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings debug-stream on|off')}`,
    `  config scope:               ${color.cyan(configScope)}   ${color.dim('change: /settings config-scope global|project')}`,
    `  filesystem access:          ${color.cyan(fsAccess)}   ${color.dim('change: /settings fs-access unrestricted|project')}`,
    `  refine:                     ${enhanceEnabled ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings refine on|off')}`,
    `  refine-delay:               ${color.cyan(formatDelay(enhanceDelay))}   ${color.dim('change: /settings refine-delay <seconds>')}`,
    `  refine-language:            ${color.cyan(enhanceLanguage)}   ${color.dim('change: /settings refine-language original|english')}`,
    `  refiner-provider:           ${color.cyan((au?.refinerProvider as string) ?? color.dim('(unset)'))}   ${color.dim('change: /settings refiner-provider <id>')}`,
    `  refiner-model:              ${color.cyan((au?.refinerModel as string) ?? color.dim('(unset)'))}   ${color.dim('change: /settings refiner-model <model>')}`,
    `  refiner-fallback-profile:   ${color.cyan((au?.refinerFallbackProfile as string) ?? color.dim('(unset)'))}   ${color.dim('change: /settings refiner-fallback-profile <name>')}`,
    `  semver default part:        ${color.cyan(semverPart)}   ${color.dim('change: /settings semver-part patch|minor|major|auto')}`,
    `  circuit breaker:            ${breakerEnabled ? color.cyan('on') : color.dim('off')} (${breakerTimeout > 0 ? formatDelay(breakerTimeout) : color.dim('manual')})   ${color.dim('change: /settings breaker on|off')}`,
    `  context mode:               ${color.cyan(contextMode)}   ${color.dim('change: /settings context-mode balanced|frugal|deep')}`,
    `  context strategy:           ${color.cyan(contextStrategy)}   ${color.dim('change: /settings context-strategy hybrid|intelligent|selective')}`,
    `  context auto-compact:       ${contextAutoCompact ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings context-auto-compact on|off')}`,
    `  token-saving:               ${color.cyan(tokenSavingTier)}   ${color.dim('change: /settings token-saving off|minimal|light|medium|aggressive')}`,
    `  nextsteps tool:             ${nextStepsToolEnabled ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings nextsteps-tool on|off')}`,
    `  MCP features:               ${feats?.mcp !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings mcp on|off')}`,
    `  plugin features:            ${feats?.plugins !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings plugins on|off')}`,
    `  memory features:            ${feats?.memory !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings memory on|off')}`,
    `  skills features:            ${feats?.skills !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings skills on|off')}`,
    `  models registry:            ${feats?.modelsRegistry !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings models-registry on|off')}`,
    `  max concurrent:             ${color.cyan(maxConcurrent === 0 ? 'default' : String(maxConcurrent))}   ${color.dim('change: /settings max-concurrent <n>')}`,
    `  max iterations:             ${color.cyan(String(tools?.maxIterations ?? 'default'))}   ${color.dim('change: /settings max-iterations <n>')}`,
    `  auto-proceed max iters:     ${color.cyan(String(au?.autoProceedMaxIterations ?? 'unlimited'))}   ${color.dim('change: /settings auto-proceed-max-iterations <n>')}`,
    `  title animation:            ${titleAnimation ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings title-animation on|off')}`,
    `  thinking word:              ${color.cyan((au?.thinkingWord as string) ?? 'thinking')}   ${color.dim('change: /settings thinking-word <word>')}`,
    `  statusline mode:            ${color.cyan((au?.statuslineMode as string) ?? 'minimum')}   ${color.dim('change: /settings statusline minimum|detailed|no-color')}`,
    `  animation style:            ${color.cyan((au?.animationStyle as string) ?? 'rainbow')}   ${color.dim('change: /settings animation rainbow|wave|pulse|dots|breathe|static|cycle')}`,
    `  read symbols:               ${au?.readAdvancedMode === true ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings read-symbols on|off')}`,
    `  reasoning mode:             ${color.cyan(reasoningMode)}   ${color.dim('change: /settings reasoning auto|on|off')}`,
    `  reasoning effort:           ${color.cyan(reasoningEffort)}   ${color.dim('change: /settings reasoning-effort <level>')}`,
    `  reasoning preserve:         ${reasoningPreserve ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings reasoning-preserve on|off')}`,
    `  cache TTL:                  ${color.cyan(cacheTtl)}   ${color.dim('change: /settings cache-ttl 5m|1h')}`,
    `  index on start:             ${idx?.onSessionStart !== false ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings index-on-start on|off')}`,
    `  log level:                  ${color.cyan((log?.level as string) ?? 'info')}   ${color.dim('change: /settings log-level error|warn|info|debug|trace')}`,
    `  audit level:                ${color.cyan((sess?.auditLevel as string) ?? 'standard')}   ${color.dim('change: /settings audit-level minimal|standard|full')}`,
    `  HQ publishing:              ${hqEnabled ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hq on|off')}`,
    `  HQ URL:                     ${color.cyan(hqUrl)}   ${color.dim('change: /settings hq-url <url>')}`,
    `  HQ token:                   ${color.cyan(hqToken)}   ${color.dim('change: /settings hq-token <token>')}`,
    `  HQ raw content:             ${hq?.rawContent === true ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hq-raw on|off')}`,
    '',
    color.dim(`  Persisted to ${persistedTo} · /settings help for more`),
  ].join('\n');
}
