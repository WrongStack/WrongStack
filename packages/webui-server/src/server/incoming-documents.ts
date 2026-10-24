import type { ContentBlock } from '@wrongstack/contracts/types';
import { IncomingImageError, type IncomingPdf } from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { preparePdfAttachment } from '@wrongstack/tools';

/**
 * The prompt blocks for the PDFs of a `user_message`: a document block each
 * (the file for models that take PDFs, its text for the rest), or the first
 * pages' text when one is over the attach caps. A file that does not parse is
 * refused like a bad image, with a message the composer can show.
 */
export async function pdfPromptBlocks(pdfs: readonly IncomingPdf[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const pdf of pdfs) {
    let prepared: Awaited<ReturnType<typeof preparePdfAttachment>>;
    try {
      prepared = await preparePdfAttachment(Buffer.from(pdf.data, 'base64'), pdf.name);
    } catch (err) {
      throw new IncomingImageError(`PDF "${pdf.name}" could not be read: ${toErrorMessage(err)}`);
    }
    blocks.push(
      prepared.kind === 'document' ? prepared.block : { type: 'text', text: prepared.text },
    );
  }
  return blocks;
}
