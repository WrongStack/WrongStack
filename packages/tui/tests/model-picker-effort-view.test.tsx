import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ModelPicker, type ProviderOption } from '../src/components/model-picker.js';
import { EFFORT_KEEP } from '../src/components/model-picker-effort.js';

const providers: ProviderOption[] = [
  {
    id: 'openai',
    family: 'gpt',
    models: ['o3', 'gpt-4o'],
    modelDetails: {
      o3: { reasoning: true, effortLevels: ['low', 'high'] },
      'gpt-4o': { reasoning: false },
    },
  },
];

function view(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  return render(
    React.createElement(ModelPicker, {
      step: 'model',
      providerOptions: providers,
      modelOptions: ['o3', 'gpt-4o'],
      filteredOptions: ['o3', 'gpt-4o'],
      selected: 0,
      pickedProviderId: 'openai',
      columns: 140,
      ...props,
    }),
  );
}

describe('ModelPicker effort strip', () => {
  it('advertises ←/→ and chips the focused row only when the model reasons', () => {
    const v = view({ effortOptions: [EFFORT_KEEP, 'low', 'high'], effortChoice: 'high' });
    const frame = v.lastFrame() ?? '';
    expect(frame).toContain('←/→ effort');
    expect(frame).toContain('‹ high ›');
    expect(frame).toContain('[high]');
    // The detail panel wraps, so assert on the un-wrapped fragment only.
    expect(frame).toContain('saves reasoning');
    v.unmount();
  });

  it('hides the strip and keeps the original Enter copy without options', () => {
    const v = view();
    const frame = v.lastFrame() ?? '';
    expect(frame).not.toContain('←/→ effort');
    expect(frame).toContain('not adjustable for this model');
    expect(frame).toContain('Enter switches the active session');
    expect(frame).not.toContain('saves reasoning');
    v.unmount();
  });

  it('does not promise a save while the default sentinel is selected', () => {
    const v = view({ effortOptions: [EFFORT_KEEP, 'low', 'high'], effortChoice: EFFORT_KEEP });
    const frame = v.lastFrame() ?? '';
    expect(frame).toContain('‹ default ›');
    expect(frame).toContain('Enter switches the active session');
    expect(frame).not.toContain('saves reasoning');
    v.unmount();
  });
});
