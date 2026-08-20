import { useSyncExternalStore } from 'react';
import { getActiveTheme, getActiveThemeName, subscribeToTheme, type Theme } from '../theme.js';

/**
 * Subscribes to the module-scoped active theme so a render reads the
 * current `theme` snapshot. Used by the App shell to force a re-render
 * when `setActiveTheme()` mutates the global theme — child components
 * read `theme` directly via destructuring, so the parent re-render
 * propagates the new palette into the whole tree.
 *
 * The hook itself returns the live `theme` reference; callers don't
 * typically need to use it (they can keep reading `theme` directly),
 * but exposing it lets test code and stat panels introspect the active
 * palette without re-implementing the listener.
 */
export function useActiveTheme(): Theme {
  // Track the active preset name as a primitive snapshot. React's
  // useSyncExternalStore triggers a re-render whenever the snapshot
  // identity changes — for mutable objects the identity is constant, so
  // a primitive "name" token is the only way to force a re-render when
  // `setActiveTheme` mutates the shared `theme` object in place.
  //
  // We still return the live `theme` reference so consumer code keeps
  // the simple `theme` import pattern. The hook's only job is to keep
  // the parent component re-rendering on each swap.
  useSyncExternalStore(subscribeToTheme, getActiveThemeName, getActiveThemeName);
  return getActiveTheme();
}
