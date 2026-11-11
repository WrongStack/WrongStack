import { GitBranch } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { MessageBubble } from '../MessageBubble';
import { ToolGroup } from '../ToolGroup';
import { BrainDecisionCard, parseBrainMarkdown } from './BrainDecisionCard';
import { ChimeraReportCard } from './ChimeraReportCard';
import { CouncilDecisionCard, parseCouncilMarkdown } from './CouncilDecisionCard';
import type { ChatRow } from './utils.js';

export const ChatRowView = memo(function ChatRowView({
  row,
  isLoading,
  compactMode,
  isFirstRow,
  groupToolCalls,
  sessionId,
  readOnly = false,
  promptIndex,
  onBranchFromPrompt,
}: {
  row: ChatRow;
  isLoading: boolean;
  compactMode: boolean;
  isFirstRow: boolean;
  groupToolCalls: boolean;
  /** The lane this row belongs to — ChatView only renders the active lane. */
  sessionId: string;
  /** Observation-only rendering (the subagent tabs) — see MessageBubble. */
  readOnly?: boolean | undefined;
  /** 0-based user prompt turn index for `/tree branch --at <N>`. */
  promptIndex?: number | undefined;
  onBranchFromPrompt?: ((promptIndex: number) => void) | undefined;
}) {
  const wrap = cn(
    'mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6',
    isFirstRow && 'pt-4',
    compactMode ? 'pb-3' : 'pb-6',
  );
  if (row.kind === 'day') {
    return (
      <div className={wrap}>
        <div className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70 uppercase tracking-wider font-medium">
          <div className="flex-1 h-px bg-border/50" />
          <span>{row.label}</span>
          <div className="flex-1 h-px bg-border/50" />
        </div>
      </div>
    );
  }
  if (row.kind === 'user') {
    return (
      <div className={cn(wrap, 'group/user-turn')}>
        <MessageBubble message={row.message} isFirst />
        {!readOnly && promptIndex !== undefined && onBranchFromPrompt ? (
          <div className="mt-1 flex justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover/user-turn:opacity-100">
            <button
              type="button"
              disabled={isLoading}
              data-testid={`branch-from-prompt-${promptIndex}`}
              title={`Fork a new session branch from prompt #${promptIndex}`}
              onClick={() => onBranchFromPrompt(promptIndex)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <GitBranch className="h-3 w-3" />
              <span>Branch from here</span>
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={wrap}>
      <div className={cn('chat-turn', compactMode ? 'space-y-1' : 'space-y-1.5')}>
        {row.items.flatMap((it) => {
          if (it.kind === 'msg') {
            if (it.message.chimeraReport) {
              return [
                <ChimeraReportCard key={it.key} message={it.message} sessionId={sessionId} />,
              ];
            }
            if (it.message.councilDecision || parseCouncilMarkdown(it.message.content)) {
              return [<CouncilDecisionCard key={it.key} message={it.message} />];
            }
            if (it.message.brainDecision || parseBrainMarkdown(it.message.content)) {
              return [<BrainDecisionCard key={it.key} message={it.message} />];
            }
            return [
              <MessageBubble
                key={it.key}
                message={it.message}
                isFirst={it.isFirst}
                isContinuation={it.isContinuation}
                readOnly={readOnly}
              />,
            ];
          }
          if (groupToolCalls) {
            const defaultOpen = row.isLastTurn && it.isLastGroup && isLoading && it.hasRunningTool;
            return [
              <ToolGroup
                key={it.key}
                tools={it.tools}
                defaultOpen={defaultOpen}
                isContinuation={it.isContinuation}
                readOnly={readOnly}
              />,
            ];
          }
          return it.tools.map((tool) => (
            <MessageBubble
              key={tool.id}
              message={tool}
              isFirst={false}
              isContinuation={it.isContinuation}
              readOnly={readOnly}
            />
          ));
        })}
      </div>
    </div>
  );
});
