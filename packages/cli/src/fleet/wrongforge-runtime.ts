import type {
  ReasoningConfig,
  ReasoningRequest,
  RequestCacheControl,
} from '@wrongstack/contracts/types';
import type { WrongForgeInfo } from './wrongforge-info.js';

/** Task API accepts these controls and owns model-specific clamping/omission. */
export const WRONGFORGE_REASONING: ReasoningConfig = {
  default: 'adaptive',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  preserveThinking: 'unsupported',
};

/** WrongForge has a smaller effort vocabulary; model-specific clamping is server-owned. */
export function wrongForgeRuntime(
  reasoning?: ReasoningRequest,
  cache?: RequestCacheControl,
  info?: WrongForgeInfo,
): {
  effort?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cache?: '5m' | '1h';
} {
  const effort = reasoning?.effort;
  return {
    ...(reasoning?.enabled === false || effort === 'none'
      ? { effort: 'off' as const }
      : effort
        ? {
            effort:
              effort === 'minimal'
                ? ('low' as const)
                : (effort === 'xhigh' || effort === 'max') && !info?.effortLevels?.includes(effort)
                  ? ('high' as const)
                  : effort,
          }
        : {}),
    ...(cache?.ttl ? { cache: cache.ttl } : {}),
  };
}
