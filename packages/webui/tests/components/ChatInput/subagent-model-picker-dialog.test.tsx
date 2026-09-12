import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners: Record<string, (message: { payload: unknown }) => void> = {};
const listSavedProviders = vi.fn();
const listProviderModels = vi.fn();
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ listSavedProviders, listProviderModels }) }));
vi.mock('@/stores', () => ({ useConfigStore: (selector: (s: unknown) => unknown) => selector({ wsUrl: 'ws://test' }) }));
vi.mock('@/stores/local-prefs', () => ({ useLocalPrefs: (selector: (s: unknown) => unknown) => selector({ favoriteModels: ['openai/gpt-5'], disabledModels: [] }) }));
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ on: (event: string, callback: (message: { payload: unknown }) => void) => { listeners[event] = callback; return () => {}; } }) }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));

import { SubagentModelPickerDialog } from '../../../src/components/ChatInput/subagent-model-picker-dialog';

function openDialog(currentLane: Record<string, string> = {}) {
  render(<SubagentModelPickerDialog laneIndex={1} currentLane={currentLane} open onOpenChange={vi.fn()} onPick={vi.fn()} />);
  act(() => {
    listeners['providers.saved']?.({ payload: { providers: [{ id: 'openai' }, { id: 'anthropic' }] } });
    listeners['provider.models']?.({ payload: { provider: 'openai', models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-mini', name: 'GPT Mini' }] } });
    listeners['provider.models']?.({ payload: { provider: 'anthropic', models: [{ id: 'claude', name: 'Claude' }] } });
  });
}

beforeEach(() => { for (const key of Object.keys(listeners)) delete listeners[key]; listSavedProviders.mockClear(); listProviderModels.mockClear(); });
afterEach(cleanup);

describe('SubagentModelPickerDialog', () => {
  it('filters candidates by search text', () => { openDialog(); fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mini' } }); expect(screen.getByText('GPT Mini')).toBeTruthy(); expect(screen.queryByText('Claude')).toBeNull(); });
  it('toggles favorites-only filtering', () => { openDialog(); fireEvent.click(screen.getByRole('button', { name: /favorites/i })); expect(screen.getByText('GPT-5')).toBeTruthy(); expect(screen.queryByText('Claude')).toBeNull(); });
  it('filters candidates by provider', () => { openDialog(); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'anthropic' } }); expect(screen.getByText('Claude')).toBeTruthy(); expect(screen.queryByText('GPT-5')).toBeNull(); });
  it('supports keyboard navigation and Enter selection', () => { const onPick = vi.fn(); render(<SubagentModelPickerDialog laneIndex={0} currentLane={{}} open onOpenChange={vi.fn()} onPick={onPick} />); listeners['providers.saved']?.({ payload: { providers: [{ id: 'openai' }] } }); listeners['provider.models']?.({ payload: { provider: 'openai', models: [{ id: 'gpt-5', name: 'GPT-5' }] } }); const input = screen.getByRole('textbox'); fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'Enter' }); expect(onPick).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5' }); });
  it('shows a warning for legacy tier pins', () => { openDialog({ tier: 'budget' }); expect(screen.getByText(/tier:budget/)).toBeTruthy(); expect(screen.getByText(/replaces this pin/)).toBeTruthy(); });
});
