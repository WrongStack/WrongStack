import { formatMessageTime } from './chat-model.js';
import type { ChatMessage } from '../types.js';

export interface TranscriptMeta {
  /** Session/project title shown in the header line. */
  title?: string | undefined;
}

const ROLE_LABEL: Partial<Record<ChatMessage['role'], string>> = {
  user: 'YOU',
  assistant: 'WRONGSTACK',
  system: 'SYSTEM',
};

/**
 * Render the conversation as shareable markdown. Thinking blocks are always
 * skipped — the transcript is meant for sharing, and model reasoning must not
 * leak just because the user had it visible in the chat.
 */
export function buildTranscriptMarkdown(
  messages: readonly ChatMessage[],
  meta: TranscriptMeta = {},
): string {
  const header: string[] = [];
  if (meta.title) header.push(meta.title);
  header.push(`exported ${new Date().toISOString()}`);
  const lines: string[] = ['# WrongStack transcript', `_${header.join(' — ')}_`, ''];
  for (const message of messages) {
    if (message.role === 'thinking') continue;
    const label = ROLE_LABEL[message.role] ?? 'SYSTEM';
    const time = formatMessageTime(message.ts);
    const text = message.text.trim();
    lines.push(`**${label}**${time ? ` (${time})` : ''}`, '', text || '_(empty)_', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
