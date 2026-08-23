import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureLearnedFromAgentOutputDetailed,
  getProjectAgentLearnStats,
  listProjectSkillAugmentations,
  loadConsolidationMetadata,
  loadProjectAgentConfig,
  loadProjectAgentIdentity,
  loadProjectAgentLearned,
  loadProjectSkillAugmentation,
  loadRoleKnowledgeManifest,
  loadSkillAffinity,
  optimizeProjectAgentLearning,
  refreshProjectAgentIdentity,
  resetProjectAgentIdentity,
  resolveRoleSkillCandidates,
  setSkillPinned,
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
 *   capture      — re-scan the last turn for ## LEARNED blocks
 *   optimize     — distil captures into per-skill addenda + a consolidated document
 *                  (alias: consolidate)
 *   skills       — list skills with project affinity; show or pin one
 *   reset        — delete ALL project customizations for a role (rm -rf the dir)
 *   reset-all    — delete customizations for EVERY role
 */
export function buildAgentImproveCommand(opts: SlashCommandContext): SlashCommand {
  const projectRoot = opts.projectRoot;

  function listRoles(): string[] {
    try {
      return readdirSync(join(projectRoot, '.wrongstack', 'agents'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  return {
    name: 'agent-improve',
    category: 'Config',
    description:
      'Inspect and develop a roster agent for this project: learned directives, per-skill project addenda and the optimization pass.',
    help: [
      'Usage:',
      '  /agent-improve [role]                Show customization for a role (or all roles)',
      '  /agent-improve [role] show           Same as above',
      '  /agent-improve [role] update         Update identity + learned content',
      '  /agent-improve [role] refresh        Reset identity + learned to empty templates',
      '  /agent-improve [role] capture        Scan last output for ## LEARNED blocks and persist them',
      '  /agent-improve [role] optimize       Distil learning into skill addenda + a consolidated doc',
      "  /agent-improve [role] skills         Show the role's skills, affinity and project addenda",
      "  /agent-improve [role] skills <skill> Show one skill's project addendum",
      '  /agent-improve [role] skills <skill> pin|unpin   Always/never keep this skill loaded',
      '  /agent-improve [role] reset          Delete ALL custom files for this role',
      '  /agent-improve * reset               Delete ALL custom files for every role',
      '',
      'Use without arguments to see which roles have project-customizations.',
      '',
      'Learning loop (runs on its own):',
      '  Agents end a run with a ## LEARNED block, optionally tagged with the',
      '  skill it refines: `## LEARNED [skill: testing]`. The runtime captures it,',
      '  routes it to that skill, and a background pass distils it into that skill’s',
      '  project addendum — injected beneath the bundled skill body on the next spawn.',
      '  Capture also runs on failed tasks. Use "capture" to re-scan the last turn',
      '  by hand and "optimize" to force a distillation early.',
      '',
      'Files live under: .wrongstack/agents/<role>/ (committed; skills/affinity.json',
      'and archive/ stay local). Disable the automatic pass with',
      'fleet.learning.autoOptimize.enabled = false.',
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
          const developedSkills = listProjectSkillAugmentations(role, projectRoot);
          const stats = getProjectAgentLearnStats(role, projectRoot);
          const lines: string[] = [`${color.bold(role)} project identity:`];
          if (developedSkills.length > 0) {
            lines.push(`  skills developed: ${developedSkills.join(', ')}`);
          }
          if (stats.entryCount > 0) {
            // Capture volume says nothing about whether the role is learning
            // useful things. The hit rate and the dead share do.
            const hitRate =
              stats.directiveHitRate === null
                ? 'no directive exercised yet'
                : `${Math.round(stats.directiveHitRate * 100)}% hit rate over ${stats.appliedEntryCount} exercised`;
            lines.push(
              `  directives: ${stats.entryCount} buffered · ${hitRate} · ${stats.deadEntryCount} never used`,
            );
          }
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
          if (!recentOutput) {
            return {
              message:
                'No agent output recorded yet in this session. Run a turn first, then re-run capture.',
            };
          }
          const result = captureLearnedFromAgentOutputDetailed(
            recentOutput,
            role,
            projectRoot,
            true,
          );
          if (result.captured > 0) {
            const routed = result.skills?.length
              ? ` Routed to skill(s): ${result.skills.join(', ')}.`
              : '';
            const msg = `Captured ${result.captured} learned item(s) for role "${role}".${routed} Use /agent-improve ${role} to see them.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          return {
            message:
              result.reason ??
              `No ## LEARNED blocks found in recent output for role "${role}" (status: ${result.status}).`,
          };
        }

        case 'optimize':
        case 'consolidate': {
          const stats = getProjectAgentLearnStats(role, projectRoot);
          if (stats.entryCount === 0) {
            const msg = `No raw learned entries for role "${role}" to optimize.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          const before = loadConsolidationMetadata(role, projectRoot);
          opts.renderer.write(
            `${color.cyan(role)}: optimizing ${stats.entryCount} directive(s) (${stats.totalBytes}B)` +
              (before
                ? ` · last optimized ${before.consolidatedAt.slice(0, 10)}`
                : ' · no prior optimization') +
              '…',
          );
          const llm =
            opts.llmProvider && opts.llmModel
              ? { provider: opts.llmProvider, model: opts.llmModel }
              : undefined;
          const result = await optimizeProjectAgentLearning(role, projectRoot, {
            ...(llm ? { llm } : {}),
            trigger: 'manual',
          });
          const skillNote = result.skills.length
            ? ` Skill addenda refreshed: ${result.skills.join(', ')}.`
            : '';
          switch (result.status) {
            case 'optimized': {
              const after = loadConsolidationMetadata(role, projectRoot);
              const msg =
                `Optimized "${role}": ${result.rawEntryCount} directive(s) → ${after?.consolidatedBytes ?? 0}B consolidated.` +
                skillNote +
                (result.pruned ? ' Raw buffer archived and reset.' : '');
              opts.renderer.write(msg);
              return { message: msg };
            }
            case 'empty-synthesis':
              return {
                message: `Model "${result.model}" returned an empty document; the existing knowledge for "${role}" was left untouched.${skillNote}`,
              };
            case 'failed':
              return { message: `Optimization failed for "${role}": ${result.error}${skillNote}` };
            case 'no-llm':
              // No provider on this session — hand the role-level instruction
              // to the chat agent, which can write the document itself.
              return {
                message: `No active model; routing the "${role}" consolidation through the agent.${skillNote}`,
                runText:
                  `${result.instruction}\n\n---\n\nWhen the document is ready, save it to ` +
                  `.wrongstack/agents/${role}/consolidated.md — or re-run the optimization ` +
                  `with a model configured so the runtime persists it for you.`,
              };
            default:
              return { message: `Nothing to optimize for "${role}".` };
          }
        }

        case 'skills': {
          const candidates = resolveRoleSkillCandidates(role, projectRoot);
          const developed = listProjectSkillAugmentations(role, projectRoot);
          const affinity = loadSkillAffinity(role, projectRoot);
          const target = parts[2];
          if (target && parts[3]) {
            const skillAction = parts[3];
            if (skillAction !== 'pin' && skillAction !== 'unpin') {
              return { message: `Unknown skill action "${skillAction}". Use pin or unpin.` };
            }
            setSkillPinned(role, target, skillAction === 'pin', projectRoot);
            const msg = `${skillAction === 'pin' ? 'Pinned' : 'Unpinned'} skill "${target}" for role "${role}".`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          if (target) {
            const body = loadProjectSkillAugmentation(role, target, projectRoot);
            const msg = body
              ? `${color.bold(`${role} · ${target}`)}\n\n${body}`
              : `No project addendum for skill "${target}" on role "${role}" yet.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          const skillLines = candidates.map((skill) => {
            const entry = affinity.entries[skill];
            const marks = [
              developed.includes(skill) ? 'developed' : '',
              entry?.pinned ? 'pinned' : '',
              entry?.learned ? `${entry.learned} learned` : '',
              entry ? `${entry.succeeded}✓/${entry.failed}✗ of ${entry.loaded} loads` : 'unused',
            ].filter(Boolean);
            return `  ${color.cyan(skill.padEnd(22))} ${marks.join(' · ')}`;
          });
          const msg = candidates.length
            ? `Skills for ${color.bold(role)}:\n${skillLines.join('\n')}`
            : `Role "${role}" has no curated skills.`;
          opts.renderer.write(msg);
          return { message: msg };
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
            message: `Unknown action "${action}". Use: show, update, refresh, capture, optimize, skills, reset, or reset-all.`,
          };
      }
    },
  };
}
