/**
 * Inline render-chrome constants shared by the chat-history renderer.
 *
 * `USER_LABEL` is the inline label entry.tsx renders before a user card's
 * text (`<Text bold>👤 USER  </Text>` then the text, one Text node) and
 * `INFO_PREFIX` is the inline icon before an info card's text
 * (`<Text>ℹ </Text>` then the text). Both live here so entry.tsx consumes
 * the single source (p3) — drift between the render and these constants
 * would silently mis-offset any column math built on them.
 *
 * The per-card-row wrap map (`buildBodyRowMap` / `hasWrapMap` /
 * `resolveRowCol`) that used to live here was removed on 2026-08-29:
 * drag-select copy became BLOCK-based (see selection-helpers.ts), and
 * whole-block copies need the entry's source text, not per-row geometry.
 * Git history preserves the machinery if a future feature (e.g. layout-
 * store-exposed wrap segments) needs it again. The cells === code-units
 * assumption both prefixes rely on is pinned by tests/wrap-geometry.test.ts.
 */

/** Inline label the renderer places before a user card's text. */
export const USER_LABEL = '👤 USER  ';

/** Inline icon the renderer places before an info card's text. */
export const INFO_PREFIX = 'ℹ ';
