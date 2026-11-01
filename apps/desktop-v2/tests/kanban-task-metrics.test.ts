import { expect, it } from 'vitest';
import { metricValue } from '../src/KanbanTaskMetrics';

it('sends numbers as numbers and other targets as text', () => {
  expect(metricValue(' 200 ')).toBe(200);
  expect(metricValue('-1.5')).toBe(-1.5);
  expect(metricValue('p95 < 200')).toBe('p95 < 200');
  expect(metricValue('  ')).toBeUndefined();
});
