/**
 * TransformersEmbeddingProvider — wraps `@huggingface/transformers`'s
 * feature-extraction pipeline as a sage `EmbeddingProvider`.
 *
 * The provider is lazy: nothing is imported until `embed()` is first called.
 * If the opt-in `@huggingface/transformers` package is not installed,
 * `isAvailable()` returns false and `embed()` throws
 * a descriptive `VectorMemoryProviderUnavailableError` so callers can
 * fall back to `HashingEmbeddingProvider`.
 *
 * Default model: `Xenova/all-MiniLM-L6-v2` (384 dims, ~25MB quantized).
 * On first use the model is fetched from the Hugging Face Hub and cached
 * under `cacheDir` (default: `.wrongstack/vector-memory/models`).
 */
import type { EmbeddingProvider } from '@wrongstack/sage';
import { createRequire } from 'node:module';

import { VectorMemoryProviderUnavailableError } from './errors.js';

export const DEFAULT_VECTOR_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_VECTOR_DIMENSIONS = 384;
export const DEFAULT_VECTOR_DTYPE = 'q8';

export interface TransformersEmbeddingProviderOptions {
  /** Hugging Face Hub model id (default `Xenova/all-MiniLM-L6-v2`). */
  modelId?: string;
  /** Local cache directory for downloaded model files. */
  cacheDir?: string;
  /** Inference dtype — `q8` is ~4x smaller and ~2x faster than `fp32`. */
  dtype?: 'q8' | 'fp16' | 'fp32' | 'q4';
  /** Device selector — Node builds default to `cpu` via onnxruntime-node. */
  device?: 'cpu' | 'wasm' | 'webgpu';
  /** Maximum texts per batch when calling the pipeline. */
  batchSize?: number;
  /** Maximum characters per input before the provider truncates. */
  maxChars?: number;
  /**
   * Disable remote model downloads. Useful in offline / air-gapped runs
   * — the provider will surface a clear error when the model isn't cached.
   */
  allowRemoteModels?: boolean;
}

/**
 * Type for the dynamically-imported `@huggingface/transformers` module.
 * The fields are the only ones we touch — keep them narrow so a missing
 * export doesn't fail the static type-check.
 */
interface TransformersModule {
  env: {
    cacheDir?: string;
    allowRemoteModels?: boolean;
    localModelPath?: string;
  };
  pipeline(task: string, model?: string, options?: Record<string, unknown>): Promise<unknown>;
}

/** Minimal shape we need from the feature-extraction pipeline output. */
type FeatureExtractor = (
  texts: string | string[],
  options?: Record<string, unknown>,
) => Promise<TensorLike>;
interface TensorLike {
  data: Float32Array | number[];
  dims?: number[];
  tolist?(): number[][] | number[];
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly modelId: string;
  private readonly cacheDir: string | undefined;
  private readonly dtype: TransformersEmbeddingProviderOptions['dtype'];
  private readonly device: TransformersEmbeddingProviderOptions['device'];
  private readonly batchSize: number;
  private readonly maxChars: number;
  private readonly allowRemote: boolean;
  private extractor: FeatureExtractor | undefined;
  private loadPromise: Promise<FeatureExtractor> | undefined;

  constructor(opts: TransformersEmbeddingProviderOptions = {}) {
    const modelId = opts.modelId === undefined ? DEFAULT_VECTOR_MODEL_ID : opts.modelId;
    if (typeof modelId !== 'string' || modelId.trim().length === 0) {
      throw new Error('TransformersEmbeddingProvider: modelId must be a non-empty string');
    }
    this.modelId = modelId;
    if (
      opts.cacheDir !== undefined &&
      (typeof opts.cacheDir !== 'string' || opts.cacheDir.trim().length === 0)
    ) {
      throw new Error('TransformersEmbeddingProvider: cacheDir must be a non-empty string');
    }
    this.cacheDir = opts.cacheDir;
    const dtype = opts.dtype === undefined ? DEFAULT_VECTOR_DTYPE : opts.dtype;
    if (!['q8', 'fp16', 'fp32', 'q4'].includes(dtype)) {
      throw new Error('TransformersEmbeddingProvider: unsupported dtype');
    }
    this.dtype = dtype;
    const device = opts.device === undefined ? 'cpu' : opts.device;
    if (!['cpu', 'wasm', 'webgpu'].includes(device)) {
      throw new Error('TransformersEmbeddingProvider: unsupported device');
    }
    this.device = device;
    const batchSize = opts.batchSize ?? 16;
    this.batchSize = Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : 16;
    const maxChars = opts.maxChars ?? 2048;
    this.maxChars = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : 2048;
    if (opts.allowRemoteModels !== undefined && typeof opts.allowRemoteModels !== 'boolean') {
      throw new Error('TransformersEmbeddingProvider: allowRemoteModels must be a boolean');
    }
    this.allowRemote = opts.allowRemoteModels ?? true;
    this.dimensions = DEFAULT_VECTOR_DIMENSIONS;
    // Stable id includes model + dtype so changing either triggers reindex.
    this.id = `transformers-js:${this.modelId}:${this.dtype}`;
  }

  /**
   * Synchronous capability check. Returns false when the optional
   * `@huggingface/transformers` dependency is not installed.
   *
   * NOTE: this probes via dynamic import and caches the result, but does
   * NOT load the model itself — model loading is deferred to `embed()`.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.loadModule();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronous, load-free install probe for boot paths: resolves the
   * opt-in package without importing it (the import pulls in the ONNX
   * runtime). False means `embed()` is guaranteed to throw, so a host must
   * not advertise vector tools on top of this provider. A standalone binary
   * never bundles the package, so it is false there unless installed beside it.
   */
  isInstalled(): boolean {
    // Indirect specifier for the same reason as `loadModule()`.
    const packageName = '@huggingface/transformers';
    try {
      if (typeof import.meta.resolve === 'function') import.meta.resolve(packageName);
      else createRequire(import.meta.url).resolve(packageName);
      return true;
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.getExtractor();
    const prepared = texts.map((t) => this.prepare(t));
    const batches: string[][] = [];
    for (let i = 0; i < prepared.length; i += this.batchSize) {
      batches.push(prepared.slice(i, i + this.batchSize));
    }
    const results: Float32Array[] = [];
    for (const batch of batches) {
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      const vectors = this.tensorToVectors(out, batch.length);
      if (vectors.length !== batch.length) {
        throw new Error(
          `TransformersEmbeddingProvider: pipeline returned ${vectors.length} vectors for a batch of ${batch.length}`,
        );
      }
      const width = results[0]?.length ?? vectors[0]?.length ?? 0;
      if (width === 0 || vectors.some((vector) => vector.length !== width)) {
        throw new Error(
          'TransformersEmbeddingProvider: pipeline returned empty or unequal-width vectors',
        );
      }
      if (vectors.some((vector) => !vector.every(Number.isFinite))) {
        throw new Error('TransformersEmbeddingProvider: pipeline returned non-finite values');
      }
      results.push(...vectors);
    }
    return results;
  }

  /** Truncate + normalize text before embedding. */
  private prepare(text: string): string {
    if (!text) return '';
    const normalized = text.normalize('NFKC').trim();
    return normalized.length > this.maxChars ? normalized.slice(0, this.maxChars) : normalized;
  }

  private tensorToVectors(out: TensorLike, batchSize: number): Float32Array[] {
    // transformers.js returns a Tensor; for a batch with `pooling: 'mean',
    // normalize: true` the shape is [batch, dimensions] and `.tolist()`
    // yields number[][] — but some versions expose `.data` as a flat
    // Float32Array. Handle both shapes so we don't depend on internals.
    if (typeof out.tolist === 'function') {
      const nested = out.tolist();
      if (Array.isArray(nested) && Array.isArray(nested[0])) {
        return (nested as unknown as number[][]).map((row) => Float32Array.from(row));
      }
      // Single-row fallback (the pipeline sometimes collapses batch=1).
      const flat = nested as unknown as number[];
      if (batchSize > 1 && flat.length > 0 && flat.length % batchSize === 0) {
        const dimensions = flat.length / batchSize;
        return Array.from({ length: batchSize }, (_, index) =>
          Float32Array.from(flat.slice(index * dimensions, (index + 1) * dimensions)),
        );
      }
      return [Float32Array.from(flat)];
    }
    const flat = out.data;
    if (flat instanceof Float32Array) {
      if (batchSize === 1) return [flat];
      const dim = flat.length / batchSize;
      const vectors: Float32Array[] = [];
      for (let i = 0; i < batchSize; i++) {
        vectors.push(Float32Array.from(flat.subarray(i * dim, (i + 1) * dim)));
      }
      return vectors;
    }
    if (Array.isArray(flat) && Array.isArray(flat[0])) {
      return (flat as unknown as number[][]).map((row) => Float32Array.from(row));
    }
    if (Array.isArray(flat)) {
      if (batchSize === 1) return [Float32Array.from(flat as unknown as number[])];
      if (flat.length % batchSize === 0) {
        const dimensions = flat.length / batchSize;
        return Array.from({ length: batchSize }, (_, index) =>
          Float32Array.from(
            (flat as unknown as number[]).slice(index * dimensions, (index + 1) * dimensions),
          ),
        );
      }
      return [Float32Array.from(flat as unknown as number[])];
    }
    throw new Error('TransformersEmbeddingProvider: unexpected pipeline output shape');
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    if (!this.loadPromise) {
      // Drop the memo when the load FAILS. Every consumer of `embed()` is
      // fail-open (`VectorMemoryStore.embedWithCache` swallows the error and
      // returns undefined), so a memo that kept the rejection would be
      // indistinguishable from "this provider has no embeddings": `remember()`
      // would persist entries without vectors and `search()` would return
      // nothing, for the rest of the process, off one transient failure (a
      // flaky hub, a timeout during the first model download). Retry instead —
      // concurrent callers still share the single in-flight load.
      this.loadPromise = this.loadExtractor().catch((err: unknown) => {
        this.loadPromise = undefined;
        throw err;
      });
    }
    this.extractor = await this.loadPromise;
    return this.extractor;
  }

  private async loadExtractor(): Promise<FeatureExtractor> {
    const mod = await this.loadModule();
    if (this.cacheDir) mod.env.cacheDir = this.cacheDir;
    mod.env.allowRemoteModels = this.allowRemote;
    if (!this.allowRemote) mod.env.localModelPath = this.cacheDir ?? '';
    const pipe = await mod.pipeline('feature-extraction', this.modelId, {
      dtype: this.dtype,
      device: this.device,
    });
    return pipe as FeatureExtractor;
  }

  private async loadModule(): Promise<TransformersModule> {
    try {
      // The opt-in backend may be absent — surface that as a typed
      // error so callers can swap in a fallback provider cleanly.
      // Keep the specifier indirect: this backend is intentionally opt-in, so
      // builds must not require the package to be present for module resolution.
      const packageName = '@huggingface/transformers';
      return (await import(packageName)) as unknown as TransformersModule;
    } catch (err) {
      throw new VectorMemoryProviderUnavailableError(
        '@huggingface/transformers is not installed. Install it (pnpm add @huggingface/transformers) or wire a fallback EmbeddingProvider.',
        err,
      );
    }
  }
}
