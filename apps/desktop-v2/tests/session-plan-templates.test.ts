import { expect, it } from 'vitest';
import { readPlanTemplates } from '../src/SessionPlanTemplates';

it('reads plan templates and drops malformed ones', () => {
  expect(
    readPlanTemplates([
      {
        name: 'new-feature',
        description: 'Add a feature',
        category: 'development',
        items: [{ title: 'Spec', details: 'Scope' }, { title: 'Ship' }, { details: 'x' }],
      },
      { description: 'no name' },
    ]),
  ).toEqual([
    {
      name: 'new-feature',
      description: 'Add a feature',
      category: 'development',
      items: [
        { title: 'Spec', details: 'Scope' },
        { title: 'Ship', details: '' },
      ],
    },
  ]);
  expect(readPlanTemplates(undefined)).toEqual([]);
});
