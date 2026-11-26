/**
 * A leader turn's prompt: the request's content as the prompt blocks the agent
 * takes — every waiting user message's attachments, and for an agent joining a
 * conversation under way the recent images of the turns before.
 */
import type { ACPSession } from '@wrongstack/acp';
import type { Request } from '@wrongstack/contracts/types';
import { documentAsText, ProviderError } from '@wrongstack/contracts/types';
import {
  base64DecodedBytes,
  MAX_INCOMING_IMAGE_BYTES,
  MAX_INCOMING_IMAGES,
} from '@wrongstack/core/utils';
import { assertSafeVisionUrl } from '../vision.js';
import type { AcpModule, LeaderSession } from './acp-leader-session.js';
import { pendingUserMessages } from './acp-leader-stream.js';

type PromptBlocks = Parameters<ACPSession['prompt']>[0];

export function nativeCommandText(messages: Request['messages']): string {
  const content = pendingUserMessages(messages).at(-1)?.content;
  if (typeof content === 'string') return content.trim();
  if (!content?.every((block) => block.type === 'text')) return '';
  return content
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

/** Fit handoff images in the existing incoming-image budget after the active turn's attachments. */
function recentHistoryImages(
  acp: AcpModule,
  messages: Request['messages'],
  attachments: PromptBlocks,
): PromptBlocks {
  const images: PromptBlocks = [];
  let remainingImages = MAX_INCOMING_IMAGES;
  let remainingBytes = MAX_INCOMING_IMAGE_BYTES;
  for (const block of attachments) {
    if (block.type === 'image') {
      remainingImages--;
      remainingBytes -= base64DecodedBytes(block.data);
    } else if (block.type === 'resource' && 'blob' in block.resource) {
      remainingBytes -= base64DecodedBytes(block.resource.blob);
    }
  }

  const lastReply = messages.findLastIndex((message) => message.role === 'assistant');
  for (let i = lastReply - 1; i >= 0 && remainingImages > 0 && remainingBytes > 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0 && remainingImages > 0; j--) {
      const block = message.content[j];
      if (block?.type !== 'image' || block.source.type !== 'base64' || !block.source.data?.trim())
        continue;
      const bytes = base64DecodedBytes(block.source.data);
      if (bytes > remainingBytes) continue;
      images.push(acp.imageContent(block.source.media_type ?? 'image/png', block.source.data));
      remainingImages--;
      remainingBytes -= bytes;
    }
  }
  return images.reverse();
}

/**
 * Preserve attachments across every user message waiting for this turn.
 * Fresh external sessions also receive recent images from the handoff history.
 *
 * `text` is the turn's prompt. It is read last, where the provider produced it
 * before: it consumes the notes it carries, which must not be lost when an
 * attachment turns out to be unusable.
 */
export async function promptBlocks(
  acp: AcpModule,
  leader: Pick<LeaderSession, 'agentId' | 'joined' | 'session'>,
  req: Request,
  text: () => string,
  providerId: string,
): Promise<PromptBlocks> {
  type PromptBlock = PromptBlocks[number];
  const attachments: PromptBlock[] = [];
  const promptCaps = leader.session.getCapabilities?.().promptCapabilities;
  for (const message of pendingUserMessages(req.messages)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image') {
        const { source } = block;
        if (source.type === 'url') {
          await assertSafeVisionUrl(source.url);
          attachments.push({
            type: 'resource_link',
            uri: source.url!,
            name: 'Image',
            ...(source.media_type ? { mimeType: source.media_type } : {}),
          });
          continue;
        }
        if (promptCaps?.image !== true || !source.data?.trim()) {
          throw new ProviderError(
            promptCaps?.image !== true
              ? `ACP agent '${leader.agentId}' does not support image prompt content.`
              : 'ACP image attachment has no image data.',
            400,
            false,
            providerId,
            { kind: 'invalid_request' },
          );
        }
        attachments.push(acp.imageContent(source.media_type ?? 'image/png', source.data));
      } else if (block.type === 'document') {
        if (promptCaps?.embeddedContext) {
          attachments.push({
            type: 'resource',
            resource: {
              uri: `file:///${encodeURIComponent(block.name ?? 'document.pdf')}`,
              mimeType: block.source.media_type,
              blob: block.source.data,
            },
          });
        } else {
          attachments.push(acp.textContent(documentAsText(block).text));
        }
      }
    }
  }

  const prior =
    !leader.joined && promptCaps?.image === true
      ? recentHistoryImages(acp, req.messages, attachments)
      : [];
  return [
    acp.textContent(text()),
    ...(prior.length
      ? [acp.textContent('Recent images from the earlier conversation, in order.'), ...prior]
      : []),
    ...attachments,
  ];
}
