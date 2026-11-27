import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskItem } from '../../src/components/TaskCard';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const { TaskCard } = await import('../../src/components/TaskCard');

const task: TaskItem = {
  id: 't1',
  title: 'Broken task',
  description: 'Needs attention',
  status: 'failed',
  priority: 'high',
  type: 'bugfix',
  tags: [],
};

afterEach(cleanup);

const STATUS_CASES = [
  ['pending', 'activity:task.statusPending'],
  ['in_progress', 'activity:task.statusInProgress'],
  ['blocked', 'activity:task.statusBlocked'],
  ['failed', 'activity:task.statusFailed'],
  ['review', 'activity:task.statusReview'],
  ['completed', 'activity:task.statusDone'],
] as const;

it.each(STATUS_CASES)('names the %s status graphic for screen readers', (status, label) => {
  render(<TaskCard task={{ ...task, status }} compact />);

  // Control: the real card and its status graphic rendered together.
  expect(screen.getByText('Broken task')).toBeTruthy();
  expect(screen.getByRole('img', { name: label })).toBeTruthy();
});
