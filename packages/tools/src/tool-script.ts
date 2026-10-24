/**
 * `tool_script` — WrongStack ToolFlow: the model writes one short JavaScript program
 * that calls tools as async functions, loops over and filters their results,
 * and only the value it returns goes back into the conversation.
 *
 * The program runs in QuickJS compiled to WebAssembly: no filesystem, network,
 * process, `require` or `import`. Its only way to affect anything is a tool
 * call, and every call goes through the agent's own gate
 * (`ctx.nestedToolCall`): the same validation, hooks, permission check, user
 * confirmation and journaling as a call the model made itself.
 *
 * What stops a script: its wall-clock timeout (`timeout_ms`, 0 = none), the
 * user interrupting the run, a stretch of computation that never pauses (the
 * VM runs on the host's event loop, which an endless loop would freeze past
 * any abort), and the tool memory guard. There is no call budget unless the
 * model sets `max_calls`, and nothing it returns is cut: large results are
 * spooled by the executor like any tool's output.
 *
 * @module tools/tool-script
 */
import type { NestedToolCaller, Tool } from '@wrongstack/contracts/types';
import { TOOL_MEMORY_GUARD_BYTES } from '@wrongstack/contracts/types';
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten-core';

export interface ToolScriptInput {
  script: string;
  description?: string | undefined;
  timeout_ms?: number | undefined;
  max_calls?: number | undefined;
}

export const TOOL_SCRIPT_NAME = 'tool_script';
/** Set on the context while a script runs. */
const SCRIPT_RUNNING_META_KEY = 'toolScriptRunning';

const DEFAULT_TIMEOUT_MS = 120_000;
/** The longest delay a Node timer takes. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * The longest the program may compute without pausing at an `await`. The VM
 * runs on the host's event loop: while it computes, nothing else in the
 * process runs, not even the abort that would stop it.
 */
const MAX_UNPAUSED_MS = 5_000;
/** QuickJS's native stack; deeper recursion is an error, not a crash. */
const STACK_LIMIT_BYTES = 1024 * 1024;

let quickJs: Promise<QuickJSWASMModule> | undefined;

/** Loaded on first use: nothing pays for WebAssembly until a script runs. */
function loadQuickJs(): Promise<QuickJSWASMModule> {
  quickJs ??= (async () => {
    const [{ newQuickJSWASMModuleFromVariant }, variant] = await Promise.all([
      import('quickjs-emscripten-core'),
      import('@jitl/quickjs-singlefile-mjs-release-sync'),
    ]);
    return newQuickJSWASMModuleFromVariant(variant.default);
  })();
  quickJs.catch(() => {
    quickJs = undefined;
  });
  return quickJs;
}

/** `timeout_ms`: unset → the default, 0 → no limit. */
function scriptTimeout(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_TIMEOUT_MS;
  if (value === 0) return undefined;
  return Math.min(Math.max(1, Math.floor(value)), MAX_TIMER_MS);
}

/** `max_calls`: unset → no limit. */
function callLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function render(value: unknown): string {
  if (value === undefined) return '(the script returned nothing)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The error a script failure is reported as, with what already ran. */
class ToolScriptError extends Error {}

interface RunState {
  vm: QuickJSContext;
  /** `done` once the call settled; a call not done is still running. */
  calls: Array<{ name: string; ok: boolean; done: boolean }>;
  logs: string[];
  logChars: number;
  /** Console output past the memory guard that was not kept. */
  droppedLogLines: number;
  /** Deferred results not yet handed back; disposed if the run is cut short. */
  pending: Set<{ dispose(): void; alive: boolean }>;
  enteredAt: number | undefined;
  stopped: string | undefined;
  toolResultBytes: number;
}

function callSummary(calls: RunState['calls']): string {
  if (calls.length === 0) return 'no tool calls';
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const failed = calls.filter((call) => call.done && !call.ok).length;
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `${calls.length} tool call${calls.length === 1 ? '' : 's'}: ${parts.join(', ')}${failed ? ` (${failed} failed)` : ''}`;
}

export const toolScriptTool: Tool<ToolScriptInput, string> = {
  name: TOOL_SCRIPT_NAME,
  category: 'Meta',
  description:
    'WrongStack ToolFlow: run a short JavaScript program that calls tools as async functions and returns only its result.',
  usageHint:
    'WRONGSTACK TOOLFLOW — compose several tool calls in one step:\n\n' +
    '- `script` is the body of an async function: use `await`, loops, and `return` the value you want back.\n' +
    '- Set `description` to a short human-readable purpose shown in the activity history. Await every tool call before returning.\n' +
    '- Call a tool as `await tools.read({ path: "src/a.ts" })` or `await tools.call("codebase-search", { query: "x" })`. ' +
    'Each call returns the tool result as text (JSON.parse it when it is JSON) and throws when the tool fails.\n' +
    '- `Promise.all` runs calls side by side; `console.log` lines come back with the result.\n' +
    '- `tools.names()` lists the enabled catalog, including deferred tools. `tools.describe(name)` returns input/output schemas and usage guidance without a tool call. `tools.data(name, input)` returns validated structured JSON for tools declaring outputSchema; inspect that schema first. Existing tools.call/name calls still return text. Use exact names with tools.call for hyphens or reserved names (`call`, `data`, `names`, `describe`).\n' +
    '- The returned value, call summary, measured byte counts, and console output enter the conversation; intermediate tool results do not. Filter and summarize in the script.\n' +
    '- There is no filesystem, network or process access except through tools, and every call is checked and confirmed exactly like a direct call.\n' +
    `- The script stops after ${DEFAULT_TIMEOUT_MS / 1000}s unless you set \`timeout_ms\` (0 = no limit), and when it computes for ${MAX_UNPAUSED_MS / 1000}s without awaiting anything. \`max_calls\` caps its tool calls if you want a cap.`,
  // Running the program touches nothing; every effect is a tool call with its
  // own permission check, so confirming the script as well would ask twice.
  // Not `mutating` for the same reason: the policy confirms every mutating
  // tool, and a write the script makes is judged as the write it is.
  permission: 'auto',
  mutating: false,
  // Its own timer enforces `timeout_ms`; the executor's generic ceiling would
  // cut a longer script short and make `timeout_ms: 0` impossible.
  managesOwnTimeout: true,
  capabilities: ['tool.meta'],
  icon: 'meta',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        maxLength: 200,
        description:
          'Short human-readable purpose of this ToolFlow run, shown in activity history.',
      },
      script: {
        type: 'string',
        description:
          'Body of an async JavaScript function. Call tools via `tools.<name>(input)` or `tools.call(name, input)`; `return` the result.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 0,
        description: `Wall-clock limit for the whole script in ms (default ${DEFAULT_TIMEOUT_MS}). 0 = no limit; the user can still interrupt.`,
      },
      max_calls: {
        type: 'integer',
        minimum: 1,
        description: 'Most tool calls the script may make. No limit when unset.',
      },
    },
    required: ['script'],
  },

  async execute(input, ctx, opts) {
    if (opts.signal.aborted)
      throw new ToolScriptError('The script was stopped: the run was stopped.');
    const script = typeof input.script === 'string' ? input.script : '';
    if (!script.trim()) throw new ToolScriptError('`script` is empty.');
    const caller = (ctx as { nestedToolCall?: NestedToolCaller | undefined }).nestedToolCall;
    if (!caller) {
      throw new ToolScriptError('This agent cannot run tool scripts (no tool gate is attached).');
    }
    // A script reached from inside a script (through `tool_use`) would run on
    // the same agent with a fresh budget each time.
    if (ctx.meta[SCRIPT_RUNNING_META_KEY] === true) {
      throw new ToolScriptError('A tool script cannot run inside another tool script.');
    }
    const parentToolUseId = opts.toolUseId ?? `script-${Date.now().toString(36)}`;
    const timeoutMs = scriptTimeout(input.timeout_ms);
    const maxCalls = callLimit(input.max_calls);
    const catalog = (ctx.catalogTools ?? ctx.tools).filter(
      (tool) => tool.name !== TOOL_SCRIPT_NAME,
    );
    const toolNames = catalog.map((tool) => tool.name);

    const module = await loadQuickJs();
    // Another call may have acquired the context while WebAssembly was loading.
    if (ctx.meta[SCRIPT_RUNNING_META_KEY] === true) {
      throw new ToolScriptError('A tool script cannot run inside another tool script.');
    }
    if (opts.signal.aborted)
      throw new ToolScriptError('The script was stopped: the run was stopped.');
    ctx.meta[SCRIPT_RUNNING_META_KEY] = true;
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(TOOL_MEMORY_GUARD_BYTES);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    const vm = runtime.newContext();
    const state: RunState = {
      vm,
      calls: [],
      logs: [],
      logChars: 0,
      droppedLogLines: 0,
      pending: new Set(),
      enteredAt: undefined,
      stopped: undefined,
      toolResultBytes: 0,
    };
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    let finished = false;
    const stop = (reason: string): void => {
      state.stopped ??= reason;
    };
    runtime.setInterruptHandler(() => {
      if (opts.signal.aborted) stop('the run was stopped');
      if (deadline !== undefined && Date.now() > deadline) {
        stop(`the script ran past its ${timeoutMs} ms limit`);
      }
      if (state.enteredAt !== undefined && Date.now() - state.enteredAt > MAX_UNPAUSED_MS) {
        stop(`the script computed for ${MAX_UNPAUSED_MS} ms without pausing at an await`);
      }
      return state.stopped !== undefined;
    });

    /** Run code inside the VM, timing the stretch for the unpaused-computation guard. */
    const enter = <T>(fn: () => T): T => {
      state.enteredAt = Date.now();
      try {
        return fn();
      } finally {
        state.enteredAt = undefined;
      }
    };
    const pump = (): void => {
      if (!vm.alive) return;
      enter(() => {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) jobs.error.dispose();
      });
    };

    let callIndex = 0;
    const callTool = (
      nameHandle: QuickJSHandle,
      inputHandle: QuickJSHandle | undefined,
      resultFormat?: 'data',
    ) => {
      const name = vm.getString(nameHandle);
      const toolInput = inputHandle === undefined ? {} : vm.dump(inputHandle);
      const deferred = vm.newPromise();
      const entry = {
        alive: true,
        dispose: () => {
          if (entry.alive) {
            entry.alive = false;
            deferred.dispose();
          }
        },
      };
      state.pending.add(entry);
      const settle = (ok: boolean, text: string, data?: { value: unknown }): void => {
        state.pending.delete(entry);
        if (finished && state.pending.size === 0) delete ctx.meta[SCRIPT_RUNNING_META_KEY];
        if (!entry.alive || !vm.alive) return;
        let value: QuickJSHandle;
        try {
          value =
            ok && data
              ? vm.unwrapResult(
                  vm.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(data.value))})`),
                )
              : ok
                ? vm.newString(text)
                : vm.newError(text);
        } catch {
          ok = false;
          value = vm.newError('Structured tool output could not be transferred into ToolFlow.');
        }
        if (ok) deferred.resolve(value);
        else deferred.reject(value);
        value.dispose();
        entry.alive = false;
        deferred.dispose();
        pump();
      };
      if (name === TOOL_SCRIPT_NAME) {
        queueMicrotask(() => settle(false, 'A tool script cannot run another tool script.'));
      } else if (maxCalls !== undefined && state.calls.length >= maxCalls) {
        queueMicrotask(() =>
          settle(false, `The script reached its limit of ${maxCalls} tool calls.`),
        );
      } else if (state.stopped || opts.signal.aborted) {
        if (opts.signal.aborted) stop('the run was stopped');
        queueMicrotask(() => settle(false, `The script was stopped: ${state.stopped}.`));
      } else {
        const record = { name, ok: false, done: false };
        state.calls.push(record);
        callIndex += 1;
        caller({
          name,
          input: toolInput,
          parentToolUseId,
          index: callIndex,
          ...(resultFormat ? { resultFormat } : {}),
        }).then(
          (result) => {
            record.done = true;
            state.toolResultBytes += new TextEncoder().encode(result.content).length;
            record.ok = !result.isError;
            if (resultFormat && !result.isError && !Object.hasOwn(result, 'data')) {
              record.ok = false;
              settle(
                false,
                `Tool "${name}" did not supply structured output. The tool already ran; do not repeat mutations.`,
              );
            } else {
              settle(
                !result.isError,
                result.content,
                resultFormat && !result.isError ? { value: result.data } : undefined,
              );
            }
          },
          (err: unknown) => {
            record.done = true;
            settle(false, err instanceof Error ? err.message : String(err));
          },
        );
      }
      return deferred.handle;
    };

    try {
      // The API the program sees: `tools.call`, one function per tool name,
      // `tools.names()` and a captured `console.log`.
      const toolsObject = vm.newObject();
      const callFn = vm.newFunction('call', (nameHandle, inputHandle) =>
        callTool(nameHandle, inputHandle),
      );
      vm.setProp(toolsObject, 'call', callFn);
      const dataFn = vm.newFunction('data', (nameHandle, inputHandle) =>
        callTool(nameHandle, inputHandle, 'data'),
      );
      vm.setProp(toolsObject, 'data', dataFn);
      dataFn.dispose();
      for (const name of toolNames) {
        if (['call', 'data', 'names', 'describe'].includes(name)) continue;
        const fn = vm.newFunction(name, (inputHandle) => {
          const nameHandle = vm.newString(name);
          try {
            return callTool(nameHandle, inputHandle);
          } finally {
            nameHandle.dispose();
          }
        });
        vm.setProp(toolsObject, name, fn);
        fn.dispose();
      }
      callFn.dispose();
      const namesFn = vm.newFunction('names', () => {
        const list = vm.newArray();
        toolNames.forEach((name, i) => {
          const item = vm.newString(name);
          vm.setProp(list, i, item);
          item.dispose();
        });
        return list;
      });
      vm.setProp(toolsObject, 'names', namesFn);
      namesFn.dispose();
      const describeFn = vm.newFunction('describe', (nameHandle) => {
        const name = vm.getString(nameHandle);
        const tool = catalog.find((entry) => entry.name === name);
        if (!tool)
          return {
            error: vm.newError(
              `No enabled tool named "${name}". Use tools.names() to discover exact names.`,
            ),
          };
        const description = {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          usageHint: tool.usageHint,
          permission: tool.permission,
          mutating: tool.mutating,
        };
        return vm.unwrapResult(
          vm.evalCode(`JSON.parse(${JSON.stringify(JSON.stringify(description))})`),
        );
      });
      vm.setProp(toolsObject, 'describe', describeFn);
      describeFn.dispose();
      vm.setProp(vm.global, 'tools', toolsObject);
      toolsObject.dispose();

      const consoleObject = vm.newObject();
      const logFn = vm.newFunction('log', (...args) => {
        const line = args
          .map((arg) => {
            const value = vm.dump(arg);
            return typeof value === 'string' ? value : render(value);
          })
          .join(' ');
        // Only the memory guard holds console output back.
        if (state.logChars + line.length < TOOL_MEMORY_GUARD_BYTES) {
          state.logs.push(line);
          state.logChars += line.length + 1;
        } else {
          state.droppedLogLines += 1;
        }
      });
      vm.setProp(consoleObject, 'log', logFn);
      vm.setProp(consoleObject, 'error', logFn);
      vm.setProp(consoleObject, 'warn', logFn);
      logFn.dispose();
      vm.setProp(vm.global, 'console', consoleObject);
      consoleObject.dispose();

      const evaluated = enter(() =>
        vm.evalCode(`(async () => {\n${script}\n})()`, 'tool_script.js'),
      );
      if (evaluated.error) {
        const error = vm.dump(evaluated.error) as { name?: string; message?: string };
        evaluated.error.dispose();
        throw new ToolScriptError(describeError(error, state));
      }
      const settledPromise = vm.resolvePromise(evaluated.value);
      evaluated.value.dispose();
      pump();

      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const cutShort = new Promise<'cut'>((resolve) => {
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            stop(`the script ran past its ${timeoutMs} ms limit`);
            resolve('cut');
          }, timeoutMs);
        }
        onAbort = () => {
          stop('the run was stopped');
          resolve('cut');
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      });
      const outcome = await Promise.race([settledPromise, cutShort]);
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal.removeEventListener('abort', onAbort);

      if (outcome === 'cut') {
        const running = state.calls.filter((c) => !c.done).length;
        throw new ToolScriptError(
          `The script was stopped: ${state.stopped}. ${callSummary(state.calls)}${running > 0 ? '; calls already started keep running' : ''}.`,
        );
      }
      if (outcome.error) {
        const error = vm.dump(outcome.error) as { name?: string; message?: string };
        outcome.error.dispose();
        throw new ToolScriptError(describeError(error, state));
      }
      const value = vm.dump(outcome.value);
      outcome.value.dispose();
      if (state.pending.size > 0) {
        throw new ToolScriptError(
          `The script returned with ${state.pending.size} unfinished tool calls. Await every tool call before returning; calls already started keep running. (${callSummary(state.calls)})`,
        );
      }

      const sections = [render(value), `(${callSummary(state.calls)})`];
      if (state.logs.length > 0) {
        const dropped =
          state.droppedLogLines > 0
            ? `\n[${state.droppedLogLines} more lines not kept: console output reached the ${TOOL_MEMORY_GUARD_BYTES / (1024 * 1024)} MiB memory guard]`
            : '';
        sections.push(`console:\n${state.logs.join('\n')}${dropped}`);
      }
      const returned = sections.join('\n\n');
      return `${returned}\n\nToolFlow bytes: ${state.toolResultBytes} -> ${new TextEncoder().encode(returned).length}; calls: ${state.calls.length}; failed: ${state.calls.filter((call) => !call.ok).length}`;
    } finally {
      finished = true;
      if (state.pending.size === 0) delete ctx.meta[SCRIPT_RUNNING_META_KEY];
      for (const entry of state.pending) entry.dispose();
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        // A handle still held by an unfinished call; the runtime is dropped
        // with the WebAssembly memory it lives in.
      }
    }
  },
};

function describeError(error: { name?: string; message?: string }, state: RunState): string {
  const reason = state.stopped
    ? `The script was stopped: ${state.stopped}.`
    : `The script failed: ${error.name ?? 'Error'}: ${error.message ?? String(error)}`;
  return `${reason} (${callSummary(state.calls)})`;
}
