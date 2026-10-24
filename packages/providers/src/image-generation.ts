/**
 * Text-to-image wire shapes for `Provider.generateImage`. Pure request and
 * response mapping; the HTTP call, credentials and error translation stay in
 * the provider class that owns them.
 */

import type {
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerationResult,
} from '@wrongstack/contracts/types';

/** Images one request may ask for; the tool caps lower still. */
const MAX_IMAGES = 4;

function imageCount(req: ImageGenerationRequest): number {
  return Math.min(MAX_IMAGES, Math.max(1, Math.floor(req.count ?? 1)));
}

// ── OpenAI images API (`/images/generations`) ─────────────────────────────

/** The images endpoint next to the chat endpoint a base URL points at. */
export function openAIImagesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '').replace(/\/(chat\/completions|responses)$/, '');
  if (/\/v\d+(\/[a-z0-9_-]+)*$/i.test(b)) return `${b}/images/generations`;
  return `${b}/v1/images/generations`;
}

export function openAIImagesBody(req: ImageGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    prompt: req.prompt,
    n: imageCount(req),
  };
  if (req.size) body['size'] = req.size;
  // The gpt-image family always answers in base64 and refuses the field;
  // DALL·E answers with a short-lived URL unless asked for base64.
  if (/dall-e/i.test(req.model)) body['response_format'] = 'b64_json';
  return body;
}

interface OpenAIImagesWire {
  data?: { b64_json?: unknown; revised_prompt?: unknown }[];
  output_format?: unknown;
}

export function parseOpenAIImages(json: unknown): ImageGenerationResult {
  const wire = (json ?? {}) as OpenAIImagesWire;
  const format = typeof wire.output_format === 'string' ? wire.output_format : 'png';
  const mediaType = `image/${format === 'jpg' ? 'jpeg' : format}`;
  const images: GeneratedImage[] = [];
  const revised: string[] = [];
  for (const item of wire.data ?? []) {
    if (typeof item.b64_json === 'string' && item.b64_json) {
      images.push({ data: item.b64_json, mediaType });
    }
    if (typeof item.revised_prompt === 'string' && item.revised_prompt) {
      revised.push(item.revised_prompt);
    }
  }
  return { images, ...(revised.length > 0 ? { text: revised.join('\n') } : {}) };
}

// ── Gemini (`generateContent` with an image modality, or Imagen `predict`) ─

/** Imagen models have their own endpoint; Gemini image models answer through generateContent. */
function isImagen(model: string): boolean {
  return /(^|\/)imagen-/i.test(model);
}

export interface GeminiImageCall {
  url: string;
  body: Record<string, unknown>;
  /** How many calls produce `count` images: generateContent returns one each. */
  calls: number;
  parse(json: unknown): ImageGenerationResult;
}

export function geminiImageCall(baseUrl: string, req: ImageGenerationRequest): GeminiImageCall {
  const base = baseUrl.replace(/\/+$/, '');
  const model = req.model.replace(/^models\//, '');
  const count = imageCount(req);
  if (isImagen(model)) {
    const parameters: Record<string, unknown> = { sampleCount: count };
    const aspect = aspectRatioOf(req.size);
    if (aspect) parameters['aspectRatio'] = aspect;
    return {
      url: `${base}/models/${model}:predict`,
      body: { instances: [{ prompt: req.prompt }], parameters },
      calls: 1,
      parse: parseImagenPredictions,
    };
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
  const aspect = aspectRatioOf(req.size);
  if (aspect) generationConfig['imageConfig'] = { aspectRatio: aspect };
  return {
    url: `${base}/models/${model}:generateContent`,
    body: { contents: [{ role: 'user', parts: [{ text: req.prompt }] }], generationConfig },
    calls: count,
    parse: parseGeminiImageParts,
  };
}

/** `1024x1536` → `2:3`, for the Gemini/Imagen aspect-ratio field. */
function aspectRatioOf(size: string | undefined): string | undefined {
  const match = size ? /^(\d+)x(\d+)$/.exec(size.trim()) : null;
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

interface GeminiPartWire {
  text?: unknown;
  inlineData?: { mimeType?: unknown; data?: unknown };
}

function parseGeminiImageParts(json: unknown): ImageGenerationResult {
  const wire = (json ?? {}) as { candidates?: { content?: { parts?: GeminiPartWire[] } }[] };
  const images: GeneratedImage[] = [];
  const text: string[] = [];
  for (const candidate of wire.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData;
      if (inline && typeof inline.data === 'string' && inline.data) {
        images.push({
          data: inline.data,
          mediaType: typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png',
        });
      } else if (typeof part.text === 'string' && part.text.trim()) {
        text.push(part.text.trim());
      }
    }
  }
  return { images, ...(text.length > 0 ? { text: text.join('\n') } : {}) };
}

function parseImagenPredictions(json: unknown): ImageGenerationResult {
  const wire = (json ?? {}) as {
    predictions?: { bytesBase64Encoded?: unknown; mimeType?: unknown }[];
  };
  const images: GeneratedImage[] = [];
  for (const p of wire.predictions ?? []) {
    if (typeof p.bytesBase64Encoded === 'string' && p.bytesBase64Encoded) {
      images.push({
        data: p.bytesBase64Encoded,
        mediaType: typeof p.mimeType === 'string' ? p.mimeType : 'image/png',
      });
    }
  }
  return { images };
}
