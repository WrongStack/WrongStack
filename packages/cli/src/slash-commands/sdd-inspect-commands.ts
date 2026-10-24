import type { SlashCommand, SpecRequirement } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
import {
  analyzeCriticalPath,
  getTemplate,
  listTemplates,
  renderProgress,
  renderSpecAnalysis,
  renderTaskGraph,
  SpecParser,
  type SpecVersion,
  TaskGraphStore,
  templateToMarkdown,
} from '@wrongstack/sdd';
import { findSpec } from '../services/sdd/project-context.js';
import { sddState } from '../services/sdd/state.js';
import { formatElapsed, getTaskProgress } from '../services/sdd/task-manager.js';
import {
  formatBlockedTasks,
  formatCriticalPathAnalysis,
  formatCurrentSpec,
  formatGraphListFallback,
  formatNextTaskView,
  formatSddStatusView,
  formatSpecList,
  formatTaskListView,
  sortTasksForSddDisplay,
} from './sdd-format.js';
export async function runSddInspectCommand(inputs: {
  cmd: string;
  opts: import('./command-context.js').SlashCommandContext;
  specStore: import('@wrongstack/sdd').SpecStore;
  restJoined: string;
  versioning: import('@wrongstack/sdd').SpecVersioning;
}): ReturnType<SlashCommand['run']> {
  const { cmd, opts, specStore, restJoined, versioning } = inputs;
  if (!opts.paths) return { message: 'SDD not available — paths not configured.' };

  switch (cmd) {
    case 'spec': {
      const specBuilder = sddState.getBuilder();
      if (!specBuilder) {
        return { message: 'No active SDD session. Use /sdd new to start one.' };
      }

      const specSession = specBuilder.getSession();
      if (!specSession.spec) {
        return {
          message:
            specSession.phase === 'questioning'
              ? "No spec generated yet. Keep answering the AI's questions."
              : 'No spec in this session.',
        };
      }

      return { message: formatCurrentSpec(specSession.spec) };
    }

    case 'tasks':

    case 'task': {
      const taskTracker = sddState.getTaskTracker();
      if (!taskTracker) {
        return { message: 'No tasks generated yet. Use /sdd new to start.' };
      }

      const nodes = taskTracker.getAllNodes();
      if (nodes.length === 0) {
        return { message: 'No tasks in the current graph.' };
      }

      const progress = taskTracker.getProgress();
      const builder = sddState.getBuilder();
      const phase = builder?.getPhase() ?? 'unknown';
      // Sort: in_progress first, then pending, then others
      const sorted = sortTasksForSddDisplay(nodes);
      return {
        message: formatTaskListView(sorted, progress, phase, renderProgress, formatElapsed),
      };
    }

    // ── Next Task Preview ─────────────────────────────────────────────

    case 'next': {
      const nextTracker = sddState.getTaskTracker();
      if (!nextTracker) {
        return { message: 'No tasks generated yet. Use /sdd new to start.' };
      }

      const pending = nextTracker.getAllNodes({ status: ['pending', 'in_progress'] });
      if (pending.length === 0) {
        const allDone = nextTracker.getProgress();
        if (allDone.completed === allDone.total) {
          return { message: '🎉 All tasks completed! Run /sdd status for the full summary.' };
        }
        return { message: 'No pending tasks.' };
      }

      // Find the next executable task (pending with all blockers completed)
      const next = pending.find((n) => nextTracker.canStart(n.id));
      if (!next) {
        // All pending tasks are blocked
        const blocked = pending.filter((n) => {
          const blockers = nextTracker.getBlockers(n.id);
          return blockers.some((id) => nextTracker.getNode(id)?.status !== 'completed');
        });
        if (blocked.length > 0) {
          return { message: formatBlockedTasks(blocked, nextTracker) };
        }
        return { message: 'No next task found.' };
      }

      const progress = nextTracker.getProgress();
      return {
        message: formatNextTaskView(next, progress, nextTracker, formatElapsed),
      };
    }

    // ── Session Management ─────────────────────────────────────────────

    case 'status': {
      const statusBuilder = sddState.getBuilder();
      if (!statusBuilder) {
        return { message: 'No active SDD session.' };
      }

      const session = statusBuilder.getSession();
      const progress = getTaskProgress();
      const sessionElapsed = sddState.getSessionElapsed();
      const phaseElapsed = sddState.getPhaseElapsed();

      return {
        message: formatSddStatusView(
          session,
          progress,
          sddState.getTaskTracker(),
          sessionElapsed,
          phaseElapsed,
          renderProgress,
          formatElapsed,
        ),
      };
    }

    // ── Task Graph Visualization ──────────────────────────────────────

    case 'graph': {
      const graphTracker = sddState.getTaskTracker();
      if (!graphTracker) {
        return { message: 'No tasks generated yet. Use /sdd new to start.' };
      }

      const graphId = sddState.getTaskGraphId();
      if (!graphId) {
        // Show basic list view
        const nodes = graphTracker.getAllNodes();
        if (nodes.length === 0) {
          return { message: 'No tasks in the current graph.' };
        }
        const progress = graphTracker.getProgress();
        const sorted = sortTasksForSddDisplay(nodes);
        return { message: formatGraphListFallback(sorted, progress, renderProgress) };
      }

      // Try to load from store
      try {
        const graphStore = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });
        const stored = await graphStore.load(graphId);
        if (stored) {
          return { message: renderTaskGraph(stored, { compact: false }) };
        }
      } catch {
        // fall through to basic view
      }

      // Basic fallback
      const nodes = graphTracker.getAllNodes();
      if (nodes.length === 0) {
        return { message: 'No tasks in the current graph.' };
      }
      const progress = graphTracker.getProgress();
      const lines = [renderProgress(progress), ''];
      const sorted = [...nodes].sort((a, b) => {
        const order: Record<string, number> = {
          in_progress: 0,
          pending: 1,
          review: 2,
          blocked: 3,
          failed: 4,
          completed: 5,
        };
        return (order[a.status] ?? 6) - (order[b.status] ?? 6);
      });
      for (let i = 0; i < sorted.length; i++) {
        const n = expectDefined(sorted[i]);
        const status =
          n.status === 'completed'
            ? '✅'
            : n.status === 'in_progress'
              ? '🔄'
              : n.status === 'failed'
                ? '❌'
                : n.status === 'blocked'
                  ? '🚫'
                  : n.status === 'review'
                    ? '👁'
                    : '⏳';
        lines.push(`${i + 1}. ${status} [${n.priority}] ${n.title}`);
      }
      return { message: lines.join('\n') };
    }

    // ── Spec Browsing ──────────────────────────────────────────────────

    case 'list':

    case 'ls': {
      const entries = await specStore.list();
      if (entries.length === 0) {
        return { message: 'No specs saved. Use /sdd new to create one.' };
      }

      return { message: formatSpecList(entries) };
    }

    case 'show':

    case 'view': {
      const spec = await findSpec(specStore, restJoined);
      if (!spec) return { message: `Spec "${restJoined}" not found.` };

      const parser = new SpecParser();
      const analysis = parser.analyze(spec);

      return {
        message: [
          `# ${spec.title}`,
          `Version: ${spec.version} | Status: ${spec.status}`,
          '',
          '## Overview',
          spec.overview,
          '',
          `## Requirements (${spec.requirements.length})`,
          ...spec.requirements.map((r: SpecRequirement) => {
            const tags = `[${r.type}][${r.priority}]`;
            const ac =
              r.acceptanceCriteria.length > 0 ? `\n    AC: ${r.acceptanceCriteria.join(', ')}` : '';
            return `- ${tags} ${r.description}${ac}`;
          }),
          '',
          renderSpecAnalysis(spec, {
            completeness: analysis.completeness,
            gaps: analysis.gaps,
            risks: analysis.risks.map((r) => r.risk),
            suggestions: analysis.suggestions,
          }),
        ].join('\n'),
      };
    }

    case 'templates': {
      const templates = listTemplates();
      const lines = templates.map(
        (t: { id: string; name: string; description: string }) =>
          `  ${t.id}: ${t.name} — ${t.description}`,
      );
      return {
        message: `Available Templates:\n${lines.join('\n')}`,
      };
    }

    case 'from': {
      const templateId = restJoined || 'feature';
      const template = getTemplate(templateId);
      if (!template) {
        return {
          message: `Template "${templateId}" not found.\nAvailable: ${listTemplates()
            .map((t: { id: string }) => t.id)
            .join(', ')}`,
        };
      }

      const skeleton = templateToMarkdown(template, 'New Specification');
      const spec = await specStore.createDraft('New Specification');
      await specStore.update(spec.id, { sections: [] });

      return {
        message: [
          `Created draft spec from template "${template.name}".`,
          `ID: ${spec.id}`,
          '',
          'Edit the spec through the AI conversation or /sdd show to review.',
          '',
          skeleton,
        ].join('\n'),
      };
    }

    case 'version':

    case 'history': {
      const spec = await findSpec(specStore, restJoined);
      if (!spec) return { message: `Spec "${restJoined}" not found.` };

      const history = versioning.getHistory(spec.id);
      if (history.length === 0) {
        return {
          message: `No version history for "${spec.title}".`,
        };
      }

      const lines = history.map(
        (v: SpecVersion, i: number) =>
          `${i + 1}. v${v.version} — ${new Date(v.timestamp).toISOString()}${v.changeDescription ? ` (${v.changeDescription})` : ''}`,
      );
      return {
        message: `Version History for "${spec.title}":\n${lines.join('\n')}`,
      };
    }

    case 'critical':

    case 'bottleneck': {
      const critTracker = sddState.getTaskTracker();
      if (!critTracker) {
        return { message: 'No tasks generated yet. Use /sdd new to start.' };
      }

      const graphId = sddState.getTaskGraphId();
      if (!graphId) {
        return { message: 'No task graph found. Generate tasks first.' };
      }

      try {
        const graphStore = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });
        const graph = await graphStore.load(graphId);
        if (!graph) {
          return { message: 'Could not load task graph.' };
        }

        const analysis = analyzeCriticalPath(graph);
        return { message: formatCriticalPathAnalysis(graph, analysis) };
      } catch {
        return { message: 'Could not analyze critical path.' };
      }
    }
  }
  throw new Error('Unhandled delegated case');
}
