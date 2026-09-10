import type { Director } from '@wrongstack/core/coordination';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from './app-action-type.js';
import type { AppKeyHandlerOptions } from './app-key-handler.js';
import type { AppProps } from './app-props.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import type { StatusBarClickMap } from './components/status-bar-types.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { DOMElement } from './ink.js';
import type { PasteAccumState } from './paste-accumulator.js';

/**
 * The shared view of the key-handler wiring that the ordered route modules
 * (decomposition Phase 3 — docs/decomposition-plan.md) receive. It is the
 * factory's full `AppKeyHandlerOptions` plus the three values the factory
 * derives once per session: the resolved stdout shape, the effective history
 * width (terminal minus sidebar), and the `detach` helper that runs route
 * promises without risking the process.
 */
export interface KeyRouteContext extends AppKeyHandlerOptions {
  stdout: { columns: number; rows: number };
  /** Effective width of the history area (terminal minus sidebar). */
  historyWidth: number;
  /** Runs a detached promise from a route; failures surface as error entries. */
  detach: (work: Promise<unknown> | undefined, what: string) => void;
}

/** Re-exported for route modules that need the ref/callback shapes. */
export type {
  Action,
  AppProps,
  Director,
  Dispatch,
  DOMElement,
  HistoryScrollController,
  MutableRefObject,
  PasteAccumState,
  SetStateAction,
  StatusBarClickMap,
  StatuslineItem,
};
