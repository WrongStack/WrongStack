import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Tool, ToolSettlement } from '@wrongstack/contracts/types/tool';

type Advice = Awaited<ReturnType<NonNullable<Tool['turnGuidance']>['create']>>;
const MAX_NOTE_CHARS = 2400;

async function withinDeadline<T>(
  parent: AbortSignal,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (parent.aborted) return undefined;
  const controller = new AbortController();
  let finish!: () => void;
  const deadline = new Promise<undefined>((resolve) => {
    finish = () => {
      controller.abort();
      resolve(undefined);
    };
  });
  const timer = setTimeout(finish, ms);
  parent.addEventListener('abort', finish, { once: true });
  try {
    return await Promise.race([deadline, work(controller.signal)]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', finish);
  }
}

/** All hosts share this bounded Tool Coach extension point. No project code runs. */
export async function createTurnToolGuidance(options: {
  task: string;
  projectRoot: string;
  signal: AbortSignal;
  tools: readonly Tool[];
  getTool(name: string): Tool | undefined;
  autoAllowed(tool: Tool, input: unknown): Promise<boolean>;
  deadlineMs?: number;
}) {
  const stillEnabled = (tool: Tool) =>
    options.getTool(tool.name) === tool &&
    tool.permission === 'auto' &&
    !tool.mutating &&
    (tool.turnGuidance?.requiredTools ?? []).every((name) => {
      const required = options.getTool(name);
      return required && required.permission !== 'deny';
    });
  const active =
    (await withinDeadline(options.signal, options.deadlineMs ?? 500, async (signal) => {
      const ready: Array<{ tool: Tool; advice: Advice }> = [];
      for (const tool of options.tools.filter((t) => t.turnGuidance).slice(0, 4)) {
        if (signal.aborted) break;
        if (!stillEnabled(tool)) continue;
        try {
          const factory = tool.turnGuidance;
          if (!factory || !(await options.autoAllowed(tool, factory.permissionInput))) continue;
          if (signal.aborted || !stillEnabled(tool)) break;
          const advice = await factory.create({
            task: options.task,
            projectRoot: options.projectRoot,
            signal,
          });
          if (!signal.aborted) ready.push({ tool, advice });
        } catch {
          /* Advice must never prevent an authorized task from continuing. */
        }
      }
      return ready;
    })) ?? [];

  function bounded(notes: Array<string | null>): string | null {
    const text = notes.filter((note): note is string => typeof note === 'string').join('\n');
    return text ? text.slice(0, MAX_NOTE_CHARS) : null;
  }
  return {
    initialNote: options.signal.aborted
      ? null
      : bounded(
          active.filter(({ tool }) => stillEnabled(tool)).map(({ advice }) => advice.initialNote),
        ),
    async afterTools(
      uses: readonly ToolUseBlock[],
      results: readonly ToolResultBlock[],
      settlements?: ReadonlyMap<string, ToolSettlement>,
    ) {
      return (
        (await withinDeadline(options.signal, options.deadlineMs ?? 500, async (signal) => {
          const notes: Array<string | null> = [];
          for (const { tool, advice } of active) {
            if (signal.aborted) break;
            if (!stillEnabled(tool)) continue;
            try {
              if (!(await options.autoAllowed(tool, tool.turnGuidance?.permissionInput))) continue;
              if (signal.aborted || !stillEnabled(tool)) break;
              notes.push(advice.afterTools(uses, results, settlements));
            } catch {
              /* Advisory failures do not change tool outcomes. */
            }
          }
          return bounded(notes);
        })) ?? null
      );
    },
  };
}
