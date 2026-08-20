/**
 * Zod schemas for IPC message validation.
 * These schemas validate incoming data from the renderer to ensure type safety.
 */
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

// ============================================================================
// Base Validators
// ============================================================================

/** Valid runtime ID pattern: alphanumeric, dots, underscores, hyphens, 3-120 chars */
const RUNTIME_ID_PATTERN = /^[a-zA-Z0-9._:-]{3,120}$/;

export const runtimeIdSchema = z.string().regex(RUNTIME_ID_PATTERN, 'Invalid runtime ID format');

export const pathSchema = z.string().min(1).max(10000);

/**
 * A filesystem path that will become a spawned agent's working directory.
 *
 * `pathSchema` is a LENGTH check, not a path check — it accepts any string. The
 * value reaches `openProject` / `registerProject` and ends up as an agent `cwd`,
 * so a renderer compromise could point the agent at an arbitrary location
 * (audit 2026-08-20). Requiring the path to resolve to a real directory removes
 * the arbitrary-string class without constraining where a user may legitimately
 * open a project — this is a local single-user app, and the directory has to
 * exist for the session to be meaningful anyway.
 *
 * Deliberately not a containment check: there is no root to contain to.
 */
export const projectRootSchema = pathSchema
  .refine((value) => !value.includes('\0'), {
    message: 'path must not contain a NUL byte',
  })
  .refine(
    (value) => {
      try {
        return statSync(path.resolve(value)).isDirectory();
      } catch {
        return false;
      }
    },
    { message: 'path must be an existing directory' },
  );

export const booleanSchema = z.boolean();

export const numberSchema = z.number().int().finite();

// ============================================================================
// IPC Handler Input Schemas
// ============================================================================

/**
 * Schema for IPC.openProject handler.
 * Accepts optional project root path.
 */
export const openProjectSchema = z.object({
  requestedRoot: pathSchema.optional(),
});

/**
 * Schema for IPC.registerProject handler.
 * Accepts optional project root path.
 */
export const registerProjectSchema = z.object({
  requestedRoot: pathSchema.optional(),
});

/**
 * Schema for IPC.unregisterProject handler.
 * Requires a valid root path.
 */
export const unregisterProjectSchema = z.object({
  root: pathSchema,
});

/**
 * Schema for IPC.openProjectSession handler.
 * Accepts optional runtime ID.
 */
export const openProjectSessionSchema = z.object({
  runtimeId: runtimeIdSchema.optional(),
});

/**
 * Schema for IPC.activateRuntime handler.
 * Requires a valid runtime ID.
 */
export const activateRuntimeSchema = z.object({
  id: runtimeIdSchema,
});

/**
 * Schema for IPC.closeRuntime handler.
 * Requires a valid runtime ID.
 */
export const closeRuntimeSchema = z.object({
  id: runtimeIdSchema,
});

/**
 * Schema for IPC.sendMessage handler.
 * Requires runtime ID and message content.
 */
export const sendMessageSchema = z.object({
  id: runtimeIdSchema,
  content: z.string(),
});

/**
 * Schema for IPC.abortRuntime handler.
 * Requires runtime ID.
 */
export const abortRuntimeSchema = z.object({
  id: runtimeIdSchema,
});

/**
 * Schema for IPC.openRuntimeInBrowser handler.
 * Requires runtime ID.
 */
export const openRuntimeInBrowserSchema = z.object({
  id: runtimeIdSchema,
});

/**
 * Schema for IPC.revealRuntimeRoot handler.
 * Requires runtime ID.
 */
export const revealRuntimeRootSchema = z.object({
  id: runtimeIdSchema,
});

/**
 * Schema for IPC.setShellSidebarCollapsed handler.
 * Requires a boolean.
 */
export const setShellSidebarCollapsedSchema = z.object({
  collapsed: booleanSchema,
});

/**
 * Schema for IPC.navigateWebui handler.
 * Validates DesktopWebuiCommand structure.
 */
export const navigateWebuiSchema = z.object({
  command: z.unknown(),
});

/**
 * Schema for IPC.getConversation handler.
 * Requires runtime ID.
 */
export const getConversationSchema = z.object({
  runtimeId: runtimeIdSchema,
});

// ============================================================================
// Renderer Event Schemas (from preload)
// ============================================================================

/**
 * Schema for webui:readyChanged event.
 * Requires a boolean ready state.
 */
export const webuiReadyChangedSchema = z.object({
  ready: booleanSchema,
});

/**
 * Schema for webui:prefsChanged event.
 * Validates WebUI preferences object.
 */
export const webuiPrefsChangedSchema = z.object({
  prefs: z.record(z.string(), z.unknown()),
});

/**
 * Schema for webui:commandAck event.
 * Requires requestId (string) and handled (boolean).
 */
export const webuiCommandAckSchema = z.object({
  requestId: z.string(),
  handled: z.boolean(),
  message: z.string().optional(),
});

/**
 * Schema for desktop:setLocale event.
 * Requires locale code string.
 */
export const setLocaleSchema = z.object({
  locale: z.string().min(2).max(10),
});
