/** Maximum length of a single input line from stdin (before Enter). */
export const MAX_INPUT_BUFFER_CHARS = 100_000;

/** Maximum size of a single paste operation (prevents OOM from 10MB paste). */
export const MAX_PASTE_CHARS = 50_000;

/** Maximum length of a single history entry text payload. */
export const MAX_ENTRY_TEXT_CHARS = 500_000;

/** Maximum entries in the history array (matches history-retention.ts). */
export const MAX_HISTORY_ENTRIES = 400;

/** Maximum actions in a fleetBatch dispatch (prevents render-thrashing). */
export const MAX_BATCHED_ACTIONS = 500;

/** Maximum length of a single action payload string field. */
export const MAX_ACTION_STRING_FIELD = 10_000;

/** Maximum subagents tracked in fleet state. */
export const MAX_FLEET_ENTRIES = 200;

/** Maximum tools tracked per-subagent. */
export const MAX_RECENT_TOOLS = 100;

/** Maximum messages tracked per-subagent. */
export const MAX_RECENT_MESSAGES = 50;

/** Maximum depth of nested action payload objects. */
export const MAX_ACTION_DEPTH = 8;

/** Maximum characters in a paste fragment (single stdin chunk). */
export const MAX_PASTE_FRAGMENT_CHARS = 100_000;

/** Maximum length for any host-provided string (model, provider, etc). */
export const MAX_HOST_STRING_FIELD = 500;

/** Maximum entries in a picker matches list. */
export const MAX_PICKER_MATCHES = 500;
