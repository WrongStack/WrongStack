import type { SlashCommand } from '@wrongstack/core/types';
import { getKanbanWorkbench, type KanbanWorkbenchSnapshot } from '@wrongstack/kanban';

interface WorkbenchSlashDeps {
  projectRoot: string;
}

/** Text-first, bounded cross-board view for terminals where the visual panel is closed. */
export function createWorkbenchSlashCommand(deps: WorkbenchSlashDeps): SlashCommand {
  return {
    name: 'flow',
    aliases: ['workbench'],
    description: 'Show what is running, ready, blocked, and awaiting review across Kanban boards.',
    argsHint: '',
    category: 'App',
    help: [
      'Usage: /flow',
      '',
      'Shows the bounded project Kanban Workbench: lifecycle flow, focus lanes,',
      'placement reasons, hidden counts, and operational alerts.',
    ].join('\n'),
    async run() {
      try {
        const snapshot = await getKanbanWorkbench(deps.projectRoot, {
          limitPerLane: 3,
          alertLimit: 3,
        });
        return { message: renderWorkbenchReport(snapshot) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { message: `Kanban Workbench failed: ${message}` };
      }
    },
  };
}

export function renderWorkbenchReport(snapshot: KanbanWorkbenchSnapshot): string {
  const flow = snapshot.flow.map((stage) => `${stage.label} ${stage.count}`).join(' → ');
  const output = [
    '🧭 **Kanban Workbench**',
    '',
    `  ${flow}`,
    `  ${snapshot.boardCount} boards · ${snapshot.totals.active} active · ${snapshot.alertTotal} alerts`,
  ];

  const laneOrder = ['now', 'next', 'blocked', 'review'] as const;
  const laneLabels = { now: 'Now', next: 'Next', blocked: 'Blocked', review: 'Review' };
  for (const laneName of laneOrder) {
    const lane = snapshot.lanes[laneName];
    output.push('', `**${laneLabels[laneName]} (${lane.total})**`);
    if (lane.items.length === 0) output.push('  —');
    for (const item of lane.items) {
      const progress = item.childProgress
        ? ` · children ${item.childProgress.completed}/${item.childProgress.total}`
        : '';
      const contract = item.contractStatus
        ? ` · contract ${item.contractStatus.startReady ? 'start-ready' : `${item.contractStatus.setupGaps} setup gaps`}/${item.contractStatus.closed ? 'closed' : `${item.contractStatus.completionOpen} completion open`}`
        : '';
      output.push(
        `  ◆ ${item.title} · ${item.boardTitle} [${item.source}]${progress}${contract}`,
        `    ${item.reason}`,
      );
    }
    if (lane.omitted > 0) output.push(`  +${lane.omitted} more hidden by focus limit`);
  }

  if (snapshot.alertTotal > 0) {
    output.push('', `**Attention (${snapshot.alertTotal})**`);
    for (const alert of snapshot.alerts) {
      output.push(
        `  ${alert.severity === 'critical' ? '⚠' : '!'} ${alert.title}`,
        `    ${alert.detail}`,
      );
    }
    if (snapshot.alertsOmitted > 0) {
      output.push(`  +${snapshot.alertsOmitted} more alerts hidden by focus limit`);
    }
  }

  output.push('', '  Open `/kanban` to inspect or update the authoritative card.');
  return output.join('\n');
}
