import { InputBuilder } from '@wrongstack/core/agent';
import type { ContentBlock } from '@wrongstack/core/types';
import { useEffect, useRef } from 'react';
import type { PromptUsageStore } from '@wrongstack/core/storage';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-reducer.js';
import { TokenPreviewStore } from '../token-previews.js';

export function useAppRuntimeRefs(attachments: AppProps['attachments'], state: State) {
  const promptUsageRef = useRef<PromptUsageStore | null>(null);
  const builderRef = useRef<InputBuilder | null>(null);
  if (builderRef.current === null) {
    builderRef.current = new InputBuilder({ store: attachments });
  }

  const activeCtrlRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeCtrlRef.current?.abort('TUI unmounted');
      activeCtrlRef.current = null;
    },
    [],
  );

  const eternalLoopRunningRef = useRef(false);
  const parallelLoopRunningRef = useRef(false);
  const activeRunSettledRef = useRef<Promise<void>>(Promise.resolve());
  const exitRequestedRef = useRef(false);
  const inputGateRef = useRef(false);
  const lastEnterAtRef = useRef(0);
  const tokenPreviewsRef = useRef(new TokenPreviewStore());
  const streamingTextRef = useRef('');
  const streamSegmentsRef = useRef<Array<{ kind: 'assistant' | 'thinking'; text: string }>>([]);
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionGenerationRef = useRef(0);
  const activeRunGenerationRef = useRef(0);
  const assistantCommittedThisRunRef = useRef(false);
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  const draftRef = useRef({ buffer: state.buffer, cursor: state.cursor });
  draftRef.current = { buffer: state.buffer, cursor: state.cursor };
  const runBlocksRef = useRef<(blocks: ContentBlock[]) => Promise<void>>(async () => undefined);
  const lastEscAtRef = useRef(0);
  const dismissedEscAtRef = useRef(0);
  const submitRef = useRef<(text?: string) => void>(() => {});

  return {
    promptUsageRef,
    builderRef,
    activeCtrlRef,
    eternalLoopRunningRef,
    parallelLoopRunningRef,
    activeRunSettledRef,
    exitRequestedRef,
    inputGateRef,
    lastEnterAtRef,
    tokenPreviewsRef,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    flushTimerRef,
    sessionGenerationRef,
    activeRunGenerationRef,
    assistantCommittedThisRunRef,
    stateRef,
    draftRef,
    runBlocksRef,
    lastEscAtRef,
    dismissedEscAtRef,
    submitRef,
  };
}
