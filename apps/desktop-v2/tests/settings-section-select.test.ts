import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSectionSelect } from '../src/SettingsSectionSelect';

const sections = [
  { id: 'providers', title: 'Providers & models', group: 'Models' },
  { id: 'cost-tiers', title: 'Cost tiers', group: 'Models' },
  { id: 'execution', title: 'Execution & permissions', group: 'Conversations' },
];

describe('narrow settings section picker', () => {
  it('groups the sections like the list and selects the open one', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSectionSelect, { sections, section: 'cost-tiers', onSelect: () => {} }),
    );
    expect(html).toContain('<optgroup label="Models">');
    expect(html).toContain('<optgroup label="Conversations">');
    expect(html).toContain('<option value="cost-tiers" selected="">Cost tiers</option>');
    expect(html).not.toContain('Choose a section');
  });

  it('asks for a choice when a search hides the open section', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSectionSelect, {
        sections: sections.slice(2),
        section: 'cost-tiers',
        onSelect: () => {},
      }),
    );
    expect(html).toContain('<option value="" selected="">Choose a section</option>');
  });
});
