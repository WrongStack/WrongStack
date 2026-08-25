import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeechRecognition } from '../../src/components/ChatInput/use-speech-recognition';

describe('useSpeechRecognition hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports isSupported as false when Web Speech API is absent', () => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;

    const { result } = renderHook(() =>
      useSpeechRecognition({
        onTranscript: () => {},
      }),
    );

    expect(result.current.isSupported).toBe(false);
    expect(result.current.isListening).toBe(false);
  });

  it('starts and stops speech recognition when Web Speech API is supported', () => {
    const mockStart = vi.fn();
    const mockStop = vi.fn();

    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      start = mockStart;
      stop = mockStop;
      abort = vi.fn();
      onresult = null;
      onerror = null;
      onend = null;
    }

    (window as any).SpeechRecognition = MockSpeechRecognition;

    const onTranscriptMock = vi.fn();
    const { result } = renderHook(() =>
      useSpeechRecognition({
        onTranscript: onTranscriptMock,
      }),
    );

    expect(result.current.isSupported).toBe(true);

    // Toggle listening ON
    act(() => {
      result.current.toggleListening();
    });

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(result.current.isListening).toBe(true);

    // Toggle listening OFF
    act(() => {
      result.current.toggleListening();
    });

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(result.current.isListening).toBe(false);
  });
});
