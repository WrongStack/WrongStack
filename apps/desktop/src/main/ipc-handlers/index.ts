/**
 * IPC handler registration with validation.
 * Centralizes all IPC handler registration logic with Zod schema validation.
 */
import { ipcMain } from 'electron';
import type { DesktopWebuiPrefs } from '../../shared/types.js';
import { IPC } from '../ipc.js';
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
 * Register all IPC handlers with validation.
 */
export function registerIpcHandlers(ctx: IpcHandlerContext): void {
  // State handlers (no validation needed - internal data)
  ipcMain.handle(IPC.getState, () => ctx.getRuntimeManager().snapshot());

  ipcMain.handle(IPC.getConversation, (_event, runtimeId: unknown) => {
    const result = validate(runtimeIdSchema, runtimeId);
    if (!result.success) {
      validationLogger.log(`getConversation: ${result.error}`);
      return ctx.getAgentBridge().snapshot('');
    }
    return ctx.getAgentBridge().snapshot(result.data);
  });

  ipcMain.handle(IPC.getWebuiStatus, () => ctx.getWebuiStatus());

  // Navigation handlers
  ipcMain.handle(IPC.navigateWebui, async (_event, command: unknown) => {
    // Command validation is handled by normalizeDesktopWebuiCommand
    return ctx.dispatchWebuiCommand(command);
  });

  ipcMain.handle(IPC.reloadWebui, async () => ctx.reloadActiveWebuiView());

  // Shell handlers
  ipcMain.handle(IPC.setShellSidebarCollapsed, (_event, collapsed: unknown) => {
    const result = validateOrDefault(booleanSchema, collapsed, true);
    ctx.setShellSidebarCollapsed(result);
    return true;
  });

  ipcMain.handle(IPC.openSettings, async () => ctx.openSettings());

  // Project handlers
  ipcMain.handle(IPC.openProjectSession, async (_event, runtimeId: unknown) => {
    const validated = validateOptional(runtimeIdSchema, runtimeId);
    return ctx.openProjectSession(validated);
  });

  // projectRootSchema, not pathSchema: this value becomes a spawned agent's
  // working directory, and pathSchema only bounds the string's length.
  ipcMain.handle(IPC.openProject, async (_event, requestedRoot: unknown) => {
    const validated = validateOptional(projectRootSchema, requestedRoot);
    return ctx.openProject(validated);
  });

  ipcMain.handle(IPC.registerProject, async (_event, requestedRoot: unknown) => {
    const validated = validateOptional(projectRootSchema, requestedRoot);
    return ctx.registerProject(validated);
  });

  ipcMain.handle(IPC.unregisterProject, async (_event, root: unknown) => {
    const result = validate(pathSchema, root);
    if (!result.success) {
      validationLogger.log(`unregisterProject: ${result.error}`);
      return ctx.getRuntimeManager().snapshot();
    }
    return ctx.unregisterProject(result.data);
  });

  // Runtime handlers
  ipcMain.handle(IPC.activateRuntime, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`activateRuntime: ${result.error}`);
      return ctx.getRuntimeManager().snapshot();
    }
    return ctx.activateRuntime(result.data);
  });

  ipcMain.handle(IPC.closeRuntime, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`closeRuntime: ${result.error}`);
      return ctx.getRuntimeManager().snapshot();
    }
    return ctx.closeRuntime(result.data);
  });

  ipcMain.handle(IPC.sendMessage, async (_event, id: unknown, content: unknown) => {
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

  ipcMain.handle(IPC.abortRuntime, async (_event, id: unknown) => {
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

  ipcMain.handle(IPC.openRuntimeInBrowser, async (_event, id: unknown) => {
    const result = validate(runtimeIdSchema, id);
    if (!result.success) {
      validationLogger.log(`openRuntimeInBrowser: ${result.error}`);
      return;
    }
    const url = ctx.getRuntimeManager().getRuntimeUrlWithToken(result.data);
    if (url) ctx.openExternal(url);
  });

  ipcMain.handle(IPC.revealRuntimeRoot, async (_event, id: unknown) => {
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
