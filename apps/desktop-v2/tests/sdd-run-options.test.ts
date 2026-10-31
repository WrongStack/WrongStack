import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunOptions, runModelPayload } from '../src/SddRunOptions';

const base = {
  slots: 4,
  setSlots: () => {},
  isolate: false,
  setIsolate: () => {},
  decompose: false,
  setDecompose: () => {},
  setModel: () => {},
};

describe('SDD run worker model', () => {
  it('sends a provider and model together, or neither', () => {
    expect(runModelPayload({ provider: 'zai', model: 'glm-5.3' })).toEqual({
      provider: 'zai',
      model: 'glm-5.3',
    });
    expect(runModelPayload({ provider: 'zai', model: '' })).toEqual({});
    expect(runModelPayload({ provider: '', model: '' })).toEqual({});
  });

  it('offers the choice only when the profile can be read, defaulting to the project engine', () => {
    const without = renderToStaticMarkup(
      createElement(RunOptions, { ...base, model: { provider: '', model: '' } }),
    );
    expect(without).not.toContain('Worker provider');
    const withCommand = renderToStaticMarkup(
      createElement(RunOptions, {
        ...base,
        model: { provider: 'zai', model: 'glm-5.3' },
        command: async () => ({}),
      }),
    );
    expect(withCommand).toContain('aria-label="Worker provider"');
    expect(withCommand).toContain('Project engine default');
    // A saved choice stays selectable before the catalog answers.
    expect(withCommand).toContain('<option selected="">glm-5.3</option>');
  });
});
