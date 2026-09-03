/**
 * Picker key dispatch.
 *
 * The picker dispatch is a closed dispatch table where each picker checks
 * `state.<picker>.open` and either handles the key (returning `true`) or
 * falls through (returning `false`). The hook returns a single function
 * `tryPickerKey(input, key, isEnter)` that the caller's `handleKey` invokes
 * *before* its non-picker dispatch and bails on `true`.
 */

import { useCallback } from 'react';
import type { KeyEvent } from '../components/input.js';
import { tryToolsSettingsPickerKeys } from './use-picker-keys-tools-settings.js';
import type { PickerKeysHost } from './use-picker-keys-types.js';

export type { PickerKeysHost } from './use-picker-keys-types.js';

const ENTER_DOUBLE_TAP_MS = 50;

function debouncedEnter(host: PickerKeysHost): boolean {
  const now = Date.now();
  if (now - host.lastEnterAtRef.current < ENTER_DOUBLE_TAP_MS) return true;
  host.lastEnterAtRef.current = now;
  return false;
}

export function usePickerKeys(
  host: PickerKeysHost,
): (input: string, key: KeyEvent, isEnter: boolean) => boolean {
  return useCallback(
    (input: string, key: KeyEvent, isEnter: boolean): boolean => {
      // 1. Settings, tools, and operational pickers/panels
      if (tryToolsSettingsPickerKeys(host, input, key, isEnter, debouncedEnter)) {
        return true;
      }

      return false;
    },
    [host],
  );
}
