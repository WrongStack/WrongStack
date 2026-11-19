import { EMPTY_KEY } from '../components/input.js';
import type { KeyRouteContext } from '../key-handler-context.js';
import { feedPaste } from '../paste-accumulator.js';

/**
 * Bracketed-paste accumulation — moved verbatim from handleKey
 * (decomposition Phase 3 — docs/decomposition-plan.md).
 *
 * Must run before the Enter/key handling below: a paste split across
 * events can land a fragment that is exactly "\n", which would
 * otherwise be read as Enter and submit mid-paste. The begin marker
 * (`\x1b[200~`, or a bare [200~ when Ink ate the ESC) opens accumulation;
 * we swallow every fragment until the end marker (`\x1b[201~` / [201~),
 * then finalize the whole payload at once.
 *
 * Returns true when the key was consumed by the paste pipeline; false
 * falls through to the later routes.
 */
export async function routePastePipeline(
  ctx: KeyRouteContext,
  input: string,
  explicitPaste = false,
): Promise<boolean> {
  const { state, dispatch, pasteAccumRef, pasteFlushTimerRef } = ctx;
  if (!input) return false;
  // An open overlay (the /auth key prompt, settings drafts, model search) owns
  // the keyboard, so the assembled payload goes to it first. Only when no
  // picker takes it does it land in the composer. Routing the ASSEMBLED text
  // keeps paste markers out of overlay fields.
  const commitPaste = async (full: string): Promise<void> => {
    if (ctx.tryPickerKey(full, { ...EMPTY_KEY, paste: true }, false)) return;
    await ctx.commitPaste(full);
  };
  // Unfocus sidebar before processing paste so the buffer receives focus.
  if (state.sidebarFocused) {
    dispatch({ type: 'toggleSidebarFocus' });
  }
  if (explicitPaste) {
    if (pasteFlushTimerRef.current) clearTimeout(pasteFlushTimerRef.current);
    pasteFlushTimerRef.current = null;
    pasteAccumRef.current = null;
    await commitPaste(input);
    return true;
  }
  const paste = feedPaste(pasteAccumRef.current, input);
  if (!paste) return false;
  pasteAccumRef.current = paste.accum;
  if (pasteFlushTimerRef.current) clearTimeout(pasteFlushTimerRef.current);
  if (paste.error) {
    if (paste.accum !== null) {
      pasteFlushTimerRef.current = setTimeout(() => {
        pasteFlushTimerRef.current = null;
        pasteAccumRef.current = null;
      }, 500);
    } else {
      pasteFlushTimerRef.current = null;
    }
    dispatch({ type: 'addEntry', entry: { kind: 'error', text: paste.error } });
    return true;
  }
  if (paste.complete !== null) {
    pasteFlushTimerRef.current = null;
    await commitPaste(paste.complete);
    return true;
  }
  pasteFlushTimerRef.current = setTimeout(() => {
    pasteFlushTimerRef.current = null;
    const full = pasteAccumRef.current;
    pasteAccumRef.current = null;
    // Runs on the TIMER stack, where nothing above can catch it — unlike
    // the other `commitPaste` call sites, which are awaited inside
    // `handleKey` (and so covered by `useStableKeyHandler`'s catch).
    if (typeof full === 'string' && full) ctx.detach(commitPaste(full), 'Paste');
  }, 500);
  return true;
}
