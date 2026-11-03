/**
 * WatchMessageBubble — renders a session watch entry with the same visual
 * style and level of detail as the main ChatView MessageBubble.
 *
 * Renders full tool call inputs (via ToolInputView), outputs, duration,
 * error status, and full-length markdown for user/assistant messages.
 */

import { AlertCircle, Bot, Clock, Terminal, User } from 'lucide-react';
import { useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { CopyButton } from './message/CopyButton.js';
import { ErrorBodyWithStack } from './message/ErrorBody.js';
import { ToolInputView } from './message/ToolInputView.js';

interface WatchEntry {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
  tool?: string | undefined;
  /** Structured tool input (object — rendered by ToolInputView). */
  input?: unknown | undefined;
  /** Structured tool output (rendered as full text / markdown). */
  output?: unknown | undefined;
  /** Wall-clock duration in ms. */
  durationMs?: number | undefined;
  /** Whether the tool/response had an error. */
  isError?: boolean | undefined;
  /** Tool use correlation id. */
  toolUseId?: string | undefined;
}

interface WatchMessageBubbleProps {
  entry: WatchEntry;
  isContinuation?: boolean | undefined;
}

function fmtDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const s = Math.round(durationMs / 100);
  if (s < 600) return `${(s / 10).toFixed(1)}s`;
  const m = Math.floor(s / 600);
  const sec = Math.round((s % 600) / 10);
  return `${m}m ${sec}s`;
}

const ROLE_CONFIG: Record<
  WatchEntry['role'],
  {
    Icon: typeof User;
    labelKey: string;
    avatarBg: string;
    avatarColor: string;
    avatarRing: string;
    bubbleBg: string;
    bubbleBorder: string;
    textColor: string;
  }
> = {
  user: {
    Icon: User,
    labelKey: 'activity:message.roleYou',
    avatarBg: 'bg-primary',
    avatarColor: 'text-primary-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-primary/20',
    bubbleBg: 'bg-transparent',
    bubbleBorder: 'border-primary/40',
    textColor: 'text-foreground',
  },
  assistant: {
    Icon: Bot,
    labelKey: 'activity:message.roleAssistant',
    avatarBg: 'bg-accent',
    avatarColor: 'text-accent-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-accent/20',
    bubbleBg: 'bg-card',
    bubbleBorder: 'border-border',
    textColor: 'text-foreground',
  },
  tool: {
    Icon: Terminal,
    labelKey: 'activity:message.roleTool',
    avatarBg: 'bg-secondary',
    avatarColor: 'text-secondary-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-secondary/20',
    bubbleBg: 'bg-muted/80',
    bubbleBorder: 'border-border',
    textColor: 'text-foreground',
  },
  system: {
    Icon: Bot,
    labelKey: 'activity:transcript.kindSystem',
    avatarBg: 'bg-muted',
    avatarColor: 'text-muted-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-muted/20',
    bubbleBg: 'bg-muted/50',
    bubbleBorder: 'border-border',
    textColor: 'text-muted-foreground',
  },
  error: {
    Icon: AlertCircle,
    labelKey: 'activity:transcript.kindError',
    avatarBg: 'bg-destructive',
    avatarColor: 'text-destructive-foreground',
    avatarRing: 'ring-2 ring-offset-2 ring-offset-background ring-destructive/20',
    bubbleBg: 'bg-destructive/5',
    bubbleBorder: 'border-destructive/20',
    textColor: 'text-destructive',
  },
};

function WatchBubbleContent({ entry }: { entry: WatchEntry }) {
  const { t } = useAppTranslation();
  if (entry.role === 'error') {
    return <ErrorBodyWithStack text={entry.text} />;
  }

  if (entry.role === 'tool') {
    return (
      <div className="flex flex-col gap-1.5 tool-details">
        {/* Tool name header */}
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Terminal className="h-3 w-3" />
          <span className="font-mono">{entry.tool ?? t('activity:watch.toolFallback')}</span>
          {entry.durationMs !== undefined && (
            <span className="ml-auto text-[10px] text-muted-foreground font-normal tabular-nums">
              <Clock className="h-3 w-3 inline mr-0.5 align-text-bottom" />
              {fmtDuration(entry.durationMs)}
            </span>
          )}
        </div>

        {/* Tool input — rendered with the rich ToolInputView when structured */}
        {entry.input !== undefined && entry.input !== null && (
          <div className="p-3 bg-muted/50 rounded-lg overflow-x-auto">
            <ToolInputView input={entry.input} />
          </div>
        )}

        {/* Tool output — full markdown rendering (not clipped) */}
        {entry.output !== undefined && entry.output !== null ? (
          <div className="text-sm leading-relaxed markdown-content">
            {typeof entry.output === 'string' ? (
              <Markdown text={entry.output} />
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs bg-card rounded-lg p-2 border border-border overflow-x-auto">
                {JSON.stringify(entry.output, null, 2)}
              </pre>
            )}
          </div>
        ) : entry.text ? (
          <div className="text-sm leading-relaxed markdown-content">
            <Markdown text={entry.text} />
          </div>
        ) : null}

        {/* Error banner */}
        {entry.isError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <span className="text-xs font-medium text-destructive">
              {t('activity:watch.toolFailed')}
            </span>
            {entry.text && (
              <pre className="mt-1 text-xs whitespace-pre-wrap text-destructive/80">
                {entry.text}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  }

  // User, assistant, system — full markdown rendering
  return (
    <div className="text-sm leading-relaxed markdown-content">
      <Markdown text={entry.text} />
    </div>
  );
}

export function WatchMessageBubble({ entry, isContinuation = false }: WatchMessageBubbleProps) {
  const { t } = useAppTranslation();
  const cfg = ROLE_CONFIG[entry.role];
  const Icon = cfg.Icon;

  return (
    <div className="group flex gap-3 animate-message msg-bubble rounded-lg transition-shadow">
      {/* Avatar — blank spacer for continuation */}
      {isContinuation ? (
        <div className="flex-shrink-0 w-8" />
      ) : (
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            cfg.avatarBg,
            cfg.avatarColor,
            cfg.avatarRing,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      )}

      {/* Content */}
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        {/* Role label + timestamp — only shown on first message of a chain */}
        {!isContinuation && (
          <div className="flex items-center gap-2">
            <span className={cn('text-xs font-medium', cfg.textColor)}>
              {entry.role === 'tool' && entry.tool ? entry.tool : t(cfg.labelKey)}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(entry.ts).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {/* Show duration inline for tool entries with timing */}
            {entry.role === 'tool' && entry.durationMs !== undefined && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                · {fmtDuration(entry.durationMs)}
              </span>
            )}
          </div>
        )}

        {/* Bubble */}
        <div
          className={cn(
            'rounded-2xl px-4 py-3 border',
            entry.role === 'user' && 'rounded-br-md',
            entry.role === 'assistant' && 'rounded-bl-md',
            entry.role === 'tool' && 'rounded-bl-sm',
            entry.role === 'system' && 'rounded-bl-sm opacity-70',
            entry.role === 'error' && 'rounded-bl-sm',
            cfg.bubbleBg,
            cfg.bubbleBorder,
          )}
        >
          <div className={cn('text-sm leading-relaxed markdown-content', cfg.textColor)}>
            <WatchBubbleContent entry={entry} />
          </div>
        </div>

        {/* Copy button — group-hover for hover visibility */}
        {entry.text && entry.role !== 'error' && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={entry.text} label={t('common:action.copy')} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The host's markdown renderer, or the plain text when the host has none. */
function Markdown({ text }: { text: string }) {
  const Render = useSurfaceHost().Markdown;
  if (Render) return <Render>{text}</Render>;
  return <p className="whitespace-pre-wrap">{text}</p>;
}
