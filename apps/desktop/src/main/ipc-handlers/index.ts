/**
 * IPC handler registration with validation.
 * Centralizes all IPC handler registration logic with Zod schema validation.
 */
import { ipcMain } from 'electron';
import type { DesktopWebuiPrefs } from '../../shared/types.js';
import { IPC } from '../ipc.js';
import { listProjectSessions } from '../session-index.js';
import type { IpcHandlerContext } from '../state/types.js';
import { createValidationLogger, validate, validateOrDefault } from '../validation/index.js';
import {
  booleanSchema,
  pathSchema,
  projectRootSchema,
  runtimeIdSchema,
  setLocaleSchema,
  webuiCommandAckSchema,
} from '../validation/schemas.js';

// Validation logger for tracking malformed messages
const validationLogger = createValidationLogger('IPC');

/**
 * True when an `invoke` came from the shell renderer we author ourselves.
 *
 * WS-SEC-13: none of the `handle` channels below looked at their sender, while
 * the three `ipcMain.on` handlers in this same file already resolve one. The
 * window hosts a second renderer — the WebUI view — whose content is remote
 * (`http://127.0.0.1:<port>`) and reflects agent and tool output. Nothing there
 * can reach `invoke` today: the WebUI preload exposes no such bridge, and the
 * view runs sandboxed with `contextIsolation`. But "unreachable because another
 * file does not expose it" is not a boundary, and every channel here spawns
 * runtimes, opens paths, or sends messages into a live agent. Gating at
 * registration rather than per handler means a channel added later is covered
 * by construction.
 */
function isShellSender(ctx: IpcHandlerContext, senderId: number): boolean {
  const shell = ctx.getShellView();
  if (shell === null) return false;
  const contents = shell.webContents;
  return !contents.isDestroyed() && contents.id === senderId;
}

/**
 * Register an `invoke` channel that only the shell renderer may call.
 *
 * A rejected sender throws rather than returning a default: it is not a normal
 * condition, and a silent default would look to the caller like an empty
 * result rather than a refusal.
 */
function handleShellOnly(
  ctx: IpcHandlerContext,
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isShellSender(ctx, event.sender.id)) {
      validationLogger.log(`${channel}: rejected invoke from sender ${event.sender.id}`);
      throw new Error(`IPC channel ${channel} is restricted to the shell renderer`);
    }
    return handler(event, ...(args as never[]));
  });
}

/**
 * Register all IPC handlers with validation.
 */
export function registerIpcHandlers(ctx: IpcHandlerContext): void {
  // State handlers (no validation needed - internal data)
  handleShellOnly(ctx, IPC.getState, () => ctx.getRuntimeManager().snapshot());

  handleShellOnly(ctx, IPC.getConversation, (_event, runtimeId: unknown) => {
    const result = validate(runtimeIdSchema, runtimeId);
    if (!result.success) {
      validationLogger.log(`getConversation: ${result.error}`);
      return ctx.getAgentBridge().snapshot('');
    }
    return ctx.getAgentBridge().snapshot(result.data);
  });

  handleShellOnly(ctx, IPC.getWebuiStatus, () => ctx.getWebuiStatus());

  // Sessions under a project in the sidebar tree. Read on demand (when a
  // project row is expanded), never pushed with the state snapshot: a project's
  // history does not change with runtime status, and shipping it on every
  // broadcast is how the snapshot got expensive in the first place.
  handleShellOnly(ctx, IPC.listProjectSessions, async (_event, root: unknown) => {
    const result = validate(pathSchema, root);
    if (!result.success) {
      validationLogger.log(`listProjectSessions: ${result.error}`);
      return [];
    }
    return listProjectSessions(result.data);
  });

  // Navigation handlers
  handleShellOnly(ctx, IPC.navigateWebui, async (_event, command: unknown) => {
    // Command validation is handled by normalizeDesktopWebuiCommand
    return ctx.dispatchWebuiCommand(command);
  });

  handleShellOnly(ctx, IPC.reloadWebui, async () => ctx.reloadActiveWebuiView());

  // Shell handlers
  handleShellOnly(ctx, IPC.setShellSidebarCollapsed, (_event, collapsed: unknown) => {
    const result = validateOrDefault(booleanSchema, collapsed, true);
    ctx.setShellSidebarCollapsed(result);
    return true;
  });

  handleShellOnly(ctx, IPC.openSettings, async () => ctx.openSettings());

  // Project handlers
  handleShellOnly(ctx, IPC.openProjectSession, async (_event, runtimeId: unknown) => {
    const validated = validateOptional(runtimeIdSchema, runtimeId);
    return ctx.openProjectSession(validated);
  });

  // projectRootSchema, not pathSchema: this value becomes a spawned agent's
  // working directory, and pathSchema only bounds the string's length.
  handleShellOnly(ctx, IPC.openProject, async (_event, requestedRoot: unknown) => {
    const validated = validateOptional(projectRootSchema, requestedRoot);
    return ctx.openProject(validated);
  });

  handleShellOnly(ctx, IPC.registerProject, async (_event, requestedRoot: unknown) => {
    const validated = validateOptional(projectRootSchema, requestedRoot);
    return ctx.registerProject(validated);
  });

  handleShellOnly(ctx, IPC.unregisterProject, async (_event, root: unknown) => {
    const result = validate(pathSchema, root);
    if (!result.success) {
      validationLogger.log(`unregisterProject: ${result.error}`);
      return ctx.getRuntimeManager().snapshot();
    }
    return ctx.unregisterProject(result.data);
  });

  // Runtime handlers
  handleShellOnly(ctx, IPC.activateRuntime, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`activateRuntime: ${result.error}`);
      return ctx.getRuntimeManager().snapshot();
    }
    return ctx.activateRuntime(result.data);
  });

  handleShellOnly(ctx, IPC.closeRuntime, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`closeRuntime: ${result.error}`);
      return ctx.getRuntimeManager().snapshot();
    }
    return ctx.closeRuntime(result.data);
  });

  handleShellOnly(ctx, IPC.sendMessage, async (_event, id: unknown, content: unknown) => {
    const idResult = validate(runtimeIdSchema, id);
    if (!idResult.success) {
      validationLogger.log(`sendMessage (id): ${idResult.error}`);
      return ctx.sendMessage('', '', '');
    }
    const contentResult = validate(
      pathSchema.transform(() => String(content ?? '')),
      content,
    );
    const safeContent = contentResult.success ? contentResult.data : String(content ?? '');
    return ctx.sendMessage(
      idResult.data,
      ctx.getRuntimeManager().getRuntimeWsUrlWithToken(idResult.data) ?? '',
      safeContent,
    );
  });

  handleShellOnly(ctx, IPC.abortRuntime, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`abortRuntime: ${result.error}`);
      return ctx.abortRuntime('', '');
    }
    return ctx.abortRuntime(
      result.data,
      ctx.getRuntimeManager().getRuntimeWsUrlWithToken(result.data) ?? '',
    );
  });

  handleShellOnly(ctx, IPC.openRuntimeInBrowser, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`openRuntimeInBrowser: ${result.error}`);
      return;
    }
    const url = ctx.getRuntimeManager().getRuntimeUrlWithToken(result.data);
    if (url) ctx.openExternal(url);
  });

  handleShellOnly(ctx, IPC.revealRuntimeRoot, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`revealRuntimeRoot: ${result.error}`);
      return;
    }
    const runtime = ctx.getRuntimeManager().getRuntime(result.data);
    if (runtime) ctx.revealInExplorer(runtime.root);
  });

  // WebUI event handlers
  ipcMain.on(IPC.webuiReadyChanged, (event, ready: unknown) => {
    const entry = ctx.findWebuiEntryBySenderId(event.sender.id);
    if (!entry) return;
    const isReady = ready === true;
    entry.bridgeReady = isReady;
    if (entry.bridgeReady) {
      ctx.setEntryWebuiStatus(entry, { ...entry.status, status: 'ready' });
      ctx.schedulePendingWebuiFlush(entry);
    } else if (entry.status.status === 'ready') {
      ctx.setEntryWebuiStatus(entry, { ...entry.status, status: 'loading' });
    }
  });

  ipcMain.on(IPC.webuiPrefsChanged, (event, prefs: unknown) => {
    const entry = ctx.findWebuiEntryBySenderId(event.sender.id);
    if (!entry) return;
    const sanitized = sanitizeWebuiPrefs(prefs);
    if (Object.keys(sanitized).length === 0) return;
    ctx.setEntryWebuiStatus(entry, {
      ...entry.status,
      prefs: { ...(entry.status.prefs ?? {}), ...sanitized },
    });
  });

  ipcMain.on(
    IPC.webuiCommandAck,
    (event, requestId: unknown, handled: unknown, _message?: unknown) => {
      const entry = ctx.findWebuiEntryBySenderId(event.sender.id);
      if (!entry) return;

      const result = validate(webuiCommandAckSchema, {
        requestId,
        handled,
        message: _message,
      });

      if (!result.success) {
        validationLogger.log(`webuiCommandAck: ${result.error}`);
        return;
      }

      const pending = ctx.getPendingWebuiCommandAcks().get(result.data.requestId);
      if (!pending || pending.runtimeId !== entry.runtimeId) return;
      ctx.settlePendingWebuiCommandAck(result.data.requestId, result.data.handled);
    },
  );

  // Locale handlers
  ipcMain.on(IPC.setLocale, (_event, locale: unknown) => {
    const result = validate(setLocaleSchema, { locale });
    if (!result.success) {
      validationLogger.log(`setLocale: ${result.error}`);
      return;
    }
    ctx.getI18n().setMainLocale(result.data.locale);
    ctx.configureApplicationMenu();
    ctx.broadcastLocaleToEmbeddedWebuis(result.data.locale);
    void ctx.getConfigIo().writeUiLocale(result.data.locale);
  });
}

/**
 * Validate optional value with schema.
 */
function validateOptional<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } },
  value: unknown,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Sanitize WebUI preferences from renderer.
 */
function sanitizeWebuiPrefs(prefs: unknown): DesktopWebuiPrefs {
  const next: DesktopWebuiPrefs = {};
  if (!isRecord(prefs)) return next;
  if (typeof prefs['yolo'] === 'boolean') next.yolo = prefs['yolo'];
  if (typeof prefs['nextPrediction'] === 'boolean') next.nextPrediction = prefs['nextPrediction'];
  if (typeof prefs['contextAutoCompact'] === 'boolean') {
    next.contextAutoCompact = prefs['contextAutoCompact'];
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
