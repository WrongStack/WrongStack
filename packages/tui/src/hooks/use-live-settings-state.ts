import { useEffect, useRef } from 'react';
import type { Settings } from '../app-settings-type.js';
import { DEFAULT_STATUSLINE_MODE } from '../components/settings-picker.js';

type AnimationStyle = 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'static' | 'cycle';

export function useLiveSettingsState({
  getSettings,
  titleController,
  chime,
  confirmExit,
}: {
  getSettings?: (() => Settings) | undefined;
  titleController?:
    | { setEnabled: (on: boolean) => void; setModel: (model: string) => void }
    | undefined;
  chime: boolean;
  confirmExit: boolean;
}): {
  liveSettings: Settings | undefined;
  liveStatuslineMode: Settings['statuslineMode'];
  liveAnimationStyle: AnimationStyle;
  liveThinkingWord: string;
  chimeRef: React.MutableRefObject<boolean>;
  confirmExitRef: React.MutableRefObject<boolean>;
} {
  // chime/confirmExit must reflect LIVE `/settings` changes, not just the boot
  // props. getSettings() reads the in-memory configStore, which saveSettings
  // updates on every left/right change, so these refs stay current within the
  // running session without a restart.
  const liveSettings = getSettings?.();
  const liveStatuslineMode = liveSettings?.statuslineMode ?? DEFAULT_STATUSLINE_MODE;
  const liveAnimationStyle = liveSettings?.animationStyle ?? 'rainbow';
  const liveThinkingWord = liveSettings?.thinkingWord ?? 'thinking';
  const chimeRef = useRef(chime);
  chimeRef.current = liveSettings?.chime ?? chime;
  const confirmExitRef = useRef(confirmExit);
  confirmExitRef.current = liveSettings?.confirmExit ?? confirmExit;

  // Apply a live `titleAnimation` change to the out-of-band terminal title
  // controller. The boolean primitive keeps the effect from re-firing on
  // unrelated renders.
  const liveTitleAnimation = liveSettings?.titleAnimation;
  useEffect(() => {
    if (!titleController) return;
    titleController.setEnabled(liveTitleAnimation !== false);
  }, [titleController, liveTitleAnimation]);

  return {
    liveSettings,
    liveStatuslineMode,
    liveAnimationStyle,
    liveThinkingWord,
    chimeRef,
    confirmExitRef,
  };
}
