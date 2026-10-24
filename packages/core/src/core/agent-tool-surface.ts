import type { Container } from '@wrongstack/contracts/kernel/container';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Provider } from '@wrongstack/contracts/types/provider';
import type { BuildContext, SystemPromptBuilder } from '@wrongstack/contracts/types/system-prompt';
import { providerToolsForVariant } from '../registry/scout-tool-surface.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { Context } from './context.js';

/** Keep prompt composition, provider accounting, and executable discovery aligned. */
export async function refreshAgentToolSurface(
  agent: {
    readonly ctx: Context;
    readonly tools: ToolRegistry;
    readonly container: Pick<Container, 'safeResolve'>;
  },
  provider: Provider,
  model: string,
  refreshPrompt: boolean,
  forcePrompt = false,
): Promise<void> {
  const ctx = agent.ctx;
  const meta = ctx.meta ?? {};
  const tools = providerToolsForVariant(agent.tools, meta['systemPromptVariant'], meta, provider);
  const catalogTools = agent.tools.list();
  const changed = ctx.tools !== tools;
  ctx.tools = tools;
  ctx.catalogTools = catalogTools;
  if (!refreshPrompt || (!changed && !forcePrompt)) return;
  const builder = agent.container.safeResolve<SystemPromptBuilder>(TOKENS.SystemPromptBuilder);
  if (!builder) return;
  const variant = meta['systemPromptVariant'];
  const autonomy = meta['autonomy'];
  const onlineAgents = Array.isArray(meta['promptOnlineAgents'])
    ? (meta['promptOnlineAgents'] as NonNullable<BuildContext['onlineAgents']>)
    : undefined;
  ctx.systemPrompt = await builder.build({
    cwd: ctx.cwd,
    projectRoot: ctx.projectRoot,
    tools,
    catalogTools,
    provider: provider.id,
    model,
    onlineAgents,
    ...(variant === 'lite' || variant === 'pro' || variant === 'scout' || variant === 'default'
      ? { systemVariant: variant }
      : {}),
    ...(typeof autonomy === 'string' ? { autonomy } : {}),
  });
}
