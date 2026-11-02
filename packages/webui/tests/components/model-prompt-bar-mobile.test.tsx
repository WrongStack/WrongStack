import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useChromeLevel', () => ({ useIsFullChrome: () => false }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/view-navigation', () => ({ openMainView: vi.fn() }));
vi.mock('@/components/ChatInput/session-effort-select.js', () => ({
  SessionEffortSelect: () => <div data-testid="mobile-effort-control" />,
}));
vi.mock('@/components/ChatInput/subagent-models-button.js', () => ({
  SubagentModelsButton: () => <div data-testid="mobile-subagent-control" />,
}));
vi.mock('@/components/ChatInput/companions-button.js', () => ({
  CompanionsButton: () => <div data-testid="mobile-companions-control" />,
}));

const { ModelAndPromptBar } = await import('../../src/components/ChatInput/chat-input-bars');

describe('ModelAndPromptBar mobile controls', () => {
  it('groups advanced run controls in one dialog', () => {
    render(
      <ModelAndPromptBar
        onOpenPromptLibrary={vi.fn()}
        onOpenModelSwitcher={vi.fn()}
        t={(key) => key}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'chat:input.runSettings' });
    fireEvent.click(trigger);

    const menu = screen.getByRole('dialog');
    expect(within(menu).getByTestId('mobile-effort-control')).toBeTruthy();
    expect(within(menu).getByTestId('mobile-subagent-control')).toBeTruthy();
    expect(within(menu).getByTestId('mobile-companions-control')).toBeTruthy();
  });
});
