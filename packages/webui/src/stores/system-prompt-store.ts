import { create } from 'zustand';
import type { WSSystemPromptInfo, WSSystemPromptVariantInfo } from '../types/server-message';

/**
 * Identity-prompt size for this session: which variants exist, what each costs
 * in tokens, which one is live, and whether the user has ever chosen.
 *
 * `chosen` drives the one behaviour that cannot be derived any other way: the
 * first-run picker. The server materializes a default variant for every config,
 * so `current === 'default'` says nothing about whether anyone picked it. The
 * flag comes from the raw profile config file, where the key only exists once a
 * selection has actually been made.
 *
 * `promptedThisSession` is local and deliberately not persisted: it stops the
 * first-run picker from reopening on a reconnect or a re-render while still
 * reopening on a genuinely new browser session, which is when the question is
 * cheap to ask again.
 */
interface SystemPromptState {
  info: WSSystemPromptInfo | null;
  /** Open state of the picker, and what opened it. */
  pickerOpen: boolean;
  /** True when the picker was opened by the New Session flow (confirm starts one). */
  pickerStartsSession: boolean;
  promptedThisSession: boolean;
  setInfo: (info: WSSystemPromptInfo) => void;
  openPicker: (opts?: { startsSession?: boolean }) => void;
  closePicker: () => void;
  markPrompted: () => void;
}

export const useSystemPromptStore = create<SystemPromptState>()((set) => ({
  info: null,
  pickerOpen: false,
  pickerStartsSession: false,
  promptedThisSession: false,
  setInfo: (info) => set({ info }),
  // Any explicit open counts as having asked: the first-run effect keys off
  // `promptedThisSession`, and without this a New Session / setup-flow open
  // would let that effect re-open the picker on top of itself and reset
  // `pickerStartsSession` to false — silently dropping the session start.
  openPicker: (opts) =>
    set({
      pickerOpen: true,
      pickerStartsSession: opts?.startsSession === true,
      promptedThisSession: true,
    }),
  closePicker: () => set({ pickerOpen: false, pickerStartsSession: false }),
  markPrompted: () => set({ promptedThisSession: true }),
}));

/** Variant list with a stable fallback so the picker can render before the first reply. */
export function systemPromptVariants(info: WSSystemPromptInfo | null): WSSystemPromptVariantInfo[] {
  return info?.variants ?? [];
}
