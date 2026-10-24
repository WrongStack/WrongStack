/** A text-to-image request for `Provider.generateImage`. */
export interface ImageGenerationRequest {
  /** An image model of this provider (catalog output modality `image`). */
  model: string;
  prompt: string;
  /** Provider size string, e.g. `1024x1024`; the provider default when omitted. */
  size?: string | undefined;
  /** Images to produce; 1 when omitted. */
  count?: number | undefined;
}

export interface GeneratedImage {
  /** Bare base64. */
  data: string;
  mediaType: string;
}

export interface ImageGenerationResult {
  images: GeneratedImage[];
  /** Text the model returned alongside the images (a rewritten prompt, a caption). */
  text?: string | undefined;
}
