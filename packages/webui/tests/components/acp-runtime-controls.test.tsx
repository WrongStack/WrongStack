import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AcpRuntimeOptionsResult } from '@wrongstack/contracts/types/acp-runtime';
import { AcpRuntimeControls } from '@wrongstack/project-surfaces/ui/AcpRuntimeControls';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(cleanup);
const snapshot: AcpRuntimeOptionsResult = {
  agentId: 'fixture',
  applied: {},
  options: [
    {
      id: 'engine',
      name: 'Model',
      category: 'model',
      currentValue: 'fast',
      options: [
        { value: 'fast', name: 'Fast' },
        { value: 'vendor/deep', name: 'Deep' },
      ],
    },
    {
      id: 'thought',
      name: 'Effort',
      category: 'thought_level',
      currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }],
    },
  ],
};
it('loads on demand, refreshes model-dependent options and saves the exact native model id', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({
      ...snapshot,
      options: [
        { ...snapshot.options[0], currentValue: 'vendor/deep' },
        {
          ...snapshot.options[1],
          currentValue: 'ultra',
          options: [{ value: 'ultra', name: 'Ultra' }],
        },
      ],
    });
  const save = vi.fn();
  const { container } = render(
    <AcpRuntimeControls
      agentId="fixture"
      values={{ thought: 'low' }}
      request={request}
      onChange={save}
    />,
  );
  expect(request).not.toHaveBeenCalled();
  container.querySelector('details')!.open = true;
  fireEvent(container.querySelector('details')!, new Event('toggle'));
  await screen.findByLabelText('ACP Model');
  fireEvent.change(screen.getByLabelText('ACP Model'), { target: { value: 'vendor/deep' } });
  await waitFor(() => expect(save).toHaveBeenCalledWith({ engine: 'vendor/deep' }));
  expect(request).toHaveBeenLastCalledWith('fixture', { engine: 'vendor/deep' });
  expect((screen.getByLabelText('ACP Effort') as HTMLSelectElement).value).toBe('ultra');
});
it('shows agent errors and never saves a rejected configuration', async () => {
  const request = vi.fn().mockRejectedValue(Error('Agent login required'));
  const save = vi.fn();
  const { container } = render(
    <AcpRuntimeControls agentId="fixture" request={request} onChange={save} />,
  );
  container.querySelector('details')!.open = true;
  fireEvent(container.querySelector('details')!, new Event('toggle'));
  expect((await screen.findByRole('alert')).textContent).toBe('Agent login required');
  expect(save).not.toHaveBeenCalled();
});

it('renders quick-select effort pills and applies effort selections cleanly', async () => {
  const withEfforts: AcpRuntimeOptionsResult = {
    agentId: 'fixture',
    applied: {},
    options: [
      snapshot.options[0]!,
      {
        id: 'thought',
        name: 'Effort',
        category: 'thought_level',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(withEfforts)
    .mockResolvedValueOnce({
      ...withEfforts,
      options: [withEfforts.options[0]!, { ...withEfforts.options[1]!, currentValue: 'high' }],
    });
  const save = vi.fn();
  const { container } = render(
    <AcpRuntimeControls agentId="fixture" request={request} onChange={save} />,
  );
  container.querySelector('details')!.open = true;
  fireEvent(container.querySelector('details')!, new Event('toggle'));
  const highBtn = await screen.findByRole('button', { name: 'High' });
  fireEvent.click(highBtn);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ thought: 'high' }));
  expect((screen.getByLabelText('ACP Effort') as HTMLSelectElement).value).toBe('high');
});

it('clears stale model and effort when switching ACP provider', async () => {
  const providerSnapshot: AcpRuntimeOptionsResult = {
    agentId: 'fixture',
    applied: {},
    options: [
      {
        id: 'provider',
        name: 'Provider',
        currentValue: 'anthropic',
        options: [
          { value: 'anthropic', name: 'Anthropic' },
          { value: 'openai', name: 'OpenAI' },
        ],
      },
      snapshot.options[0]!,
      snapshot.options[1]!,
    ],
  };
  const request = vi.fn().mockResolvedValue(providerSnapshot);
  const save = vi.fn();
  const { container } = render(
    <AcpRuntimeControls
      agentId="fixture"
      values={{ provider: 'anthropic', engine: 'fast', thought: 'low' }}
      request={request}
      onChange={save}
    />,
  );
  container.querySelector('details')!.open = true;
  fireEvent(container.querySelector('details')!, new Event('toggle'));
  await screen.findByLabelText('ACP Provider');
  fireEvent.change(screen.getByLabelText('ACP Provider'), { target: { value: 'openai' } });
  await waitFor(() => expect(save).toHaveBeenCalledWith({ provider: 'openai' }));
});

it('displays advertised ACP capabilities, modes, and native slash commands', async () => {
  const richSnapshot: AcpRuntimeOptionsResult = {
    ...snapshot,
    capabilities: { image: true, embeddedContext: true, resume: true, steering: true },
    modes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ],
    currentModeId: 'plan',
    commands: [
      { name: 'compact', description: 'Compact session context' },
      { name: 'review', description: 'Review current diff' },
    ],
  };
  const request = vi.fn().mockResolvedValue(richSnapshot);
  const { container } = render(
    <AcpRuntimeControls agentId="fixture" request={request} onChange={vi.fn()} />,
  );
  container.querySelector('details')!.open = true;
  fireEvent(container.querySelector('details')!, new Event('toggle'));
  await screen.findByText('Vision');
  expect(screen.getByText('Context')).toBeTruthy();
  expect(screen.getByText('Resume')).toBeTruthy();
  expect(screen.getByText('Steer')).toBeTruthy();
  expect(screen.getByText(/Plan \(active\)/)).toBeTruthy();
  expect(screen.getByText('/compact')).toBeTruthy();
  expect(screen.getByText('/review')).toBeTruthy();
});

it('loads interactive ACP mode selectors and applies mode changes via modeRequest', async () => {
  const request = vi.fn().mockResolvedValue(snapshot);
  const modeRequest = vi
    .fn()
    .mockResolvedValueOnce({
      modes: [
        {
          id: 'mode',
          name: 'Mode',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
            { value: 'bypassPermissions', name: 'Bypass Permissions' },
          ],
          selectableValues: ['default', 'plan'],
        },
      ],
    })
    .mockResolvedValueOnce({
      modes: [
        {
          id: 'mode',
          name: 'Mode',
          currentValue: 'plan',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
            { value: 'bypassPermissions', name: 'Bypass Permissions' },
          ],
          selectableValues: ['default', 'plan'],
        },
      ],
    });
  const { container } = render(
    <AcpRuntimeControls
      agentId="claude-code"
      request={request}
      modeRequest={modeRequest}
      onChange={vi.fn()}
    />,
  );
  container.querySelector('details')!.open = true;
  fireEvent(container.querySelector('details')!, new Event('toggle'));
  const select = (await screen.findByLabelText('ACP Mode')) as HTMLSelectElement;
  expect(select.value).toBe('default');
  fireEvent.change(select, { target: { value: 'plan' } });
  await waitFor(() =>
    expect(modeRequest).toHaveBeenCalledWith('claude-code', { optionId: 'mode', value: 'plan' }),
  );
  expect(select.value).toBe('plan');
});
