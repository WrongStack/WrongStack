'use client';

/**
 * One transcript entry, laid out for reading rather than auditing.
 *
 * - Assistant text has no frame: it is the content, set at a reading size.
 * - The operator's own messages are right-aligned bubbles.
 * - Tool calls are single quiet rows that open into their input, diff or
 *   output — a run of forty calls stays scannable.
 * - Thinking is a muted, collapsed row; errors carry a red rule; system notes
 *   are a centred line.
 *
 * Markdown, diff and output rendering (syntax highlighting, hunks, long-output
 * folding) are reused from the existing transcript components; the
 * `.hq-transcript` scope in globals.css lifts their type to a readable size.
 */
import { Markdown } from '@hq/components/hq/markdown';
import { CopyButton } from '@hq/components/hq/primitives';
import { ToolDiffView } from '@hq/components/hq/transcript/diff-view';
import { useTranscriptDisclosure } from '@hq/components/hq/transcript/expansion';
import { ToolResultView } from '@hq/components/hq/transcript/tool-result';
import { hasToolDiff } from '@hq/domain/tool-diff';
import { getToolVisual } from '@hq/domain/tool-visual';
import {
  classifyTool,
  extractTodos,
  formatClock,
  formatDuration,
  prettyInput,
  summarizeToolInput,
  type TodoItem,
  toolDisplayName,
} from '@hq/domain/transcript-format';
import { isToolRunning } from '@hq/domain/transcript-store';
import type { HqTranscriptEntry } from '@wrongstack/hq';
import { Check, ChevronRight, CircleAlert, Lightbulb } from 'lucide-react';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { cn } from '@/lib/cn';
import { isFailedTool, isToolEntry, speakerLabel } from './model';

function Meta({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>;
}

const TODO_MARK: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '›',
  pending: '·',
};

function Todos({ todos }: { todos: TodoItem[] }): ReactNode {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="flex flex-col gap-1.5">
      <Meta>
        Plan · {done} of {todos.length} done
      </Meta>
      <ul className="flex flex-col gap-1 text-sm">
        {todos.map((todo, index) => (
          <li
            // Todos carry no id; position is their identity within one snapshot.
            key={`${index}-${todo.content}`}
            data-testid="todo"
            data-status={todo.status}
            className={cn(
              'flex gap-2',
              todo.status === 'completed' && 'text-muted-foreground line-through',
              todo.status === 'in_progress' && 'font-medium text-foreground',
            )}
          >
            <span className="w-3 shrink-0 text-center">{TODO_MARK[todo.status]}</span>
            {todo.content || '(empty)'}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolBody({ entry }: { entry: HqTranscriptEntry }): ReactNode {
  const diff = hasToolDiff(entry.tool, entry.toolInput);
  const todos = classifyTool(entry.tool) === 'todo' ? extractTodos(entry.toolInput) : null;
  const result = entry.text ?? '';
  const hasResult = result.trim() !== '';
  const failed = isFailedTool(entry);

  return (
    <div className="flex flex-col gap-3 pb-2 pl-7 pt-1">
      {diff ? (
        <>
          <ToolDiffView toolName={entry.tool} toolInput={entry.toolInput} />
          {hasResult && !failed && <Meta>{result.split('\n')[0]}</Meta>}
        </>
      ) : todos !== null ? (
        <Todos todos={todos} />
      ) : (
        entry.toolInput !== undefined &&
        entry.toolInput !== '{}' && (
          <div className="flex flex-col gap-1">
            <Meta>Input</Meta>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-border bg-background p-3 font-mono text-[13px] leading-relaxed">
              {prettyInput(entry.toolInput)}
            </pre>
          </div>
        )
      )}
      {!diff && hasResult && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center">
            <Meta className={cn(failed && 'text-destructive')}>{failed ? 'Error' : 'Output'}</Meta>
            <CopyButton value={result} label="Copy output" className="ml-auto" />
          </div>
          <ToolResultView toolName={entry.tool} result={result} isError={failed} />
        </div>
      )}
      {!hasResult && !failed && todos === null && !diff && <Meta>No output.</Meta>}
    </div>
  );
}

function ToolRow({
  entry,
  running,
  turnKey,
}: {
  entry: HqTranscriptEntry;
  running: boolean;
  turnKey: string | undefined;
}): ReactNode {
  const [open, toggle] = useTranscriptDisclosure(turnKey);
  const summary = summarizeToolInput(entry.tool, entry.toolInput);
  const duration = formatDuration(entry.durationMs);
  const { Icon, color } = getToolVisual(entry.tool);
  const failed = isFailedTool(entry);

  return (
    <div data-testid="transcript-turn" data-role="tool" data-tool={entry.tool} data-error={failed}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          'group flex w-full items-center gap-2.5 py-1.5 text-left text-sm',
          failed ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Icon className="size-4 shrink-0" style={{ color: failed ? undefined : color }} />
        <span className="shrink-0 font-medium text-foreground">{toolDisplayName(entry.tool)}</span>
        {summary !== '' && (
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{summary}</span>
        )}
        <span className={cn('flex shrink-0 items-center gap-2', summary === '' && 'ml-auto')}>
          {duration !== '' && <span className="tabular text-xs">{duration}</span>}
          {running ? (
            <span title="Running" className="block size-2 animate-pulse bg-primary" />
          ) : failed ? (
            <CircleAlert aria-label="Failed" className="size-4" />
          ) : (
            <Check aria-label="Done" className="size-4 text-success" />
          )}
        </span>
      </button>
      {open && <ToolBody entry={entry} />}
    </div>
  );
}

function ThinkingRow({
  entry,
  turnKey,
}: {
  entry: HqTranscriptEntry;
  turnKey: string | undefined;
}): ReactNode {
  const [open, toggle] = useTranscriptDisclosure(turnKey);
  const peek = entry.text.split('\n').find((line) => line.trim() !== '') ?? '';
  return (
    <div data-testid="transcript-turn" data-role="thinking">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2.5 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Lightbulb className="size-4 shrink-0" />
        <span className="shrink-0">Thought</span>
        {!open && <span className="min-w-0 flex-1 truncate italic">{peek}</span>}
      </button>
      {open && (
        <div className="border-l-2 border-border py-1 pl-5 text-muted-foreground">
          <Markdown text={entry.text} />
        </div>
      )}
    </div>
  );
}

export const TranscriptTurn = memo(function TranscriptTurn({
  entry,
  running,
  turnKey,
  agentNames,
}: {
  entry: HqTranscriptEntry;
  /** Session roster, so subagent turns show a name rather than an id. */
  agentNames?: ReadonlyMap<string, string>;
  /** Whether a result-less tool row should pulse (only near the tail). */
  running?: boolean;
  /** Stable row identity so disclosure state survives virtualization. */
  turnKey?: string;
}): ReactNode {
  const clock = formatClock(entry.ts);

  // A failed tool call is merged into its args entry with role `error`; it
  // still carries the tool name and input, so it renders as a failed tool row.
  if (isToolEntry(entry)) {
    return <ToolRow entry={entry} running={running ?? isToolRunning(entry)} turnKey={turnKey} />;
  }
  if (entry.role === 'thinking') return <ThinkingRow entry={entry} turnKey={turnKey} />;

  if (entry.role === 'user') {
    return (
      <div
        data-testid="transcript-turn"
        data-role="user"
        className="flex flex-col items-end gap-1 py-2"
      >
        <Meta>
          {speakerLabel(entry.agentId, 'You', agentNames)} · {clock}
        </Meta>
        <p className="max-w-[80%] whitespace-pre-wrap break-words bg-muted px-4 py-2.5 text-[15px] leading-relaxed">
          {entry.text}
        </p>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div data-testid="transcript-turn" data-role="assistant" className="flex flex-col gap-1 py-2">
        <Meta>
          {speakerLabel(entry.agentId, 'Agent', agentNames)} · {clock}
        </Meta>
        <div className="hq-prose">
          <Markdown text={entry.text} />
        </div>
      </div>
    );
  }

  if (entry.role === 'error') {
    return (
      <div
        data-testid="transcript-turn"
        data-role="error"
        className="border-l-2 border-destructive py-1.5 pl-4"
      >
        <Meta className="text-destructive">Error · {clock}</Meta>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] text-destructive">
          {entry.text}
        </pre>
      </div>
    );
  }

  // System lines carry no content worth a frame — and an empty one is noise.
  if (entry.text.trim() === '') return null;
  return (
    <p
      data-testid="transcript-turn"
      data-role="system"
      className="py-1.5 text-center text-xs text-muted-foreground"
    >
      {entry.text} · {clock}
    </p>
  );
});
