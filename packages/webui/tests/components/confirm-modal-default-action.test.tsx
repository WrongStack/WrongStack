import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ConfirmModalHost,
  confirmModalChoice,
  useConfirmModalStore,
} from '../../src/components/ConfirmModal.js';

it('uses the safe cancel choice when a dialog opts into cancel as the default', async () => {
  render(<ConfirmModalHost />);
  const decision = confirmModalChoice({
    title: 'Start a fresh context?',
    confirmLabel: 'New context',
    cancelLabel: 'Same context',
    defaultAction: 'cancel',
  });

  expect(await screen.findByText('Start a fresh context?')).toBeDefined();
  await act(async () => {
    fireEvent.keyDown(window, { key: 'Enter' });
  });

  await expect(decision).resolves.toBe('cancel');
  expect(useConfirmModalStore.getState().request).toBeNull();
});

it('distinguishes dismiss from the same-context button', async () => {
  const decision = confirmModalChoice({ title: 'Start a fresh context?' });

  useConfirmModalStore.getState().settle(null);

  await expect(decision).resolves.toBe('dismiss');
});
