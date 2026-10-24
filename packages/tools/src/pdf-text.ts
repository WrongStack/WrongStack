/**
 * PDF text extraction for `read` and for PDF attachments sent to models that
 * take no PDF input. unpdf (pdf.js built for serverless use) is loaded on
 * first use, so sessions that never open a PDF never load it.
 */

import type { DocumentBlock } from '@wrongstack/contracts/types';

/** Pages one call returns at most; a longer document is read in ranges. */
export const PDF_MAX_PAGES_PER_READ = 20;

/** PDFs are usually larger than source files; this is their own read cap. */
export const PDF_MAX_BYTES = 32 * 1024 * 1024;

export function isPdf(path: string, head: Uint8Array): boolean {
  if (/\.pdf$/i.test(path)) return true;
  // `%PDF-` magic, for a PDF saved without its extension.
  return (
    head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d
  );
}

export interface PdfPageRange {
  first: number;
  last: number;
}

/**
 * Parse `pages` ("3", "1-5", "4-") against a document of `total` pages.
 * Throws with a message fit for the model on a malformed or empty range.
 */
export function parsePdfPageRange(spec: string | undefined, total: number): PdfPageRange {
  if (spec === undefined || spec.trim() === '') {
    return { first: 1, last: Math.min(total, PDF_MAX_PAGES_PER_READ) };
  }
  const match = /^\s*(\d+)\s*(?:(-)\s*(\d*)\s*)?$/.exec(spec);
  if (!match) throw new Error(`pages must look like "3" or "1-5", got "${spec}"`);
  const first = Number(match[1]);
  const last = match[2] ? (match[3] ? Number(match[3]) : total) : first;
  if (first < 1 || last < first) throw new Error(`pages "${spec}" is not a valid range`);
  if (first > total) throw new Error(`pages "${spec}" starts past the last page (${total})`);
  if (last - first + 1 > PDF_MAX_PAGES_PER_READ) {
    throw new Error(
      `pages "${spec}" spans ${last - first + 1} pages; read at most ${PDF_MAX_PAGES_PER_READ} per call`,
    );
  }
  return { first, last: Math.min(last, total) };
}

export interface PdfText {
  totalPages: number;
  /** The requested pages, in order. */
  pages: { page: number; text: string }[];
}

/**
 * Text of the pages `range` picks (every page when omitted). Only those pages
 * are parsed: reading pages 1-5 of a 500-page manual must not extract 500.
 */
export async function extractPdfText(
  data: Uint8Array,
  range?: (total: number) => PdfPageRange,
): Promise<PdfText> {
  const { getDocumentProxy } = await import('unpdf');
  // pdf.js takes ownership of the buffer it is given; hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const totalPages = pdf.numPages;
    const { first, last } = range ? range(totalPages) : { first: 1, last: totalPages };
    const pages: PdfText['pages'] = [];
    for (let page = first; page <= last; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      // Joined the way unpdf's own extractText joins a page.
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      pages.push({ page, text: text.trim() });
    }
    return { totalPages, pages };
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

/** The pages as one text, with a marker line before each page. */
export function formatPdfPages(pages: PdfText['pages']): string {
  return pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join('\n\n');
}

/**
 * Attach caps. Providers that take PDFs refuse past roughly 100 pages or
 * 32 MB, and the WebUI ships the file inside one WebSocket frame; past either
 * cap the model gets the first pages' text instead of the file.
 */
export const PDF_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const PDF_ATTACH_MAX_PAGES = 100;

export type PreparedPdf =
  | { kind: 'document'; block: DocumentBlock }
  /** Over a cap: the text of the first pages, with a note saying so. */
  | { kind: 'text'; text: string; pages: number };

/**
 * A PDF ready to put in a prompt: a document block (the file plus its text,
 * for models without PDF input) when it fits the attach caps, the first
 * pages' text otherwise. Throws when the file is not a readable PDF.
 */
export async function preparePdfAttachment(bytes: Uint8Array, name: string): Promise<PreparedPdf> {
  const fits = bytes.byteLength <= PDF_ATTACH_MAX_BYTES;
  const extracted = await extractPdfText(bytes, (total) =>
    fits && total <= PDF_ATTACH_MAX_PAGES
      ? { first: 1, last: total }
      : { first: 1, last: Math.min(total, PDF_MAX_PAGES_PER_READ) },
  );
  const text = formatPdfPages(extracted.pages);
  const total = extracted.totalPages;
  if (fits && total <= PDF_ATTACH_MAX_PAGES) {
    return {
      kind: 'document',
      block: {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from(bytes).toString('base64'),
        },
        name,
        text,
        pages: total,
      },
    };
  }
  const shown = extracted.pages.length;
  const why = fits
    ? `${total} pages is over the ${PDF_ATTACH_MAX_PAGES}-page attach limit`
    : `${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB is over the ${PDF_ATTACH_MAX_BYTES / (1024 * 1024)} MB attach limit`;
  const note =
    shown < total
      ? `Only the text of pages 1-${shown} of ${total} is attached (${why}). If the file is in the project, read further pages with the read tool's \`pages\` field.`
      : `Only the text is attached (${why}).`;
  return {
    kind: 'text',
    pages: total,
    text: `<attached-pdf name="${name}, ${total} page${total === 1 ? '' : 's'}">\n${note}\n\n${text}\n</attached-pdf>`,
  };
}
