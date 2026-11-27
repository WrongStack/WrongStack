import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MemoryInjectorPanel } from '../../src/components/MemoryManager/MemoryInjectorPanel';

afterEach(cleanup);

import { i18n } from '../../src/i18n';

function FocusHarness({ open }: { open: boolean }) {
  return (
    <>
      <button type="button">Open memory</button>
      <MemoryInjectorPanel open={open} onClose={() => {}} />
    </>
  );
}

// Pin the language before rendering: the component renders t()-derived
// labels, and an unpinned translator can race initialization into raw keys.
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

it('removes the closed drawer from accessible navigation and restores it when opened', () => {
  const { rerender } = render(<MemoryInjectorPanel open={false} onClose={() => {}} />);
  const panel = screen.getByTestId('memory-injector-panel');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(panel.hasAttribute('inert')).toBe(true);
  rerender(<MemoryInjectorPanel open onClose={() => {}} />);
  expect(screen.getByRole('dialog')).toBe(panel);
  expect(panel.hasAttribute('inert')).toBe(false);
  rerender(<MemoryInjectorPanel open={false} onClose={() => {}} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(panel.hasAttribute('inert')).toBe(true);
});

it('moves focus into the drawer on open and restores it to the trigger on close', () => {
  const view = render(<FocusHarness open={false} />);
  const trigger = screen.getByRole('button', { name: 'Open memory' });

  // Control: the trigger is focused while the drawer is hidden from the a11y tree.
  expect(screen.queryByRole('dialog')).toBeNull();
  trigger.focus();
  expect(document.activeElement).toBe(trigger);

  view.rerender(<FocusHarness open />);
  const dialog = screen.getByRole('dialog');
  expect(dialog.contains(document.activeElement)).toBe(true);

  view.rerender(<FocusHarness open={false} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
