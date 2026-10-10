/**
 * Code Assist routes — the server half of the "Ask AI" panel that the WebUI
 * mounts on both the File Manager and the Code Atlas.
 *
 * Wire shape:
 *   client → `code.assist.run`    { requestId, filePath, symbol?, line?, preset, question?, allowEdits? }
 *   server → `code.assist.started` { requestId, preset, filePath, symbol? }
 *   server → `code.assist.delta`   { requestId, text }
 *   server → `code.assist.result`  { requestId, status, text?, error?, appliedEdits? }
 *   client → `code.assist.abort`  { requestId }
 *
 * WHY THIS IS NOT A SESSION
 * -------------------------
 * The obvious implementation — open a `session.new` and drive a normal chat
 * turn — is the wrong shape for a small side panel, and not for a stylistic
 * reason. `session.new` (see `session-handlers.ts` → `activateSession` in
 * `session-handler-helpers.ts`) re-points the RUNTIME'S FOREGROUND SESSION and
 * persists a new row that the user's session list then has to show and clean
 * up. A user who asks two questions about one file would silently end up with
 * two junk sessions, and their in-flight chat would have been swapped out from
 * under them.
 *
 * So a run here uses the same primitive the SDD interview and the goal workers
 * already use: build a throwaway isolated agent from the shared
 * `AgentFactory`, run ONE turn on it, take `finalText`, dispose. It never
 * creates a session, never touches the foreground, and never appears in
 * `sessions.list`. That is what "one-shot" buys us.
 *
 * Streaming: the factory hands back the agent's own private `EventBus`
 * (`makeLightSubagentFactory` constructs one per agent — see
 * `light-subagent-factory.ts`), so we can forward `provider.text_delta` chunks
 * to the panel without those tokens ever reaching the shared chat bus.
 */
import type { AgentFactory } from '@wrongstack/core/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  codeAssistAllowsEdits,
  type CodeAssistPreset,
  type CodeAssistResult,
  type CodeAssistRunRequest,
} from '@wrongstack/webui-protocol';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';
import { buildCodeAssistPrompt } from './code-assist-prompt.js';

export interface CodeAssistRouteHandlers {
  run: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  abort: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

const CODE_ASSIST_PRESETS: ReadonlySet<string> = new Set<CodeAssistPreset>([
  'overview',
  'explain',
  'quality',
  'bugs',
  'security',
  'tests',
  'impact',
  'fix',
  'custom',
]);

/** Longest target path we will echo into a prompt. */
const MAX_PATH_LENGTH = 400;
const MAX_QUESTION_LENGTH = 4_000;

export function isKnownCodeAssistPreset(value: unknown): value is CodeAssistPreset {
  return typeof value === 'string' && CODE_ASSIST_PRESETS.has(value);
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Validate the run payload. Returns `null` for anything we refuse to execute —
 * the caller turns that into a terminal `error` frame rather than throwing, so
 * a malformed request can never take down the socket.
 */
export function parseCodeAssistRunRequest(payload: unknown): CodeAssistRunRequest | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const requestId = str(p['requestId'], 200);
  const filePath = str(p['filePath'], MAX_PATH_LENGTH);
  if (!requestId || !filePath) return null;
  if (!isKnownCodeAssistPreset(p['preset'])) return null;

  const line = typeof p['line'] === 'number' && Number.isFinite(p['line']) ? p['line'] : undefined;
  return {
    requestId,
    filePath,
    preset: p['preset'],
    ...(str(p['symbol'], 200) ? { symbol: str(p['symbol'], 200) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(str(p['question'], MAX_QUESTION_LENGTH)
      ? { question: str(p['question'], MAX_QUESTION_LENGTH) }
      : {}),
    ...(p['allowEdits'] === true ? { allowEdits: true } : {}),
  };
}

/** Build the route handlers. `projectRoot` is read lazily: project switches re-root it. */
export function createCodeAssistRouteHandlers(deps: {
  subagentFactory: AgentFactory;
  projectRoot: () => string;
  send: (ws: WebSocket, msg: { type: string; payload: unknown }) => void;
  log?: ((message: string) => void) | undefined;
}): CodeAssistRouteHandlers {
  /**
   * In-flight runs, keyed by requestId. Two panels (File Manager AND Code
   * Atlas) can each have a live run against the same socket, so this is a map
   * and not a single "current" controller.
   */
  const inflight = new Map<string, AbortController>();

  const fail = (ws: WebSocket, requestId: string, error: string): void => {
    const payload: CodeAssistResult = { requestId, status: 'error', error };
    deps.send(ws, { type: 'code.assist.result', payload });
  };

  return {
    abort: async (_ws, msg) => {
      const requestId = str(
        (msg.payload as Record<string, unknown> | undefined)?.['requestId'],
        200,
      );
      if (!requestId) return;
      // Aborting an unknown id is a no-op, not an error: the panel may fire
      // abort on unmount after the run already settled.
      inflight.get(requestId)?.abort();
    },

    run: async (ws, msg) => {
      const request = parseCodeAssistRunRequest(msg.payload);
      if (!request) {
        const rawId = str((msg.payload as Record<string, unknown> | undefined)?.['requestId'], 200);
        fail(ws, rawId ?? '', 'Invalid Code Assist request.');
        return;
      }

      const { requestId, preset, filePath } = request;
      // A second run reusing a live id would orphan the first one's
      // AbortController; cancel it first so only one run owns the id.
      inflight.get(requestId)?.abort();
      const controller = new AbortController();
      inflight.set(requestId, controller);

      const allowEdits = codeAssistAllowsEdits(preset, request.allowEdits === true);
      const prompt = buildCodeAssistPrompt(request, {
        projectRoot: deps.projectRoot(),
        allowEdits,
      });

      deps.send(ws, {
        type: 'code.assist.started',
        payload: {
          requestId,
          preset,
          filePath,
          ...(request.symbol ? { symbol: request.symbol } : {}),
        },
      });

      let unsubscribe: (() => void) | undefined;
      try {
        const built = await deps.subagentFactory({
          name: `code-assist-${preset}`.slice(0, 48),
          role: 'executor',
          cwd: deps.projectRoot(),
          // `fix` also gets `shell.restricted`, because its own contract
          // ("run the project's typecheck and the relevant tests") is
          // unimplementable without one. Without it the agent is asked to
          // verify a change it can never verify, and the correct response is
          // to refuse to edit at all — which is exactly what a live run showed.
          // Deliberately NOT granted: `net.outbound` and `package.install`, so
          // a fix cannot reach the network or mutate dependencies.
          allowedCapabilities: allowEdits
            ? ['fs.read', 'fs.write', 'shell.restricted']
            : ['fs.read'],
        });
        try {
          // Forward the isolated agent's own stream to THIS panel only. The
          // factory gives it a private bus, so no chat surface sees these.
          unsubscribe = built.events.on('provider.text_delta', (e) => {
            const text = (e as { text?: string }).text;
            if (!text) return;
            deps.send(ws, { type: 'code.assist.delta', payload: { requestId, text } });
          });

          const result = (await built.agent.run(prompt, {
            signal: controller.signal,
          })) as {
            status?: string | undefined;
            finalText?: string | undefined;
            error?: { message?: string | undefined } | undefined;
          };

          if (controller.signal.aborted) {
            const payload: CodeAssistResult = { requestId, status: 'aborted' };
            deps.send(ws, { type: 'code.assist.result', payload });
            return;
          }
          if (result.status !== 'done') {
            const payload: CodeAssistResult = {
              requestId,
              status: 'error',
              error:
                result.error?.message ??
                `Code Assist run ended with status "${result.status ?? 'unknown'}".`,
            };
            deps.send(ws, { type: 'code.assist.result', payload });
            return;
          }

          const payload: CodeAssistResult = {
            requestId,
            status: 'done',
            text: result.finalText ?? '',
            // The panel warns on the working tree only when this is true, so a
            // read-only analysis can never imply it changed something.
            appliedEdits: allowEdits,
          };
          deps.send(ws, { type: 'code.assist.result', payload });
        } finally {
          unsubscribe?.();
          await built.dispose?.();
        }
      } catch (err) {
        const message = toErrorMessage(err);
        deps.log?.(`code.assist.run failed: ${message}`);
        // A cancellation surfaces as a thrown AbortError on some providers;
        // report it as `aborted` so the panel does not show a scary error for
        // a run the user themselves stopped.
        if (controller.signal.aborted) {
          const payload: CodeAssistResult = { requestId, status: 'aborted' };
          deps.send(ws, { type: 'code.assist.result', payload });
        } else {
          fail(ws, requestId, message);
        }
      } finally {
        // Only clear if we are still the owner: a newer run may have replaced
        // this entry while we were awaiting.
        if (inflight.get(requestId) === controller) inflight.delete(requestId);
      }
    },
  };
}

export async function handleCodeAssistRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: CodeAssistRouteHandlers,
): Promise<boolean> {
  if (msg.type === 'code.assist.run') {
    await handlers.run(ws, msg);
    return true;
  }
  if (msg.type === 'code.assist.abort') {
    await handlers.abort(ws, msg);
    return true;
  }
  return false;
}
