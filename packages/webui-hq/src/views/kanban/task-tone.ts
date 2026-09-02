import type { BadgeTone } from '../../components/ui/badge.js';

/** Card status -> badge tone. One table so the board, the inspector and the
 *  queue strip agree on what "review" looks like. */
export function taskStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'completed':
      return 'active';
    case 'in_progress':
      return 'running';
    case 'review':
      return 'warn';
    case 'blocked':
    case 'failed':
      return 'error';
    case 'ready':
      return 'info';
    default:
      return 'idle';
  }
}

export function taskPriorityTone(priority: string): BadgeTone {
  switch (priority) {
    case 'critical':
      return 'error';
    case 'high':
      return 'warn';
    case 'medium':
      return 'info';
    default:
      return 'idle';
  }
}
