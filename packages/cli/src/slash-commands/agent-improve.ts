import {
  buildConsolidationInstruction,
  captureLearnedFromAgentOutput,
  getProjectAgentLearnStats,
  isConsolidated,
  loadConsolidationMetadata,
  loadProjectAgentConfig,
  loadProjectAgentIdentity,
  loadProjectAgentLearned,
  loadRoleKnowledgeManifest,
  refreshProjectAgentIdentity,
  resetProjectAgentIdentity,
  updateProjectAgentIdentity,
} from '@wrongstack/core/agent-catalog';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/agent-improve [role] [action]` — manage the project-custom agent identity.
 *
 * Actions:
 *   show         — display current customization for one or all roles
 *   update       — write new identity/learned content (prompts for content)
 *   refresh     — reset identity.md + learned.md to empty templates (keep config/knowledge)
 *   consolidate  — optimize raw learned entries into a reviewed, consolidated document
 *   reset        — delete ALL project customizations for a role (rm -rf the dir)
 *   reset-all    — delete customizations for EVERY role
 */
export function buildAgentImproveCommand(opts: SlashCommandContext): SlashCommand {
  const projectRoot = opts.projectRoot;

  function listRoles(): string[] {
    try {
      return require('node:fs')
        .readdirSync(require('node:path').join(projectRoot, '.wrongstack', 'agents'), {
          withFileTypes: true,
        })
        .filter((d: import('node:fs').Dirent) => d.isDirectory())
        .map((d: import('node:fs').Dirent) => d.name);
    } catch {
      return [];
    }
  }

  return {
    name: 'agent-improve',
    category: 'Config',
    description:
      'Manage project-custom agent identities: show, update, refresh or reset per-role overrides.',
    help: [
      'Usage:',
      '  /agent-improve [role]                Show customization for a role (or all roles)',
      '  /agent-improve [role] show           Same as above',
      '  /agent-improve [role] update         Update identity + learned content',
      '  /agent-improve [role] refresh        Reset identity + learned to empty templates',
      '  /agent-improve [role] capture        Scan last output for ## LEARNED blocks and persist them',
      '  /agent-improve [role] consolidate    Optimize raw learned entries into a consolidated document',
      '  /agent-improve [role] reset          Delete ALL custom files for this role',
      '  /agent-improve * reset               Delete ALL custom files for every role',
      '',
      'Use without arguments to see which roles have project-customizations.',
      '',
      'Knowledge automation:',
      '  Agents output a ## LEARNED section in their response to persist',
      '  project-specific patterns. The runtime captures these automatically.',
      '  Use "capture" to manually re-scan any text for LEARNED blocks.',
      '  Use "consolidate" to synthesize all raw entries into a single',
      '  narrowly-scoped document that replaces raw entries in the agent prompt.',
      '',
      'Files live under: .wrongstack/agents/<role>/',
    ].join('\n'),

    async run(args: string) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const role = parts[0] || '';
      const action = parts[1] || 'show';

      if (!role) {
        // List all customized roles
        const roles = listRoles();
        if (roles.length === 0) {
          opts.renderer.write(
            'No project-custom agent identities found. Agents use their built-in catalog definitions.',
          );
          return {
            message:
              'No project-custom agent identities found. Run `/agent-improve <role> refresh` to scaffold one, or create `.wrongstack/agents/<role>/identity.md` manually.',
          };
        }
        const lines = roles.map((r: string) => {
          const cfg = loadProjectAgentConfig(r, projectRoot);
          const ident = loadProjectAgentIdentity(r, projectRoot);
          const learned = loadProjectAgentLearned(r, projectRoot);
          const kn = loadRoleKnowledgeManifest(r, projectRoot);
          const parts: string[] = [];
          if (cfg) parts.push('config');
          if (ident) parts.push('identity');
          if (learned) parts.push('learned');
          if (kn) parts.push('knowledge');
          return `  ${color.cyan(r.padEnd(24))} ${parts.join(', ') || '(empty directory)'}`;
        });
        const msg = `Project-custom agent roles:\n${lines.join('\n')}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      switch (action) {
        case 'show': {
          const cfg = loadProjectAgentConfig(role, projectRoot);
          const idText = loadProjectAgentIdentity(role, projectRoot);
          const learned = loadProjectAgentLearned(role, projectRoot);
          const kn = loadRoleKnowledgeManifest(role, projectRoot);
          const lines: string[] = [`${color.bold(role)} project identity:`];
          if (cfg) lines.push(`  config: ${JSON.stringify(cfg)}`);
          if (kn)
            lines.push(
              `  knowledge: ${kn.checklist.length} checks, ${Object.keys(kn.liveQueries ?? {}).length} live queries`,
            );
          if (idText) lines.push(`  identity: ${idText.length} chars`);
          if (learned) lines.push(`  learned: ${learned.length} chars`);
          if (!cfg && !idText && !learned && !kn) {
            lines.push('  (no customizations — uses built-in catalog definition)');
          }
          const msg = lines.join('\n');
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'update': {
          // The remaining args after "update" are treated as the content
          const content = parts.slice(2).join(' ');
          if (!content) {
            return {
              message: `Usage: /agent-improve ${role} update <identity content>\nOr edit files directly under .wrongstack/agents/${role}/`,
            };
          }
          const fp = updateProjectAgentIdentity(role, content, projectRoot);
          opts.renderer.write(`Updated identity for ${color.cyan(role)}: ${fp}`);
          return { message: `Project identity for "${role}" updated.` };
        }

        case 'refresh': {
          const result = refreshProjectAgentIdentity(role, projectRoot);
          opts.renderer.write(result);
          return { message: result };
        }

        case 'capture': {
          const storedOutput = opts.context?.meta['lastAgentOutput'];
          const recentOutput = typeof storedOutput === 'string' ? storedOutput : '';
          const captured = captureLearnedFromAgentOutput(recentOutput, role, projectRoot, true);
          if (captured > 0) {
            const msg = `Captured ${captured} learned item(s) for role "${role}". Use /agent-improve ${role} to see them.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          return {
            message: `No ## LEARNED blocks found in recent output for role "${role}".`,
          };
        }

        case 'consolidate': {
          const stats = getProjectAgentLearnStats(role, projectRoot);
          if (stats.entryCount === 0) {
            const msg = `No raw learned entries for role "${role}" to consolidate.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          const { instruction } = buildConsolidationInstruction(role, projectRoot);
          const prompt = `Optimize what the "${role}" agent has learned for its skills. ${instruction}`;
          const consolidatedAlready = isConsolidated(role, projectRoot);
          const meta = loadConsolidationMetadata(role, projectRoot);
          const summary =
            `${color.cyan(role)}: ${stats.entryCount} raw entries (${stats.totalBytes}B)` +
            (consolidatedAlready && meta
              ? ` · last consolidated ${meta.consolidatedAt.slice(0, 10)} (${meta.sourceBytes}B → ${meta.consolidatedBytes}B)`
              : ' · no prior consolidation') +
            '\n\nSending consolidation instruction to the agent...';
          opts.renderer.write(summary);
          return {
            message: summary,
            runText: prompt,
          };
        }

        case 'reset': {
          const removed = resetProjectAgentIdentity(role === '*' ? undefined : role, projectRoot);
          const msg =
            removed.length > 0
              ? `Reset ${color.cyan(role)} project identity. Removed: ${removed.join(', ')}`
              : `No customizations to reset for "${role}".`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'reset-all': {
          const removed = resetProjectAgentIdentity(undefined, projectRoot);
          const msg =
            removed.length > 0
              ? `Reset ALL project-custom agent identities.`
              : 'No customizations found to reset.';
          opts.renderer.write(msg);
          return { message: msg };
        }

        default:
          return {
            message: `Unknown action "${action}". Use: show, update, refresh, capture, consolidate, reset, or reset-all.`,
          };
      }
    },
  };
}
