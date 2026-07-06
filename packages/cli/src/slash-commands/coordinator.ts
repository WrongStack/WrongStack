import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildCoordinatorCommand(opts: SlashCommandContext): SlashCommand {
  const getStart = () => opts.onCoordinatorStart ?? opts.coordinatorController?.onCoordinatorStart;
  const getStop = () => opts.onCoordinatorStop ?? opts.coordinatorController?.onCoordinatorStop;
  const getTasks = () => opts.onCoordinatorTasks ?? opts.coordinatorController?.onCoordinatorTasks;
  const getClaim = () => opts.onCoordinatorClaim ?? opts.coordinatorController?.onCoordinatorClaim;
  const getComplete = () => opts.onCoordinatorComplete ?? opts.coordinatorController?.onCoordinatorComplete;
  const getFail = () => opts.onCoordinatorFail ?? opts.coordinatorController?.onCoordinatorFail;
  const getStatus = () => opts.onCoordinatorStatus ?? opts.coordinatorController?.onCoordinatorStatus;

  return {
    name: 'coordinator',
    category: 'Agent',
    description:
      'Start, stop, or inspect the AutonomousCoordinator — the fleet brain that auctions tasks and consults Brain for risky decisions.',
    help: [
      'Usage:',
      '  /coordinator start <goal>       Start the coordinator with a goal',
      '  /coordinator stop               Stop the running coordinator',
      '  /coordinator status             Show current coordinator status',
      '  /coordinator tasks              List available tasks the current terminal can claim',
      '  /coordinator claim <id>         Claim a task and inject its description as the next prompt',
      '  /coordinator done <id> [note]   Mark a claimed task as completed',
      '  /coordinator fail <id> <reason> Mark a claimed task as failed',
      '',
      'The AutonomousCoordinator runs alongside the agent loop and:',
      '  • Maintains a shared knowledge graph of facts and decisions',
      '  • Breaks work into a task DAG and auctions tasks to subagents',
      '  • Consults the Brain for risky decisions',
      '  • Uses ConsensusProtocol to vote on multi-agent changes',
      '',
      'It is separate from /autonomy eternal — both can run concurrently.',
      '',
      'Terminals are eligible workers: an open terminal can discover and claim',
      'pending tasks without spawning a subagent.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();
      const [verbRaw, ...rest] = trimmed.split(/\s+/);
      const verb = (verbRaw ?? '').toLowerCase();

      if (verb === 'start') {
        const goal = rest.join(' ').trim();
        if (!goal) {
          return { message: 'Usage: /coordinator start <goal>\nA goal is required to start the coordinator.' };
        }
        getStart()?.(goal);
        return {
          message: `AutonomousCoordinator started with goal: "${goal}"\nUse /coordinator status to monitor progress.`,
        };
      }

      if (verb === 'stop') {
        getStop()?.();
        return { message: 'AutonomousCoordinator stop signal sent.' };
      }

      if (verb === 'tasks') {
        const tasksFn = getTasks();
        if (!tasksFn) {
          return { message: 'Coordinator task listing is not wired in this surface.' };
        }
        const tasks = await tasksFn();
        if (!tasks) {
          return { message: 'No coordinator is active. Start one with /coordinator start <goal>.' };
        }
        if (tasks.length === 0) {
          return { message: 'No pending coordinator tasks. Use /coordinator status for overall progress.' };
        }
        const lines = ['Pending coordinator tasks available to claim:'];
        for (const task of tasks) {
          lines.push(`  ${task.id}  [${task.priority}] ${task.title}${task.tags.length > 0 ? `  · ${task.tags.join(', ')}` : ''}`);
        }
        lines.push('', 'Claim one with /coordinator claim <id> (id prefix allowed).');
        return { message: lines.join('\n') };
      }

      if (verb === 'claim') {
        const target = rest.join(' ').trim();
        if (!target) {
          return { message: 'Usage: /coordinator claim <taskId>' };
        }
        const claimFn = getClaim();
        if (!claimFn) {
          return { message: 'Coordinator task claiming is not wired in this surface.' };
        }
        const tasks = await getTasks()?.();
        const matched = tasks?.find((task) => task.id === target || task.id.startsWith(target));
        if (!matched) {
          return { message: `No pending coordinator task matched "${target}".` };
        }
        const result = await claimFn(matched.id);
        if (typeof result === 'string') return { message: result };
        if (result === null) return { message: 'No coordinator is active.' };
        const description = result.description ?? matched.title;
        return {
          message: `Claimed task ${matched.id.slice(0, 8)}: ${matched.title}`,
          runText: `Work on this coordinator task (id: ${matched.id}):\n\n${description}`,
        };
      }

      if (verb === 'done' || verb === 'complete') {
        const taskId = rest[0]?.trim() ?? '';
        if (!taskId) {
          return { message: 'Usage: /coordinator done <taskId> [note]' };
        }
        const completeFn = getComplete();
        if (!completeFn) {
          return { message: 'Coordinator task completion is not wired in this surface.' };
        }
        const note = rest.slice(1).join(' ').trim();
        const err = await completeFn(taskId, note || undefined);
        if (err) return { message: err };
        return { message: `Task ${taskId.slice(0, 8)} marked completed.` };
      }

      if (verb === 'fail') {
        const taskId = rest[0]?.trim() ?? '';
        if (!taskId) {
          return { message: 'Usage: /coordinator fail <taskId> <reason>' };
        }
        const failFn = getFail();
        if (!failFn) {
          return { message: 'Coordinator task failure reporting is not wired in this surface.' };
        }
        const reason = rest.slice(1).join(' ').trim() || 'Terminal worker reported failure';
        const err = await failFn(taskId, reason);
        if (err) return { message: err };
        return { message: `Task ${taskId.slice(0, 8)} marked failed: ${reason}` };
      }

      if (verb === 'status') {
        // TUI mode: open the coordinator monitor panel.
        if (opts.onPanelOpen?.current) {
          const opened = opts.onPanelOpen.current('toggleCoordinatorMonitor');
          if (opened) return { message: '' };
        }
        const statusFn = getStatus();
        if (statusFn) {
          const stats = await statusFn();
          if (!stats) {
            return { message: 'No coordinator is active. Start one with /coordinator start <goal>.' };
          }
          const lines = [
            'Coordinator Status:',
            `  Goals: ${stats.goals.total} total · ${stats.goals.done} done · ${stats.goals.pending} pending · ${stats.goals.failed} failed`,
            `  DAG:   ${stats.dag.running} running · ${stats.dag.ready} ready · ${stats.dag.done} done · ${stats.dag.failed} failed`,
            `  Auction: ${stats.auction.pending} pending · ${stats.auction.inProgress} in progress`,
          ];
          if (stats.goals.pending > 0 || stats.auction.pending > 0) {
            lines.push('', 'Use /coordinator tasks to list claimable work.');
          }
          return { message: lines.join('\n') };
        }
        const canStart = getStart() != null;
        const canStop = getStop() != null;
        return {
          message: [
            `Coordinator wired: start=${canStart ? 'yes' : 'no'}, stop=${canStop ? 'yes' : 'no'}`,
            'Use F9 in the TUI for the full coordinator panel.',
          ].join('\n'),
        };
      }

      return {
        message: [
          'Usage:',
          '  /coordinator start <goal>       Start with a goal',
          '  /coordinator stop               Stop the coordinator',
          '  /coordinator status             Show status',
          '  /coordinator tasks              List tasks this terminal can claim',
          '  /coordinator claim <id>         Claim a task and inject its description',
          '  /coordinator done <id> [note]   Mark a claimed task as completed',
          '  /coordinator fail <id> <reason> Mark a claimed task as failed',
          '',
          'The coordinator is a fleet brain that:',
          '  • Auctions tasks to subagents via TaskAuctioneer',
          '  • Maintains a shared KnowledgeGraph',
          '  • Consults Brain for risky decisions',
          '  • Uses ConsensusProtocol for multi-agent votes',
        ].join('\n'),
      };
    },
  };
}
