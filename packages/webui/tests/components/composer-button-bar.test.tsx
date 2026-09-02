import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerButtonBar } from '../../src/components/ChatInput/composer-button-bar';

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, opts?: any) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) return opts.defaultValue;
      return k;
    },
  }),
}));

describe('ComposerButtonBar component', () => {
  const mockToggleSpeech = vi.fn();
  const defaultProps = {
    imagePickerRef: { current: null },
    disabled: false,
    topicCheckBusy: false,
    clientConnected: true,
    isLoading: false,
    chatStarted: true,
    input: 'Hello world',
    pendingImages: [],
    addImageFiles: vi.fn(),
    handleStopAndEdit: vi.fn(),
    handleAbort: vi.fn(),
    handleBtw: vi.fn(),
    handleSteer: vi.fn(),
    handleAddQueue: vi.fn(),
    updatePrefs: vi.fn(),
    t: (k: string, opts?: any) => opts?.defaultValue ?? k,
    isListening: false,
    isSpeechSupported: true,
    onToggleSpeech: mockToggleSpeech,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders speech recognition mic button when supported', () => {
    render(<ComposerButtonBar {...defaultProps} />);

    const micBtn = screen.getByTitle('Voice input (Speech to text)');
    expect(micBtn).toBeDefined();

    fireEvent.click(micBtn);
    expect(mockToggleSpeech).toHaveBeenCalledTimes(1);
  });

  it('renders listening active state when isListening is true', () => {
    render(<ComposerButtonBar {...defaultProps} isListening={true} />);

    const stopListeningBtn = screen.getByTitle('Listening... (Click to stop)');
    expect(stopListeningBtn).toBeDefined();
  });
});
