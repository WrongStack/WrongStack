import type { ChatMessage } from './engine-state';

/** The conversation as Markdown, in the WebUI export's layout: one section per message. */
export function transcriptMarkdown(
  title: string,
  messages: readonly ChatMessage[],
  exportedAt: string,
): string {
  const lines = [`# ${title} — chat export`, `*Exported: ${exportedAt}*`, ''];
  for (const message of messages) {
    lines.push(message.role === 'user' ? '## 👤 User' : '## 🤖 Assistant', '', message.text);
    const files = message.attachments?.length ?? 0;
    if (files) lines.push('', `_${files} attachment${files === 1 ? '' : 's'} not included._`);
    lines.push('');
  }
  return lines.join('\n');
}

const folderName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? '';

/** The heading of an exported conversation: the project folder's name. */
export const transcriptTitle = (projectRoot: string) => folderName(projectRoot) || 'Conversation';

/** `name-chat-2026-11-04-10-30-00.md`: the folder name and the export time, safe for any disk. */
export function transcriptFileName(projectRoot: string, exportedAt: string): string {
  const folder = folderName(projectRoot);
  const name = folder.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'conversation';
  const stamp = exportedAt.slice(0, 19).replace(/[:T]/g, '-');
  return `${name}-chat-${stamp}.md`;
}
