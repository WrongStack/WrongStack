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
