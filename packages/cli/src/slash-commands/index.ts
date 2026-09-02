import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';
import { loadStatuslineConfig, saveStatuslineConfig } from '../services/statusline-config.js';

export type { ToolRegistry } from '@wrongstack/core/registry';
export type { TokenCounter } from '@wrongstack/core/types';
export type { SlashCommandContext } from './command-context.js';

// Re-export helpers for external consumers (pre-launch.ts)
export type { ProjectFacts } from './helpers.js';
export { detectProjectFacts, renderAgentsTemplate } from './helpers.js';

import { buildAcpCommand } from './acp.js';
import { buildAgentImproveCommand } from './agent-improve.js';
import { buildAuthCommand } from './auth.js';
import { buildAutonomyCommand } from './autonomy.js';

import { buildBrainCommand } from './brain.js';
import { buildBtwCommand } from './btw.js';
import { buildClearCommand } from './clear.js';
import { buildCodebaseReindexCommand } from './codebase-reindex.js';
import { buildCollabCommand } from './collab.js';
import { buildCompactCommand } from './compact.js';
import { buildContextCommand } from './context.js';
import { buildCoordinatorCommand } from './coordinator.js';
import { buildDelegateCommand } from './delegate.js';
import { buildDesignCommand } from './design.js';
import { buildDevCommand } from './dev.js';
import { buildDiagCommand, buildStatsCommand } from './diag-stats.js';
import { buildDoctorCommand } from './doctor.js';
import { buildEnhanceCommand } from './enhance.js';
import { buildEnsembleCommand } from './ensemble.js';
import { buildFKeyAliasCommands, buildFKeysCommand } from './f-keys.js';
import { buildFallbackCommand } from './fallback.js';
import { buildTierCommand } from './tier.js';
import { buildFixCommand } from './fix.js';
import { buildFleetCommand } from './fleet.js';
import {
  buildCommitCommand,
  buildGitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './git.js';
import { buildGitIdCommand } from './gitid.js';
import { buildGoalCommand } from './goal.js';
import { buildHealthCommand } from './health.js';
import { buildHelpCommand } from './help.js';
import { buildInitCommand } from './init.js';
import { buildIntakeCommand } from './intake.js';
import { buildInterruptCommand } from './interrupt.js';
import { buildKanbanCommand } from './kanban.js';
import { buildMailboxCommand } from './mailbox.js';
import { buildMailboxDemoCommand } from './mailbox-demo.js';
import { buildMailboxServeCommand } from './mailbox-serve.js';
import { buildMcpSlashCommand } from './mcp.js';
import { buildMemoryCommand } from './memory.js';
import { buildMetricsCommand } from './metrics.js';
import { buildModeCommand } from './mode.js';
import { buildModelCapsCommand } from './modelcaps.js';
import { buildModelsCommand } from './models.js';
import { buildNextCommand } from './next.js';
import { buildPlanCommand } from './plan.js';
import { buildPluginCommand } from './plugin.js';
import { buildProfileCommand } from './profile.js';
import { buildProviderStatusCommand } from './provider-status.js';
import { buildPruneCommand } from './prune.js';
import { buildRefinerCommand } from './refiner.js';
import { buildSddCommand } from './sdd.js';
import { buildExitCommand, buildLoadCommand, buildSaveCommand } from './session.js';
import { buildSetModelCommand } from './setmodel.js';
import { buildEffortCommand } from './effort.js';
import { buildSuggestCommand } from './suggest.js';
import { buildDesktopCommand, buildWebuiCommand } from './surfaces.js';
import { buildThemeCommand } from './theme.js';

// modeldiag is now a CLI subcommand (wstack modeldiag), not a slash command.

import { buildAgentsCommand } from './agents.js';
import { buildAuditCommand } from './audit.js';
import { buildHqCommand } from './hq.js';
import { buildMouseCommand } from './mouse.js';
import { buildProjectCommand } from './project.js';
import { buildReviewCommand } from './review.js';
import { buildSecurityCommand } from './security.js';
import { buildSettingsCommand } from './settings.js';
import { buildShadowCommand } from './shadow.js';
import { buildSidebarCommand } from './sidebar.js';
import { buildDirectorCommand, buildSpawnCommand } from './spawn-agents.js';
import { buildStatuslineCommand } from './statusline.js';
import { buildSupervisorCommand } from './supervisor.js';
import { buildTasksCommand } from './tasks.js';
import { buildTechStackCommand } from './techstack.js';
import { buildTelegramSettingsCommand } from './telegram-settings.js';
import { buildTelegramSetupCommand } from './telegram-setup.js';
import { buildTodosCommand } from './todos.js';
import { buildToolCommand } from './tool.js';
import { buildToolsCommand } from './tools.js';
import { buildTuneupCommand } from './tuneup.js';
import { buildWorkingDirCommand } from './working-dir.js';
import { buildWorktreeCommand } from './worktree.js';
import { buildYoloCommand } from './yolo.js';

export function buildBuiltinSlashCommands(opts: SlashCommandContext): SlashCommand[] {
  return [
    buildHelpCommand(opts),
    buildDesktopCommand(),
    buildWebuiCommand(),
    buildInitCommand(opts),
    buildIntakeCommand(opts),
    buildClearCommand(opts),
    buildInterruptCommand(opts),
    buildKanbanCommand(opts),
    buildCompactCommand(opts),
    buildContextCommand(opts),
    buildDelegateCommand(opts),
    buildDevCommand(opts),
    buildDoctorCommand(opts),
    buildHealthCommand(opts),
    buildMetricsCommand(opts),
    buildTuneupCommand(opts),
    buildCodebaseReindexCommand(opts),
    buildTechStackCommand(opts),
    buildToolCommand(opts),
    buildToolsCommand(opts),
    buildPluginCommand(opts),
    buildPruneCommand(opts),
    buildMcpSlashCommand(opts),
    buildSuggestCommand(opts),
    buildAuthCommand(opts),
    buildDiagCommand(opts),
    buildStatsCommand(opts),
    buildSpawnCommand(opts),
    buildAgentsCommand(opts),
    buildDirectorCommand(opts),
    buildFleetCommand(opts),
    buildFKeysCommand(opts),
    ...buildFKeyAliasCommands(opts),
    buildEnhanceCommand(opts),
    buildEnsembleCommand(opts),
    buildProfileCommand(opts),
    buildAcpCommand(opts),
    buildAgentImproveCommand(opts),
    buildMemoryCommand(opts),
    buildTodosCommand(opts),
    buildPlanCommand(opts),
    buildTasksCommand(opts),
    buildSddCommand(opts),
    buildSaveCommand(opts),
    buildLoadCommand(opts),
    buildYoloCommand(opts),
    buildMouseCommand(opts),
    buildAutonomyCommand(opts),
    buildGoalCommand(opts),
    buildCoordinatorCommand(opts),
    buildBrainCommand(opts),
    buildBtwCommand(opts),
    buildNextCommand(opts),
    buildModeCommand(opts),
    buildThemeCommand(opts),
    buildDesignCommand(opts),
    buildMailboxDemoCommand(opts),
    buildMailboxCommand(opts),
    buildMailboxServeCommand(opts),
    buildExitCommand(opts),
    buildFixCommand(opts),

    buildWorktreeCommand(opts),
    buildSettingsCommand(opts),
    buildSidebarCommand(opts),
    buildHqCommand(opts),
    buildTelegramSetupCommand(opts),
    buildTelegramSettingsCommand(opts),
    buildSetModelCommand(opts),
    buildEffortCommand(opts),
    buildRefinerCommand(opts),
    buildFallbackCommand(opts),
    buildTierCommand(opts),
    ...(opts.statusTracker ? [buildProviderStatusCommand(opts.statusTracker)] : []),
    buildGitCommand(opts),
    buildCommitCommand(opts),
    buildGitcheckCommand(opts),
    buildPushCommand(opts),
    buildGitIdCommand(opts),
    buildModelCapsCommand(opts),
    buildModelsCommand(opts),
    buildCollabCommand(opts),
    buildReviewCommand(opts),
    buildSecurityCommand(opts),
    buildProjectCommand(opts),
    buildWorkingDirCommand(opts),
    buildStatuslineCommand({
      cwd: opts.cwd,
      hiddenItems: opts.statuslineHiddenItems ?? [],
      setHiddenItems: opts.setStatuslineHiddenItems ?? (() => {}),
      // Fallback hosts (REPL/args without the TUI wiring) get a real
      // config-backed implementation, not a stub: the /statusline text
      // output reads chips and every toggle persists through the service.
      getConfig: opts.statuslineConfig?.get ?? (async () => loadStatuslineConfig()),
      setConfig:
        opts.statuslineConfig?.set ??
        (async (cfg) => {
          await saveStatuslineConfig(cfg);
        }),
      saveStatuslineHiddenItems: opts.saveStatuslineHiddenItems ?? (async () => {}),
      onPanelOpen: opts.onPanelOpen,
    }),
    buildShadowCommand(opts),
    buildSupervisorCommand(opts),
    buildAuditCommand(opts),
  ];
}
