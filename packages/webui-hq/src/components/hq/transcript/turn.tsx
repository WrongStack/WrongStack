/**
 * One transcript entry, rendered.
 *
 * Five shapes: a user bubble, an assistant bubble (full GFM markdown), a
 * collapsed thinking card, a collapsible tool card with a real result view,
 * and a subtle system / error line. Tool cards are collapsed by default —
 * an expanded transcript of forty tool calls is unreadable, and the header
 * line (icon, name, argument summary, duration, status) is usually enough.
 */
import type { HqTranscriptEntry } from '@wrongstack/core/hq';
import { BrainCircuit, ChevronDown, ChevronRight, CircleCheck, CircleX } from 'lucide-react';
import type * as React from 'react';
import { memo } from 'react';
import { hasToolDiff } from '../../../domain/tool-diff.js';
import { getToolVisual } from '../../../domain/tool-visual.js';
import {
  classifyTool,
  extractTodos,
  formatClock,
  formatDuration,
  prettyInput,
  summarizeToolInput,
  type TodoItem,
  toolDisplayName,
} from '../../../domain/transcript-format.js';
import { isToolRunning } from '../../../domain/transcript-store.js';
import { cn } from '../../../lib/utils.js';
import { Markdown } from '../markdown.js';
import { CopyButton } from '../primitives.js';
import { ToolDiffView } from './diff-view.js';
import { useTranscriptDisclosure } from './expansion.js';
import { ToolResultView } from './tool-result.js';

const TODO_MARK: Record<TodoItem['status'], string> = {
  completed: '✔',
  in_progress: '▶',
  pending: '○',
};

const TODO_CLASS: Record<TodoItem['status'], string> = {
  completed: 'text-muted-foreground line-through',
  in_progress: 'text-primary',
  pending: 'text-foreground',
};

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
      {children}
    </span>
  );
}

function TodoList({ todos }: { todos: TodoItem[] }): React.ReactElement {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="space-y-1">
      <SectionLabel>
        todos · {done}/{todos.length} done
      </SectionLabel>
      <ul className="space-y-0.5">
        {todos.map((todo, index) => (
          <li
            // Todos carry no id; position is their identity within one snapshot.
            key={`${todo.status}-${index}-${todo.content}`}
            data-testid="todo"
            data-status={todo.status}
            className={cn('flex gap-1.5 text-[11px]', TODO_CLASS[todo.status])}
          >
            <span className="w-3 shrink-0 select-none">{TODO_MARK[todo.status]}</span>
            <span>{todo.content || '(empty)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolBody({ entry }: { entry: HqTranscriptEntry }): React.ReactElement {
  const kind = classifyTool(entry.tool);
  const diff = hasToolDiff(entry.tool, entry.toolInput);
  const todos = kind === 'todo' ? extractTodos(entry.toolInput) : null;
  const result = entry.text ?? '';
  const hasResult = result.trim() !== '';

  return (
    <div data-testid="tool-body" className="space-y-2 border-t border-border p-2">
      {diff ? (
        <div className="space-y-1">
          <SectionLabel>changes</SectionLabel>
          <ToolDiffView toolName={entry.tool} toolInput={entry.toolInput} />
          {hasResult && entry.isError !== true && (
            // A successful edit's result is a one-line confirmation; the diff
            // above is the real content, so only the first line is worth space.
            <p className="text-[11px] text-muted-foreground">{result.split('\n')[0]}</p>
          )}
        </div>
      ) : todos !== null ? (
        <TodoList todos={todos} />
      ) : (
        entry.toolInput !== undefined &&
        entry.toolInput !== '{}' && (
          <div className="space-y-1">
            <SectionLabel>input</SectionLabel>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
              {prettyInput(entry.toolInput)}
            </pre>
          </div>
        )
      )}

      {!diff && hasResult && (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <SectionLabel>{entry.isError === true ? 'error' : 'output'}</SectionLabel>
            <CopyButton value={result} label="Copy output" className="ml-auto" />
          </div>
          <ToolResultView toolName={entry.tool} result={result} isError={entry.isError} />
        </div>
      )}

      {!hasResult && entry.isError !== true && todos === null && !diff && (
        <p className="text-[11px] text-muted-foreground">(no output)</p>
      )}
    </div>
  );
}

function ToolTurn({
  entry,
  running,
  turnKey,
}: {
  entry: HqTranscriptEntry;
  running: boolean;
  turnKey?: string;
}): React.ReactElement {
  const [open, toggleOpen] = useTranscriptDisclosure(turnKey);
  const summary = summarizeToolInput(entry.tool, entry.toolInput);
  const duration = formatDuration(entry.durationMs);
  const { Icon, color } = getToolVisual(entry.tool);

  return (
    <div
      data-testid="transcript-turn"
      data-role="tool"
      data-error={entry.isError === true}
      className={cn(
        'border bg-card',
        entry.isError === true ? 'border-destructive/40' : 'border-border',
      )}
    >
      <button
        type="button"
        data-testid="tool-head"
        aria-expanded={open}
        onClick={toggleOpen}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <Icon className="size-3.5 shrink-0" style={{ color }} />
        <span data-testid="tool-name" className="shrink-0 text-xs font-medium">
          {toolDisplayName(entry.tool)}
        </span>
        {summary !== '' && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        {duration !== '' && (
          <span
            data-testid="tool-duration"
            className="tabular ml-auto shrink-0 text-[10px] text-muted-foreground"
          >
            {duration}
          </span>
        )}
        <span className={cn('shrink-0', summary === '' && duration === '' && 'ml-auto')}>
          {running ? (
            <span
              data-testid="tool-running"
              title="running"
              className="block size-2 animate-pulse bg-primary"
            />
          ) : entry.isError === true ? (
            <CircleX data-testid="tool-status-error" className="size-3.5 text-destructive" />
          ) : (
            <CircleCheck data-testid="tool-status-ok" className="size-3.5 text-success" />
          )}
        </span>
      </button>
      {open && <ToolBody entry={entry} />}
    </div>
  );
}

function ThinkingTurn({
  entry,
  turnKey,
}: {
  entry: HqTranscriptEntry;
  turnKey?: string;
}): React.ReactElement {
  const [open, toggleOpen] = useTranscriptDisclosure(turnKey);
  const firstLine = entry.text.split('\n')[0] ?? '';
  return (
    <div
      data-testid="transcript-turn"
      data-role="thinking"
      className="border border-dashed border-border/70"
    >
      <button
        type="button"
        data-testid="thinking-head"
        aria-expanded={open}
        onClick={toggleOpen}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <BrainCircuit className="size-3" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em]">thinking</span>
        {!open && (
          <span data-testid="thinking-peek" className="min-w-0 flex-1 truncate text-[11px] italic">
            {firstLine}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="thinking-body"
          className="border-t border-border/70 px-2 py-1.5 opacity-80"
        >
          <Markdown text={entry.text} />
        </div>
      )}
    </div>
  );
}

function RoleLine({
  who,
  agentId,
  clock,
  tone,
}: {
  who: string;
  agentId?: string | undefined;
  clock: string;
  tone?: 'error';
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5 pb-0.5">
      <span
        className={cn(
          'text-[10px] font-semibold uppercase tracking-[0.09em]',
          tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {who}
        {agentId !== undefined ? ` · ${agentId}` : ''}
      </span>
      {clock !== '' && (
        <span data-testid="turn-clock" className="tabular text-[10px] text-muted-foreground/70">
          {clock}
        </span>
      )}
    </div>
  );
}

export const TranscriptTurn = memo(function TranscriptTurn({
  entry,
  running,
  turnKey,
}: {
  entry: HqTranscriptEntry;
  /**
   * Stable identity for this row, so its expanded/collapsed state survives the
   * virtualized list unmounting it. Omitted when a turn is rendered standalone.
   */
  turnKey?: string;
  /**
   * Whether a result-less tool card should pulse. Callers that know the
   * entry's position pass `isToolRunning(entry) && nearTail`, so an old call
   * that never recorded a result does not pulse forever; standalone rendering
   * falls back to the shape check alone.
   */
  running?: boolean;
}): React.ReactElement | null {
  const clock = formatClock(entry.ts);

  // A failed tool call is merged into its args entry with role 'error' — it
  // still carries the tool name and input, so it renders as an errored tool
  // card rather than a bare error bubble.
  if (entry.role === 'tool' || (entry.role === 'error' && entry.toolInput !== undefined)) {
    return <ToolTurn entry={entry} running={running ?? isToolRunning(entry)} turnKey={turnKey} />;
  }

  if (entry.role === 'thinking') return <ThinkingTurn entry={entry} turnKey={turnKey} />;

  if (entry.role === 'user') {
    return (
      <div data-testid="transcript-turn" data-role="user" className="flex justify-end">
        <div className="max-w-[85%] border border-primary/35 bg-primary/10 px-2.5 py-1.5">
          <RoleLine who="you" agentId={entry.agentId} clock={clock} />
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
            {entry.text}
          </p>
        </div>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div data-testid="transcript-turn" data-role="assistant">
        <div className="border border-border bg-card px-2.5 py-1.5">
          <RoleLine who="agent" agentId={entry.agentId} clock={clock} />
          <Markdown text={entry.text} />
        </div>
      </div>
    );
  }

  if (entry.role === 'error') {
    return (
      <div data-testid="transcript-turn" data-role="error">
        <div className="border border-destructive/40 bg-destructive/5 px-2.5 py-1.5">
          <RoleLine who="error" clock={clock} tone="error" />
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
            {entry.text}
          </pre>
        </div>
      </div>
    );
  }

  // System lines carry no content worth a frame — and an empty one is noise.
  if (entry.text.trim() === '') return null;
  return (
    <div
      data-testid="transcript-turn"
      data-role="system"
      className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
    >
      <span>{entry.text}</span>
      {clock !== '' && <span className="tabular text-[10px] opacity-70">{clock}</span>}
    </div>
  );
});
