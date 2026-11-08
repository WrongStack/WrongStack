/**
 * The input of one conversation turn: attachments, PDFs and images routed for
 * the model, and the run options a host loop passes to a runtime turn. Split
 * out of conversation-operations.ts.
 */
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { ContentBlock } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import {
  buildUserContentBlocks,
  type IncomingImagePayload,
  mergeCustomModelDefs,
  parseIncomingAttachments,
  providerIdentities,
} from '@wrongstack/core/utils';
import { capabilitiesFor, catalogProviderIdFor } from '@wrongstack/providers';
import { createToolVisionAdapters, routeImagesForModel } from '@wrongstack/runtime/vision';
import { pdfPromptBlocks } from './incoming-documents.js';

/** Run options a host loop passes to `runRuntimeTurn`. */
export interface RuntimeTurnOptions {
  signal?: AbortSignal | undefined;
  /** Let the agent chain `[continue]` cycles inside the one run. */
  autonomousContinue?: boolean | undefined;
  /** The run's iteration cap; replaces the session's own ceiling. */
  maxIterations?: number | undefined;
  /** `run.result.origin` for this turn (default `auto_wake`). */
  resultOrigin?: string | undefined;
}

export interface TurnPayload {
  journalRaw?: string;
  id?: unknown;
  content?: unknown;
  freshContext?: unknown;
  images?: IncomingImagePayload[] | undefined;
  imageBase64?: string | undefined;
  /** The turn's content, already built (a queued prompt); replaces `content` and `images`. */
  blocks?: ContentBlock[] | undefined;
}

/**
 * Build the turn's input from its payload. Text stays a string unless PDFs or
 * pre-built blocks make it a block list; images are routed for the model
 * (described by a vision tool when the model cannot see them).
 */
export async function buildTurnInput(
  agent: Agent,
  payload: TurnPayload,
  signal: AbortSignal,
): Promise<string | ContentBlock[]> {
  const content = typeof payload.content === 'string' ? payload.content : '';
  let input: string | ContentBlock[] = content;
  const attached = payload.blocks
    ? { images: [], pdfs: [] }
    : parseIncomingAttachments(payload.images, payload.imageBase64);
  // PDFs lead, then images, then the text; the provider runner decides
  // per model whether a PDF travels as the file or as its text.
  const blocks = payload.blocks ?? [
    ...(await pdfPromptBlocks(attached.pdfs)),
    ...buildUserContentBlocks(content, attached.images),
  ];
  if (attached.pdfs.length > 0 || payload.blocks) input = blocks;
  if (blocks.some((block) => block.type === 'image')) {
    let supportsVision = Boolean(agent.ctx.provider.capabilities.vision);
    if (!supportsVision && agent.container?.has(TOKENS.ModelsRegistry)) {
      try {
        const registry = agent.container.resolve(TOKENS.ModelsRegistry);
        const cfg = agent.container.has(TOKENS.ConfigStore)
          ? agent.container.resolve(TOKENS.ConfigStore).get()
          : undefined;
        const providerCfg = cfg?.providers?.[agent.ctx.provider.id];
        const boundCatalogId = providerIdentities(agent.ctx.provider)[1];
        const caps = await capabilitiesFor(
          registry,
          agent.ctx.provider.id,
          agent.ctx.model,
          mergeCustomModelDefs(providerCfg?.customModels, cfg?.models),
          {
            catalogProviderId: catalogProviderIdFor(
              agent.ctx.provider.id,
              boundCatalogId ?? providerCfg?.type,
            ),
          },
        );
        supportsVision = Boolean(caps.vision);
        if (supportsVision) {
          Object.defineProperty(agent.ctx.provider, 'capabilities', {
            value: { ...agent.ctx.provider.capabilities, vision: true, pdf: caps.pdf },
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
      } catch {
        /* keep provider baseline on lookup failure */
      }
    }
    const routed = await routeImagesForModel(blocks, {
      supportsVision,
      adapters: () => createToolVisionAdapters(agent.tools),
      ctx: agent.ctx,
      signal,
      providerId: agent.ctx.provider.id,
      model: agent.ctx.model,
    });
    input = routed.blocks;
  }
  return input;
}
