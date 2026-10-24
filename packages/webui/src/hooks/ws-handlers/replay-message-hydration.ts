import type {
  Message,
  SessionMarker,
  SessionTimelineImage,
  SessionToolMeta,
} from '@wrongstack/contracts/types';
import { projectSessionTimeline } from '@wrongstack/contracts/types/session-timeline';
import { autoWakeNoticeText } from '@wrongstack/webui-protocol';
import { parseBugHuntMessage } from '@/lib/bug-hunt-message';
import { parsePerfRunMessage } from '@/lib/perf-run-message';
import type { ChatMessage, ChatMessageAttachment } from '@/stores';

export interface ReplayMessage {
  role: string | undefined;
  content: unknown;
  ts?: string | undefined;
}

export function replayTimestamp(ts: string | undefined): number {
  if (typeof ts !== 'string') return Date.now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function replayMessageId(index: number): string {
  return `replay_${Date.now()}_${index}`;
}

/**
 * Rebuild a lane's chat from a replayed session.
 *
 * Ordering, tool pairing and visibility come from core's
 * {@link projectSessionTimeline} — the same function the TUI, SimpleUI and HQ
 * project through — so a resumed session cannot read differently here than it
 * does there. Everything below the projection is WebUI presentation: which
 * `ChatMessage` shape a timeline entry becomes.
 *
 * `thinkingPlacement: 'merged-after'` is not a style choice. Live, the thinking
 * bubble is transient and the archived log is only committed when the
 * iteration completes — i.e. AFTER the prose and tool cards are already on
 * screen. Replaying it inline would put the log somewhere it never appeared.
 */
export function hydrateReplayMessages(
  replay: ReplayMessage[],
  markers: readonly SessionMarker[] = [],
  toolMeta: readonly SessionToolMeta[] = [],
): ChatMessage[] {
  const conversation = (Array.isArray(replay) ? replay : []).filter(
    (m): m is ReplayMessage & { role: 'user' | 'assistant' | 'system' } =>
      Boolean(
        m &&
          typeof m === 'object' &&
          typeof (m as { role?: unknown }).role === 'string' &&
          (m.role === 'user' || m.role === 'assistant' || m.role === 'system'),
      ),
  ) as unknown as Message[];

  const timeline = projectSessionTimeline({
    messages: conversation,
    markers: markers.filter((marker) => !isSubagentResumeMarker(marker.source)),
    toolMeta,
    thinkingPlacement: 'merged-after',
  });

  const messages: ChatMessage[] = [];
  for (const item of timeline) {
    const timestamp = replayTimestamp(item.ts);
    const id = replayMessageId(messages.length);
    switch (item.kind) {
      case 'user': {
        // A woken turn's `[AUTO-WAKE]` input is runtime text, not something
        // the user typed: replay it as the same system line the live stream
        // showed, never as a user bubble.
        const autoWake = autoWakeNoticeText(item.text);
        if (autoWake !== undefined) {
          messages.push({ id, role: 'system', content: autoWake, timestamp });
          break;
        }
        const bugHunt = parseBugHuntMessage(item.text);
        const perfRun = parsePerfRunMessage(item.text);
        messages.push({
          id,
          role: 'user',
          content: item.text,
          timestamp,
          ...(bugHunt ? { bugHunt } : {}),
          ...(perfRun ? { perfRun } : {}),
          ...(item.images ? { attachments: replayAttachments(item.images, id) } : {}),
        });
        break;
      }
      case 'assistant':
        messages.push({ id, role: 'assistant', content: item.text, timestamp });
        break;
      case 'system':
        messages.push({ id, role: 'system', content: item.text, timestamp });
        break;
      case 'thinking':
        messages.push({
          id,
          role: 'system',
          content: '',
          timestamp,
          thinkingLog: {
            iteration: item.index,
            text: item.text,
            startedAt: timestamp,
            durationMs: 0,
            replayed: true,
          },
        });
        break;
      case 'tool':
        messages.push({
          id,
          role: 'tool',
          content: '',
          toolName: item.name,
          toolInput: item.input,
          toolUseId: item.toolUseId,
          timestamp,
          ...(item.output !== undefined ? { toolResult: item.output } : {}),
          // `!ok`, matching what `setToolResult` writes live — but only once
          // the journal actually resolved the call. An unfinished call keeps
          // `isError` absent, exactly as a live tool card does while it runs.
          ...(item.ok !== undefined ? { isError: !item.ok } : {}),
          ...(item.durationMs !== undefined ? { toolDurationMs: item.durationMs } : {}),
          ...(item.outputBytes !== undefined ? { toolOutputBytes: item.outputBytes } : {}),
          ...(item.outputTokens !== undefined ? { toolOutputTokens: item.outputTokens } : {}),
          ...(item.outputLines !== undefined ? { toolOutputLines: item.outputLines } : {}),
        });
        break;
      case 'marker': {
        messages.push({
          id,
          role: 'system',
          content: item.text,
          timestamp,
          isError: item.level === 'error' ? true : undefined,
        });
        break;
      }
      default: {
        const _exhaustive: never = item;
        void _exhaustive;
      }
    }
  }

  return messages;
}

const SUBAGENT_RESUME_MARKER_SOURCES = new Set<string>([
  'agent_spawned',
  'agent_session_linked',
  'agent_stopped',
  'agent_error',
  'delegate_started',
  'delegate_completed',
]);

function isSubagentResumeMarker(source: string): boolean {
  return SUBAGENT_RESUME_MARKER_SOURCES.has(source);
}

/**
 * Rebuild the attachment chips of a replayed prompt.
 *
 * The journal keeps the image the model saw, so the chip can show a real
 * thumbnail again instead of the empty placeholder a reload used to leave —
 * these blocks were dropped entirely by the old replay walk.
 */
function replayAttachments(
  images: readonly SessionTimelineImage[],
  messageId: string,
): ChatMessageAttachment[] {
  return images.map((image, index) => {
    const mediaType = image.mediaType ?? 'image/png';
    const dataUrl = image.data ? `data:${mediaType};base64,${image.data}` : image.url;
    return {
      id: `${messageId}_img_${index}`,
      kind: 'image' as const,
      mediaType,
      // Base64 expands 3 bytes into 4 characters; close enough for a size chip.
      bytes: image.data ? Math.floor((image.data.length * 3) / 4) : 0,
      ...(dataUrl ? { dataUrl } : {}),
      // A PDF comes back as a name chip: the journal keeps the file, the
      // timeline does not ship it.
      ...(image.name ? { name: image.name } : {}),
    };
  });
}
