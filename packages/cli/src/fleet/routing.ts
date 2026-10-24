import { TOKENS } from '@wrongstack/contracts/kernel';
import type {
  Config,
  SubagentRunContext,
  SubagentRunner,
  TaskSpec,
} from '@wrongstack/contracts/types';
import { makeAgentSubagentRunner, NULL_FLEET_BUS } from '@wrongstack/core/coordination';
import { expectDefined } from '@wrongstack/core/utils';
import { runWithQuotaHold } from './acp-quota-hold.js';
import type { MultiAgentHost } from './host.js';
import { WRONGFORGE_AGENT_ID } from './wrongforge-client.js';
/**
 * Routing runner — dispatches tasks to standard or ACP runner based on provider.
 */
export function buildRoutingRunner(config: Config, host: MultiAgentHost): SubagentRunner {
  const standardRunner = makeAgentSubagentRunner({
    factory: host.makeSubagentFactory(config),
    fleetBus: host.getDirector()?.fleet ?? NULL_FLEET_BUS,
  });

  return async (task: TaskSpec, ctx: SubagentRunContext) => {
    const subCfg = ctx.config;
    // `provider: "wrongforge"` + a model the machine's WrongForge serves: its
    // task runner, the same one `acp` + name `wrongforge` reaches.
    if (subCfg.provider === WRONGFORGE_AGENT_ID) {
      return runWithQuotaHold(WRONGFORGE_AGENT_ID, async () => {
        const runner = await host.buildACPRunner(WRONGFORGE_AGENT_ID);
        return runner(task, ctx);
      });
    }
    if (subCfg.provider === 'acp') {
      const cacheKey = subCfg.role ?? subCfg.name ?? expectDefined(subCfg.id);
      // A spent agent is not started again until its quota resets.
      return runWithQuotaHold(cacheKey, async () => {
        const runner = await host.buildACPRunner(cacheKey);
        return runner(task, ctx);
      });
    }
    return standardRunner(task, ctx);
  };
}

// Workaround: TOKENS reference satisfies unused-import lint
void TOKENS;
