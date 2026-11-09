import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { acpAgentName, agentRuntimeLabel } from '@wrongstack/contracts/types/agent-identity';
import { AgentRuntimeBadge } from '@wrongstack/project-surfaces/ui/AgentRuntimeBadge';
import { ModelPicker } from '@wrongstack/project-surfaces/ui/ModelPicker';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../src/i18n/locales/en/activity.json';
import tr from '../../src/i18n/locales/tr/activity.json';

afterEach(cleanup);
const i18n = createInstance();
await i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { activity: en }, tr: { activity: tr } },
});

it('preserves unknown agent ids and does not reclassify regular models by their names', () => {
  expect(acpAgentName('constructor')).toBe('constructor');
  expect(acpAgentName('my-private-agent')).toBe('my-private-agent');
  expect(agentRuntimeLabel('acp', 'pi-acp')).toBe('ACP · Pi');
  expect(agentRuntimeLabel('anthropic', 'claude-code')).toBe('anthropic/claude-code');
  expect(agentRuntimeLabel('openrouter', 'openrouter/vendor/model')).toBe(
    'openrouter/vendor/model',
  );
});

it('shows execution role and readable agent identity, with the exact route in the tooltip', async () => {
  const { rerender } = render(
    <I18nextProvider i18n={i18n}>
      <AgentRuntimeBadge provider="acp" model="pi-acp" />
    </I18nextProvider>,
  );
  expect(screen.getByText('ACP subagent')).toBeTruthy();
  expect(screen.getByTitle('ACP subagent · acp/pi-acp').textContent).toContain('Pi');
  await i18n.changeLanguage('tr');
  expect(screen.getByText('ACP alt ajanı')).toBeTruthy();
  rerender(
    <I18nextProvider i18n={i18n}>
      <AgentRuntimeBadge provider="anthropic" model="claude-code" />
    </I18nextProvider>,
  );
  expect(screen.queryByText(/ACP/)).toBeNull();
  await i18n.changeLanguage('en');
});

it('selects the real ACP route from the shared board and desktop picker', () => {
  const onPick = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <ModelPicker
        candidates={[
          { provider: 'acp', model: 'pi-acp', label: 'Pi' },
          { provider: 'openai', model: 'gpt-5', label: 'GPT' },
        ]}
        placeholder="Choose worker"
        onPick={onPick}
      />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose worker' }));
  expect(screen.getByText('ACP agent')).toBeTruthy();
  fireEvent.click(screen.getByText('Pi'));
  expect(onPick).toHaveBeenCalledWith('pi-acp', 'acp');
});
