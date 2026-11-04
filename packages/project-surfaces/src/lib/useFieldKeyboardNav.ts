import { useCallback, useRef } from 'react';

/**
 * Vertical keyboard navigation between form fields.
 *
 * - **ArrowUp / ArrowDown** — move focus between registered fields.
 * - **Enter** — when an `onEnter` handler is provided for the focused field,
 *   it is called (use this to submit a form or advance to the next step).
 * - **ArrowLeft / ArrowRight** — left to native browser handling (select
 *   elements already cycle options on left/right).
 *
 * ## Usage
 *
 * ```tsx
 * function MyForm() {
 *   const { setFieldRef, handleKeyDown } = useFieldKeyboardNav();
 *   //            ↓ index          ↓ optional onEnter
 *   //   setFieldRef(0)  handleKeyDown(e, 0)
 *   //   setFieldRef(1)  handleKeyDown(e, 1, () => save())
 *
 *   return (
 *     <>
 *       <Input ref={setFieldRef(0)} onKeyDown={(e) => handleKeyDown(e, 0)} />
 *       <Input ref={setFieldRef(1)} onKeyDown={(e) => handleKeyDown(e, 1, () => save())} />
 *       <button ref={setFieldRef(2)} onKeyDown={(e) => handleKeyDown(e, 2)}>Save</button>
 *     </>
 *   );
 * }
 * ```
 */
export function useFieldKeyboardNav() {
  const fieldRefs = useRef<(HTMLElement | null)[]>([]);

  /** Returns a ref-callback that registers `el` at position `index`. */
  const setFieldRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      fieldRefs.current[index] = el;
    },
    [],
  );

  /**
   * Call from each field's `onKeyDown`.
   *
   * @param e        The keyboard event.
   * @param index    The field's position in the tab order (0-based).
   * @param onEnter  Optional callback invoked when Enter is pressed on this
   *                 field (e.g. submit the form).
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number, onEnter?: () => void) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        for (let i = index + 1; i < fieldRefs.current.length; i++) {
          const el = fieldRefs.current[i];
          if (el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') {
            el.focus();
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              const len = el.value.length;
              el.setSelectionRange(len, len);
            }
            return;
          }
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        for (let i = index - 1; i >= 0; i--) {
          const el = fieldRefs.current[i];
          if (el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true') {
            el.focus();
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              el.setSelectionRange(el.value.length, el.value.length);
            }
            return;
          }
        }
        return;
      }

      if (e.key === 'Enter' && onEnter) {
        e.preventDefault();
        onEnter();
      }
    },
    [],
  );

  return { setFieldRef, handleKeyDown };
}
