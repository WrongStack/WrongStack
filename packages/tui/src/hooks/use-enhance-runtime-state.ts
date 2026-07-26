import { useEffect, useRef, useState } from 'react';

interface UseEnhanceRuntimeStateInput {
  enhanceEnabled: boolean;
  midRunSendPicker: boolean;
}

export function useEnhanceRuntimeState({
  enhanceEnabled,
  midRunSendPicker,
}: UseEnhanceRuntimeStateInput): {
  enhanceEnabledRef: React.MutableRefObject<boolean>;
  midRunSendPickerRef: React.MutableRefObject<boolean>;
  enhanceAbortRef: React.MutableRefObject<AbortController | null>;
  enhanceCancelledRef: React.MutableRefObject<boolean>;
  enhanceOriginalRef: React.MutableRefObject<string>;
  enhanceCountdown: number | null;
  setEnhanceCountdown: React.Dispatch<React.SetStateAction<number | null>>;
  enhanceStartedAt: number | null;
  setEnhanceStartedAt: React.Dispatch<React.SetStateAction<number | null>>;
  enhanceDurationMs: number | null;
  setEnhanceDurationMs: React.Dispatch<React.SetStateAction<number | null>>;
  refineProviderId: string | null;
  setRefineProviderId: React.Dispatch<React.SetStateAction<string | null>>;
  refineModel: string | null;
  setRefineModel: React.Dispatch<React.SetStateAction<string | null>>;
} {
  const enhanceEnabledRef = useRef(enhanceEnabled);
  useEffect(() => {
    enhanceEnabledRef.current = enhanceEnabled;
  }, [enhanceEnabled]);

  const midRunSendPickerRef = useRef(midRunSendPicker);
  const enhanceAbortRef = useRef<AbortController | null>(null);
  const enhanceCancelledRef = useRef(false);
  const enhanceOriginalRef = useRef('');
  const [enhanceCountdown, setEnhanceCountdown] = useState<number | null>(null);
  const [enhanceStartedAt, setEnhanceStartedAt] = useState<number | null>(null);
  const [enhanceDurationMs, setEnhanceDurationMs] = useState<number | null>(null);
  const [refineProviderId, setRefineProviderId] = useState<string | null>(null);
  const [refineModel, setRefineModel] = useState<string | null>(null);

  return {
    enhanceEnabledRef,
    midRunSendPickerRef,
    enhanceAbortRef,
    enhanceCancelledRef,
    enhanceOriginalRef,
    enhanceCountdown,
    setEnhanceCountdown,
    enhanceStartedAt,
    setEnhanceStartedAt,
    enhanceDurationMs,
    setEnhanceDurationMs,
    refineProviderId,
    setRefineProviderId,
    refineModel,
    setRefineModel,
  };
}
