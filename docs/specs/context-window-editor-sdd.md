# WebUI Context Window Editor — Software Design Document

**Spec ID:** `context-window-editor-v1`  
**Version:** `1.0.0-draft`  
**Created:** 2026-07-27  
**Status:** Draft  
**Template:** SDD feature  
**Owner:** WebUI + Core Context maintainers  
**Scope:** `packages/webui`, `packages/webui-server`, `packages/core`

---

## 1. Overview

### 1.1 Problem

WrongStack already exposes context management through automated compaction, `/context`, and the `context_manager` tool, but users cannot manually inspect and surgically remove parts of the active provider context from the WebUI. When a session accumulates stale tool output, repeated logs, large pasted content, or context that the user no longer wants influencing the model, the current options are coarse:

- clear the entire context;
- run compaction and accept the compactor's choices;
- ask the model to prune/summarize via `context_manager`, which is indirect and model-mediated;
- start a new session and lose useful recent state.

A manual editor would give operators direct control, but the context window is not ordinary text. It contains structured provider protocol data: tool calls, tool results, cache markers, thinking signatures, timestamps, token estimates, session replay snapshots, and provider-specific metadata. Unsafe editing can make the next provider request fail, leak stale session data, corrupt session replay, or produce incorrect context-pressure accounting.

### 1.2 Goal

Add a WebUI **Context Window Editor** that lets a user inspect the active context window and remove selected messages or content blocks safely, with server-side validation, dry-run diagnostics, protocol repair, and durable session replay support.

### 1.3 Non-goals

This spec does **not** propose:

- editing the system prompt through this feature;
- editing tool schemas or registered tool definitions;
- changing the provider/model request builder;
- directly editing persisted JSONL session files;
- creating synthetic tool calls or tool results;
- changing compaction policy or context-window modes;
- exposing hidden chain-of-thought beyond what is already present in stored `thinking` blocks;
- implementing collaborative multi-user editing in the first version.

### 1.4 Design principles

1. **Structured edits, not raw transcript rewriting.** The safe default is selecting whole messages or content blocks. Raw JSON editing is optional advanced mode and must pass the same server validation.
2. **Server is authoritative.** The browser sends proposed edits; the server validates, repairs, recomputes derived fields, and commits.
3. **Dry-run before mutation.** Every destructive edit path should have a validation preview showing token impact, protocol repairs, and warnings.
4. **Preserve provider protocol metadata.** Tool IDs, tool names, provider metadata, thinking signatures, and cache markers are opaque data unless the user deletes the owning block.
5. **Commit through conversation state.** Successful saves use `Context.state.replaceMessages()` so subscribers and session persistence receive a canonical `messages_replaced` snapshot.
6. **Reject stale saves.** Editing is based on a revision/hash of the live message list. If the agent appends context while the editor is open, the save must rebase or fail.
7. **No hidden authority in edited content.** Tool outputs and message content are displayed as data, never interpreted as instructions by the editor implementation.

---

## 2. Existing components and constraints

### 2.1 Core message model

Source of truth:

- `packages/core/src/types/messages.ts`
- `packages/core/src/types/blocks.ts`

Runtime messages have this shape:

```ts
interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  ts?: string;
  _estTokens?: number;
}
```

Content block types include:

- `text` — `{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }`
- `tool_use` — `{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; providerMeta?: Record<string, unknown> }`
- `tool_result` — `{ type: 'tool_result'; tool_use_id: string; name?: string; content: string; is_error?: boolean }`
- `image` — `{ type: 'image'; source: { type: 'base64' | 'url'; ... } }`
- `thinking` — `{ type: 'thinking'; thinking: string; signature?: string; providerMeta?: Record<string, unknown> }`

The editor must treat `_estTokens` as derived and untrusted. It may display server-computed token estimates but must never persist browser-supplied `_estTokens`.

### 2.2 Existing WebUI context routes

Source of truth:

- `packages/webui-server/src/server/session-routes.ts`
- `packages/webui-server/src/server/session-handlers.ts`
- `packages/webui/src/lib/ws-client.ts`

Existing client messages:

- `context.clear`
- `context.debug`
- `context.compact`
- `context.repair`
- `context.modes.*`

Existing server messages:

- `context.debug`
- `context.compacted`
- `context.repaired`
- `ctx.pct`
- `ctx.max_context`

The editor should extend this family with `context.editor.*` messages rather than overloading `context.debug`.

### 2.3 Existing validation/repair logic

Source of truth:

- `packages/core/src/utils/message-invariants.ts`
- `packages/core/src/infrastructure/context-manager.ts`

`repairToolUseAdjacency(messages)` is the canonical provider protocol repair. It removes orphaned `tool_use` and `tool_result` blocks and drops messages that become empty.

The context manager already uses this pattern for manual surgery:

1. build a proposed `Message[]`;
2. run `repairToolUseAdjacency(...)`;
3. commit via `ctx.state.replaceMessages(...)` when available;
4. clear stale file tracking for destructive operations.

The editor should reuse this invariant rather than inventing a parallel repair algorithm.

### 2.4 Session persistence and replay

Source of truth:

- `packages/core/src/core/context.ts`
- `packages/core/src/storage/session-store/load-session-data.ts`

`Context.state.replaceMessages(...)` journals `messages_replaced` events. Session replay already knows how to apply `messages_replaced` and `context_snapshot` events.

Direct JSONL mutation is out of scope. Editor saves must operate on live `Context` state and let the existing session writer persist snapshots.

### 2.5 Token accounting and cache-related state

Source of truth:

- `packages/webui-server/src/server/token-estimator.ts`
- `packages/core/src/types/provider.ts`
- `packages/core/src/utils/cache-key.ts`
- `packages/core/src/execution/compaction-summary-cache.ts`
- `packages/providers/src/prompt-cache-key.ts`

Context pressure is based on the full request: messages + system prompt + tool schemas. The editor may mutate messages only, but after a mutation these fields become stale and must be reset:

- `Context.lastRequestTokens`
- `Context.lastRealInputTokens`
- `Context.state.meta['lastRequestTokensAt']`
- `Context.state.meta['realAnchorMsgCount']`

Prompt cache concepts that must not be confused:

- `TextBlock.cache_control` is message/system-block metadata and must be validated if preserved.
- `Request.cache.key` is derived from the stable prompt prefix and is not client-editable.
- `Request.cache.geminiCachedContentName` is internal provider runtime data and is not message data.
- `CompactionSummaryCache` keys are semantic hashes of messages; edited messages naturally produce different summary keys.

---

## 3. Requirements

### Critical

#### R1 — Read-only full context snapshot

`[critical][functional]` The WebUI can request a full-fidelity editable snapshot of the active conversation messages, plus read-only system/tool context breakdown.

**Acceptance criteria**

- `context.editor.open` returns the active `sessionId`, `revision`, `messages`, diagnostics, and token breakdown.
- The response includes message-level token estimates.
- The response includes read-only totals for system prompt tokens and tool schema tokens.
- The response does not allow the browser to edit system prompt or tool schema data.
- The snapshot is scoped to the current session; wrong-session requests are rejected.

#### R2 — Stale-edit protection

`[critical][safety]` Applying edits requires a base revision matching the current server-side context.

**Acceptance criteria**

- The open response includes a deterministic revision string derived from the current message list.
- `context.editor.validate` and `context.editor.apply` require `baseRevision`.
- If live messages changed since `baseRevision`, the server rejects apply with `CONTEXT_REVISION_CONFLICT`.
- The conflict response includes the current revision and a human-readable reload instruction.
- No partial mutation occurs on revision conflict.

#### R3 — Server-side message and block validation

`[critical][safety]` Every proposed message list is validated on the server before dry-run or apply.

**Acceptance criteria**

- Unknown message roles are rejected.
- Message content must be a string or an array of known content blocks.
- Unknown content block types are rejected in v1.
- Client-supplied `_estTokens` is ignored or stripped.
- `ts`, if present, must be a valid ISO-like string or omitted.
- Validation returns structured errors with JSON-pointer-like paths, e.g. `/messages/4/content/1/tool_use_id`.

#### R4 — Tool-call adjacency repair

`[critical][provider-protocol]` Proposed messages are checked and repaired for tool-use/tool-result adjacency before commit.

**Acceptance criteria**

- Dry-run reports all orphaned `tool_use` IDs that would be removed.
- Dry-run reports all orphaned `tool_result.tool_use_id` values that would be removed.
- Apply runs the same repair logic as dry-run.
- Apply can be configured to reject instead of repair when `allowRepair` is false.
- The final committed message list passes `repairToolUseAdjacency(...)` as a no-op.

#### R5 — Durable commit through conversation state

`[critical][persistence]` Successful edits are persisted as canonical conversation-state replacement snapshots.

**Acceptance criteria**

- Apply commits via `ctx.context.state.replaceMessages(finalMessages)`.
- Apply calls `ctx.context.flushConversationJournal?.()` after replacement.
- Session replay after process restart reconstructs the edited message list.
- The implementation never edits session JSONL files directly.

#### R6 — Active-run safety

`[critical][concurrency]` The editor cannot overwrite context while an agent run is actively appending messages unless the run is explicitly stopped first.

**Acceptance criteria**

- Apply is rejected while a completion/tool run is active, or the UI forces an explicit abort-before-edit flow.
- The response distinguishes `RUN_ACTIVE` from revision conflicts.
- Opening the editor during a run is allowed only in read-only mode, or clearly marks the snapshot as volatile.
- The UI disables destructive apply while loading/streaming is active.

#### R7 — Cache and accounting reset

`[critical][correctness]` Applying edits resets stale context accounting and derived runtime state.

**Acceptance criteria**

- `lastRequestTokens` is cleared.
- `lastRealInputTokens` is cleared.
- `lastRequestTokensAt` metadata is deleted.
- `realAnchorMsgCount` metadata is deleted.
- `readFiles` and `fileMtimes` are cleared for destructive message changes, matching existing context-manager behavior.
- The next `ctx.pct` / context debug calculation is based on the edited messages.

### High

#### R8 — Safe UI editing model

`[high][ux]` The default UI supports deletion of whole messages and whole content blocks, not arbitrary mutation of protocol fields.

**Acceptance criteria**

- Each message has a selectable row with role, timestamp, token estimate, preview, and expand/collapse controls.
- Block-array messages show individual blocks with type labels.
- Users can mark messages or blocks for removal.
- Tool protocol blocks display warnings when only one side of a tool exchange is selected.
- Raw JSON mode, if present, is explicitly labeled advanced and uses the same validation endpoint.

#### R9 — Dry-run diagnostics

`[high][ux]` Before committing, the editor presents a clear dry-run summary.

**Acceptance criteria**

- Dry-run shows before/after message counts.
- Dry-run shows before/after message token estimates.
- Dry-run shows provider-protocol repair preview.
- Dry-run shows warnings for deleting thinking/signature blocks.
- Dry-run shows warnings for deleting recent messages preserved by context-window policy.

#### R10 — Redaction and safe rendering

`[high][security]` The editor displays untrusted message/tool content safely.

**Acceptance criteria**

- Message and tool content is rendered as text or structured JSON, never as HTML.
- Large tool results are collapsed by default.
- Potentially sensitive blocks can be visually marked but are not silently altered.
- Copy actions preserve exact text only when explicitly requested.
- The server enforces payload size limits for validate/apply.

#### R11 — WebSocket protocol parity

`[high][integration]` Protocol types are registered consistently across server and frontend type unions.

**Acceptance criteria**

- Client message types include `context.editor.open`, `context.editor.validate`, and `context.editor.apply`.
- Server message types include `context.editor.snapshot`, `context.editor.validation`, `context.editor.applied`, and `context.editor.error` or use the standard `error` shape.
- `packages/webui/src/lib/ws-client.ts` exposes typed helper methods.
- Session-scoped payloads include `sessionId` consistently.

### Medium

#### R12 — Editor state recovery

`[medium][ux]` The WebUI protects users from losing an in-progress edit draft accidentally.

**Acceptance criteria**

- Unsaved removals trigger a confirmation before closing the editor.
- Reloading the editor discards drafts only after confirmation.
- Draft state is kept in memory only for v1; no localStorage persistence is required.

#### R13 — Auditability

`[medium][observability]` Manual context edits are observable in session history and WebUI notifications.

**Acceptance criteria**

- Apply emits `context.editor.applied` with counts and repair summary.
- Session history can infer that a `messages_replaced` event came from manual editor apply, either by event metadata or adjacent event.
- The UI shows a toast/log entry after successful apply.

#### R14 — Accessibility and keyboard support

`[medium][ux]` The editor is usable without a mouse.

**Acceptance criteria**

- Message rows and block rows are keyboard focusable.
- Space toggles selection where appropriate.
- Enter expands/collapses rows.
- Escape closes dialogs after confirmation when dirty.
- Destructive actions have accessible names and visible focus states.

### Low

#### R15 — Advanced raw JSON editing

`[low][power-user]` A raw JSON editor may be added after the structured deletion flow is stable.

**Acceptance criteria**

- Raw mode is opt-in and visibly dangerous.
- It uses server validation before apply.
- It shows schema/path errors inline.
- It does not bypass protocol repair or revision checks.

---

## 4. API design

### 4.1 Client → server messages

#### `context.editor.open`

Request the current editable snapshot.

```ts
interface WSContextEditorOpen {
  type: 'context.editor.open';
  payload: {
    sessionId: string;
  };
}
```

#### `context.editor.validate`

Dry-run validation without mutation.

```ts
interface WSContextEditorValidate {
  type: 'context.editor.validate';
  payload: {
    sessionId: string;
    baseRevision: string;
    messages: EditableMessage[];
    allowRepair: boolean;
  };
}
```

#### `context.editor.apply`

Validate, repair if allowed, commit, and flush persistence.

```ts
interface WSContextEditorApply {
  type: 'context.editor.apply';
  payload: {
    sessionId: string;
    baseRevision: string;
    messages: EditableMessage[];
    allowRepair: boolean;
    expectedRemoved?: {
      messages?: number;
      blocks?: number;
    };
  };
}
```

`expectedRemoved` is optional defense-in-depth for the structured editor: the server can warn if the submitted replacement differs materially from what the UI preview claimed.

### 4.2 Server → client messages

#### `context.editor.snapshot`

```ts
interface WSContextEditorSnapshot {
  type: 'context.editor.snapshot';
  payload: SessionScopedPayload & {
    revision: string;
    messages: EditableMessage[];
    readonlyContext: {
      systemPromptTokens: number;
      toolSchemaTokens: number;
      toolCount: number;
      totalTokens: number;
      messageTokens: number;
    };
    messageBreakdown: Array<{
      index: number;
      role: 'user' | 'assistant' | 'system';
      tokens: number;
      preview: string;
      blockCount: number | null;
      warnings: ContextEditorWarning[];
    }>;
    diagnostics: ContextEditorDiagnostics;
  };
}
```

#### `context.editor.validation`

```ts
interface WSContextEditorValidation {
  type: 'context.editor.validation';
  payload: SessionScopedPayload & {
    ok: boolean;
    baseRevision: string;
    currentRevision: string;
    before: ContextEditorMetrics;
    after?: ContextEditorMetrics;
    validationErrors: ContextEditorValidationError[];
    warnings: ContextEditorWarning[];
    repair: ContextEditorRepairPreview;
    conflict?: ContextEditorConflict;
  };
}
```

#### `context.editor.applied`

```ts
interface WSContextEditorApplied {
  type: 'context.editor.applied';
  payload: SessionScopedPayload & {
    previousRevision: string;
    revision: string;
    before: ContextEditorMetrics;
    after: ContextEditorMetrics;
    removed: {
      messages: number;
      blocks: number;
      toolUses: string[];
      toolResults: string[];
      emptyMessages: number;
    };
    warnings: ContextEditorWarning[];
  };
}
```

### 4.3 Shared payload types

```ts
type EditableMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string | EditableContentBlock[];
  ts?: string;
};

type EditableContentBlock =
  | EditableTextBlock
  | EditableToolUseBlock
  | EditableToolResultBlock
  | EditableImageBlock
  | EditableThinkingBlock;

interface EditableTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface EditableToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  providerMeta?: Record<string, unknown>;
}

interface EditableToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  name?: string;
  content: string;
  is_error?: boolean;
}

interface EditableImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

interface EditableThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  providerMeta?: Record<string, unknown>;
}

interface ContextEditorMetrics {
  messages: number;
  blocks: number;
  messageTokens: number;
  fullRequestTokens: number;
}

interface ContextEditorDiagnostics {
  hasToolAdjacencyIssues: boolean;
  orphanToolUses: string[];
  orphanToolResults: string[];
  emptyMessages: number;
  thinkingBlocks: number;
  signedThinkingBlocks: number;
}

interface ContextEditorRepairPreview {
  changed: boolean;
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

interface ContextEditorValidationError {
  path: string;
  code: string;
  message: string;
}

interface ContextEditorWarning {
  path?: string;
  code: string;
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

interface ContextEditorConflict {
  code: 'CONTEXT_REVISION_CONFLICT' | 'RUN_ACTIVE';
  message: string;
}
```

---

## 5. Validation rules

### 5.1 Top-level payload

- Payload must be an object.
- `sessionId` must be a non-empty string and match the active session.
- `baseRevision` must be a non-empty string for validate/apply.
- `messages` must be an array.
- Message count must not exceed a configured upper bound. Suggested v1 default: current length + 10, because the structured editor is deletion-oriented.
- Serialized payload byte size must not exceed a configured upper bound. Suggested v1 default: 16 MiB.

### 5.2 Message validation

For every message:

- `role` must be `user`, `assistant`, or `system`.
- `content` must be a string or array.
- `ts`, if present, must be a bounded string and parse as a valid timestamp.
- `_estTokens` is stripped/ignored.
- Unknown top-level properties are stripped in structured mode; raw mode may preserve only explicitly allowed properties.

### 5.3 Text block validation

- `type` must equal `text`.
- `text` must be a string.
- `cache_control`, if present, must be exactly `{ type: 'ephemeral' }`.
- Unknown `cache_control` values are rejected, not coerced.

### 5.4 Tool-use block validation

- `type` must equal `tool_use`.
- `id` must be a non-empty string.
- `name` must be a non-empty string.
- `input` must be a plain object.
- `providerMeta`, if present, must be a plain JSON object.
- Structured mode must not allow editing `id`, `name`, or `providerMeta`; it may only preserve or delete the whole block.

### 5.5 Tool-result block validation

- `type` must equal `tool_result`.
- `tool_use_id` must be a non-empty string.
- `name`, if present, must be a string.
- `content` must be a string.
- `is_error`, if present, must be boolean.
- Structured mode must not allow editing `tool_use_id` or `name`; it may only preserve or delete the whole block.

### 5.6 Thinking block validation

- `type` must equal `thinking`.
- `thinking` must be a string.
- `signature`, if present, must be a string and must be preserved unless deleting the whole block.
- `providerMeta`, if present, must be a plain JSON object.
- Deleting a signed thinking block emits a `SIGNED_THINKING_REMOVED` danger warning.

### 5.7 Image block validation

- `type` must equal `image`.
- `source.type` must be `base64` or `url`.
- For `base64`, `data` must be a bounded string and `media_type` must be a string if present.
- For `url`, `url` must be a string.
- Large base64 image data should be collapsed in UI by default.

### 5.8 Protocol repair validation

After schema validation:

1. Run `repairToolUseAdjacency(proposedMessages)`.
2. If repair changed anything and `allowRepair === false`, return `ok: false` with repair preview.
3. If repair changed anything and `allowRepair === true`, use the repaired messages for token metrics and apply.
4. Confirm a second repair pass on the final messages is a no-op.

### 5.9 Accounting/cache validation

On apply:

- Delete all client-supplied `_estTokens`.
- Let `ConversationState` / token estimation recompute estimates.
- Clear `lastRequestTokens` and `lastRealInputTokens`.
- Delete `lastRequestTokensAt` and `realAnchorMsgCount` metadata.
- Clear `readFiles` and `fileMtimes`.
- Do not accept or persist any browser-supplied request cache key, Gemini cached content name, or token counter values.

---

## 6. Revision model

### 6.1 Revision derivation

The server should compute a deterministic revision over the current message list. Suggested algorithm:

```text
revision = sha256("wrongstack-context-editor-v1\0" + canonical-json(messages-without-_estTokens))
```

Canonicalization rules:

- object keys sorted;
- `_estTokens` omitted;
- `undefined` omitted;
- preserve array order;
- preserve exact strings.

### 6.2 Conflict behavior

If `baseRevision !== currentRevision`:

- validate may still return schema errors if desired, but it must include conflict information;
- apply must reject without mutation;
- UI should show "Context changed while editor was open" with actions:
  - reload snapshot;
  - cancel;
  - optionally export current draft as JSON for manual comparison.

---

## 7. UI states

### 7.1 Entry points

Possible entry points:

- Chat topbar context meter menu: **Open Context Editor**.
- Context debug/dashboard panel: **Edit messages**.
- Session tools menu: **Context Window Editor**.

The action should be disabled or read-only while the agent is actively running.

### 7.2 Layout

Use the existing WebUI workbench direction:

- main editor surface for message list;
- right inspector overlay for selected message/block details;
- footer/action bar for token impact and apply controls.

Recommended panels:

1. **Header**
   - session id/name;
   - revision short hash;
   - total token estimate;
   - dirty/validated/conflict status.

2. **Read-only request overhead summary**
   - system prompt tokens;
   - tool schema tokens;
   - tool count;
   - message tokens;
   - full request estimate.

3. **Message list**
   - virtualized rows for long sessions;
   - role color/status marker;
   - timestamp;
   - token estimate;
   - preview;
   - checkbox or remove toggle;
   - expand/collapse block details.

4. **Block detail inspector**
   - structured JSON/text view;
   - block type;
   - protocol identifiers;
   - warning badges;
   - remove block action.

5. **Dry-run drawer/dialog**
   - removed messages/blocks;
   - token savings;
   - repairs;
   - warnings;
   - final apply confirmation.

### 7.3 State machine

```text
closed
  ↓ open
loading_snapshot
  ↓ success
clean_snapshot
  ├─ select/remove → dirty
  ├─ reload → loading_snapshot
  └─ close → closed

dirty
  ├─ validate → validating
  ├─ reset_draft → clean_snapshot
  └─ close → confirm_discard

validating
  ├─ ok → validated
  ├─ validation_error → invalid
  └─ conflict → conflicted

validated
  ├─ edit_more → dirty
  ├─ apply → applying
  └─ close → confirm_discard

invalid
  ├─ fix/remove_more → dirty
  └─ reload → loading_snapshot

conflicted
  ├─ reload → loading_snapshot
  └─ close → closed

applying
  ├─ applied → applied_success
  ├─ conflict → conflicted
  ├─ validation_error → invalid
  └─ failure → apply_failed

applied_success
  ├─ reload → loading_snapshot
  └─ close → closed
```

### 7.4 User-visible warnings

Warnings should be specific and actionable:

- `TOOL_USE_ORPHANED`: "Removing this tool result leaves tool call `<id>` without a result. The server will remove the orphaned tool call too."
- `TOOL_RESULT_ORPHANED`: "Removing this tool call leaves result `<id>` without a matching call. The server will remove the orphaned result too."
- `SIGNED_THINKING_REMOVED`: "This block contains provider replay metadata. Removing it may prevent exact reasoning replay, but is safe if the whole turn is no longer needed."
- `RECENT_MESSAGE_REMOVED`: "This message is within the recent preserved range normally protected by compaction."
- `LARGE_TOOL_RESULT`: "Large tool result collapsed. Expand to inspect before removing."
- `REVISION_CONFLICT`: "The context changed while this editor was open. Reload before applying."
- `RUN_ACTIVE`: "The agent is currently running. Abort or wait before applying context edits."

### 7.5 Accessibility

- Rows use semantic buttons/checkboxes with accessible labels.
- Keyboard shortcuts:
  - `Space` toggles selected row/block removal.
  - `Enter` expands focused row.
  - `Escape` closes dialogs or asks to discard dirty changes.
  - `Ctrl/Cmd+Enter` validates.
- Focus returns to the invoking control when the editor closes.
- Destructive confirmation dialogs use accessible names and descriptions.

---

## 8. Server architecture

### 8.1 New modules

Suggested additions:

```text
packages/webui-server/src/server/context-editor/
  revision.ts              — canonical revision hashing
  validation.ts            — message/block schema validation
  diagnostics.ts           — warnings + protocol diagnostics
  metrics.ts               — token/message/block metrics
  operations.ts            — open/validate/apply operations
  routes.ts                — SessionRouteHandlers integration helpers
```

Keep validation pure and unit-testable. Route handlers should only handle WebSocket/session plumbing.

### 8.2 Route integration

Extend:

- `packages/webui-server/src/protocol/client-conversation.ts`
- `packages/webui-server/src/protocol/server-conversation.ts`
- `packages/webui-server/src/server/session-routes.ts`
- `packages/webui-server/src/server/session-handlers.ts`

`session-handlers.ts` should delegate to `context-editor/operations.ts` rather than accumulating more large inline logic.

### 8.3 Apply sequence

```text
handle context.editor.apply
  → ensureCurrentSession
  → ensure no active run / reject if active
  → validate payload envelope
  → compare baseRevision to currentRevision
  → validate messages schema
  → strip derived fields
  → repairToolUseAdjacency
  → reject if repair needed and allowRepair=false
  → compute before/after metrics
  → ctx.context.state.replaceMessages(finalMessages)
  → await ctx.context.flushConversationJournal?.()
  → reset accounting + file tracking
  → send context.editor.applied
  → optionally broadcast context.repaired-compatible summary
```

---

## 9. Frontend architecture

### 9.1 New modules/components

Suggested additions:

```text
packages/webui/src/stores/context-editor-store.ts
packages/webui/src/components/context-editor/ContextWindowEditor.tsx
packages/webui/src/components/context-editor/ContextMessageList.tsx
packages/webui/src/components/context-editor/ContextBlockInspector.tsx
packages/webui/src/components/context-editor/ContextEditorDryRunDialog.tsx
packages/webui/src/components/context-editor/context-editor-types.ts
```

### 9.2 Store responsibilities

The store should own UI draft state only:

- open/closed state;
- snapshot from server;
- selected message IDs/indices for removal;
- selected block paths for removal;
- validation result;
- conflict status;
- dirty flag.

The store must not own authoritative context. Authoritative messages remain server-owned.

### 9.3 Draft representation

For structured deletion mode, prefer a sparse edit plan in UI state:

```ts
interface ContextEditorDraft {
  baseRevision: string;
  removeMessages: Set<number>;
  removeBlocks: Set<string>; // e.g. "4.content.2"
}
```

Before validate/apply, derive a proposed `messages` array from the original snapshot plus the sparse plan. This avoids accidental mutation of protocol fields in the UI.

---

## 10. Implementation boundaries

### 10.1 In scope for v1

- Read-only snapshot of the active conversation messages.
- Structured deletion of whole messages and whole content blocks.
- Dry-run validation and protocol repair preview.
- Apply through `Context.state.replaceMessages()`.
- Server-side revision checks, active-run checks, accounting reset, and journal flush.
- WebUI state for loading, dirty, validating, conflicted, invalid, applying, and applied states.

### 10.2 Out of scope for v1

- Editing system prompt blocks.
- Editing registered tool schemas.
- Renaming or creating tool IDs.
- Mutating `thinking.signature` or `providerMeta` fields in place.
- Direct JSONL session-file editing.
- Collaborative simultaneous editing.
- Automatic summarization of removed content into a replacement note.
- Persisting editor drafts to localStorage.

### 10.3 Required reuse

- Use `repairToolUseAdjacency()` for protocol repair.
- Use `estimateContextBreakdown()` or shared token-estimation helpers for metrics.
- Use existing `ensureCurrentSession`-style session scoping.
- Use existing WebSocket auth/token behavior; do not add a parallel auth path.
- Keep route handlers thin by delegating validation and operations to pure helper modules.

---

## 11. Security considerations

- WebSocket auth/session checks remain mandatory.
- The editor payload is untrusted input.
- The server validates every field and rejects unknown block types in v1.
- No raw content is rendered as HTML.
- Tool outputs may contain prompt injection attempts; display them as inert data.
- Do not put secrets or raw large tool outputs into logs.
- Do not include full edited message payload in error events.
- Apply should be rate-limited or naturally bounded by WebSocket rate limits to avoid repeated huge payload validation.
- If WebUI is exposed on LAN/tunnel, existing token requirements apply.

---

## 12. Testing plan

### 12.1 Unit tests: validation

Target: `packages/webui-server/tests/context-editor-validation.test.ts`

Cases:

- accepts valid string-content messages;
- accepts valid block-content messages;
- rejects unknown roles;
- rejects unknown block types;
- rejects invalid `cache_control`;
- rejects malformed `tool_use.input`;
- rejects malformed `tool_result.tool_use_id`;
- strips/ignores `_estTokens`;
- flags signed thinking deletion warning;
- enforces payload size/message count limits.

### 12.2 Unit tests: revision

Target: `packages/webui-server/tests/context-editor-revision.test.ts`

Cases:

- stable hash for semantically identical messages;
- `_estTokens` does not affect revision;
- content string changes affect revision;
- block order changes affect revision;
- object key ordering does not affect revision.

### 12.3 Unit tests: repair/apply operations

Target: `packages/webui-server/tests/context-editor-operations.test.ts`

Cases:

- deleting a user `tool_result` repairs orphan assistant `tool_use`;
- deleting assistant `tool_use` repairs orphan user `tool_result`;
- `allowRepair=false` rejects repair-needed proposals;
- apply commits through `replaceMessages`;
- apply flushes conversation journal;
- apply resets context accounting metadata;
- apply rejects stale revision;
- apply rejects active run.

### 12.4 Frontend tests

Target: `packages/webui/tests/components/context-editor/*.test.tsx`

Cases:

- snapshot renders message rows and token totals;
- toggling a message marks editor dirty;
- validate button sends derived replacement messages;
- conflict response shows reload state;
- validation errors render inline;
- dry-run repair summary is visible before apply;
- keyboard toggles selection and expansion.

### 12.5 Integration tests

- WebSocket route test for open → validate → apply.
- Session replay test: apply edit, close/reload session, confirm edited messages replay.
- Existing `context.repair` tests remain valid and should share repair fixtures where possible.

---

## 13. Phased implementation plan

### Phase 0 — Server validation primitives

- Add pure revision, validation, diagnostics, and metrics helpers.
- Add unit tests for helpers.
- No WebUI surface yet.

### Phase 1 — WebSocket API, read-only snapshot

- Add `context.editor.open` route.
- Add frontend client helper.
- Build read-only snapshot viewer using existing context/debug entry point.
- No apply support.

### Phase 2 — Structured deletion dry-run

- Add sparse deletion UI.
- Add `context.editor.validate` route.
- Show dry-run token/repair/warning summary.
- No mutation yet.

### Phase 3 — Apply support

- Add `context.editor.apply` route.
- Commit through `replaceMessages`.
- Reset accounting and flush journal.
- Add replay tests.

### Phase 4 — Advanced raw JSON mode

- Optional.
- Add Monaco/raw JSON editor only after structured deletion proves stable.
- Reuse the same validation/apply pipeline.

---

## 14. Open questions

1. Should applying edits automatically abort an active run, or should it always require the user to abort/wait first? Recommended: require abort/wait in v1.
2. Should manual context edits create a distinct `context_edited` session event, or is `messages_replaced` plus `context.editor.applied` enough? Recommended: add lightweight metadata if the existing event type supports it; otherwise avoid session event schema churn in v1.
3. Should raw JSON mode preserve unknown future block types or reject them? Recommended: reject unknown block types in v1 for safety.
4. Should compaction summary cache be explicitly cleared after manual edits? Recommended: not required for correctness because keys are semantic; consider only if a concrete stale-cache bug appears.
5. Should the editor support summarizing selected removals into a replacement note? Recommended: defer; deletion-only v1 is safer.

---

## 15. Acceptance summary

The feature is acceptable when:

- users can open a full context snapshot in WebUI;
- users can mark messages/blocks for removal;
- the server dry-runs validation and repair;
- stale revisions and active runs are protected;
- apply commits through `Context.state.replaceMessages()`;
- provider tool-call adjacency is valid after every save;
- context accounting is reset after save;
- session replay reconstructs the edited context;
- tests cover validation, revision conflicts, repair, apply, and replay.
