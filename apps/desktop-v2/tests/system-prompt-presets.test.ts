import { expect, it } from 'vitest';
import { effectivePreset, promptIssues, promptPresets } from '../src/system-prompt-presets-model';

it('reads presets and per-variant selections, ignoring unknown variants', () => {
  const catalog = promptPresets({
    presets: [
      {
        id: 'p1',
        name: 'Terse',
        baseVariant: 'default',
        text: 'Be brief.',
        revision: 2,
        sourceChanged: true,
        currentBaseText: 'New built-in',
        baseText: 'Old built-in',
      },
      { id: 'bad', baseVariant: 'unknown' },
    ],
    active: { default: 'p1', bogus: 'x' },
    projectActive: {},
    selectedId: 'p1',
  });
  expect(catalog.presets).toHaveLength(1);
  expect(catalog.presets[0]).toMatchObject({ id: 'p1', revision: 2, sourceChanged: true });
  expect(catalog.active).toEqual({ default: 'p1' });
  expect(catalog.selectedId).toBe('p1');
});

it('prefers the project choice over the profile choice', () => {
  expect(effectivePreset('pro', { pro: 'a' }, { pro: 'b' })).toEqual({ id: 'b', scope: 'project' });
  expect(effectivePreset('pro', { pro: 'a' }, {})).toEqual({ id: 'a', scope: 'profile' });
  expect(effectivePreset('lite', {}, {})).toEqual({ id: '', scope: 'built-in' });
});

it('reads validation issues', () => {
  expect(
    promptIssues({ issues: [{ severity: 'error', line: 3, message: 'Unknown tool foo.' }, {}] }),
  ).toEqual([
    { severity: 'error', line: 3, message: 'Unknown tool foo.' },
    { severity: 'warning', line: 1, message: '' },
  ]);
});
