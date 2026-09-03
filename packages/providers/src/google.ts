import { createHash } from 'node:crypto';
import type { Capabilities, ProviderError, Request, StreamEvent } from '@wrongstack/core/types';
import { type HeadersLike, parseProviderHttpError } from './error-parse.js';
import type { GoogleStreamState } from './presets/google.js';
import { googleWireFormat, toolsToGemini } from './presets/google.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';
import { WireFormatProvider } from './wire-format.js';

/** Default server-side TTL (seconds) for an explicit Gemini cached-content resource. */
const GEMINI_CACHE_TTL_SECONDS = 3600;
const GEMINI_EXPLICIT_CACHE_MAX_ENTRIES = 128;

export interface GoogleProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  id?: string | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  /** Raw stream debugging and hang-detection options. */
  streamOpts?: WireAdapterStreamOptions | undefined;
  /**
   * Maximum number of tool definitions the provider accepts per request.
   * When set, lower-priority tools are filtered out centrally by
   * `WireAdapter.stream()` before the request body is built.
   */
  maxTools?: number | undefined;
}

export class GoogleProvider extends WireFormatProvider<GoogleStreamState> {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  constructor(opts: GoogleProviderOptions) {
    super(googleWireFormat, {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    this.id = opts.id ?? 'google';
    this.capabilities = {
      ...googleWireFormat.capabilities,
      ...opts.capabilities,
    };
    if (opts.maxTools && opts.maxTools > 0) {
      this.maxToolsCount = opts.maxTools;
    }
  }

  protected override translateError(
    status: number,
    text: string,
    headers?: HeadersLike,
  ): ProviderError {
    return parseProviderHttpError(this.id, status, text, headers);
  }

  /**
   * Prefix-hash → live cached-content resource. Entries carry a client-side
   * expiry a minute before the server TTL, so a just-expired name is never
   * reused; Gemini deletes the resource server-side when its TTL lapses, so no
   * explicit dispose is needed (which is why this works despite the provider
   * being rebuilt on every model switch).
   */
  private readonly explicitCache = new Map<string, { name: string | null; expiresAt: number }>();

  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    // Pre-filter tools for the maxTools limit so the explicit-cache hash
    // and toolChoice guard match the tools actually sent on the wire.
    // Uses the shared WireAdapter.applyMaxToolsFilter so Google gets the
    // same toolChoice-fallback behavior as all other families.
    const effectiveReq = this.applyMaxToolsFilter(req);

    // Explicit caching is opt-in and best-effort: any failure resolving the
    // cached-content resource falls back to the normal inline request (where
    // Gemini's implicit caching still applies), so enabling it can never break
    // a request.
    if (
      effectiveReq.cache?.geminiExplicit &&
      effectiveReq.system &&
      effectiveReq.system.length > 0
    ) {
      let name: string | undefined;
      try {
        name = await this.resolveCachedContent(effectiveReq, opts.signal);
      } catch {
        name = undefined;
      }
      if (name) {
        yield* super.stream(
          { ...effectiveReq, cache: { ...effectiveReq.cache, geminiCachedContentName: name } },
          opts,
        );
        return;
      }
    }
    yield* super.stream(effectiveReq, opts);
  }

  private async resolveCachedContent(
    req: Request,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const system = req.system ?? [];
    if (system.length === 0) return undefined;
    const hash = createHash('sha256')
      .update(req.model)
      .update('\0')
      .update(system.map((b) => b.text).join('\0'))
      .update('\0')
      // The cached resource contains the complete declarations. Hashing only
      // names would reuse stale descriptions/schemas after a tool update.
      .update(JSON.stringify(toolsToGemini(req.tools ?? [])))
      .digest('hex');

    const live = this.explicitCache.get(hash);
    if (live && live.expiresAt > Date.now()) return live.name ?? undefined;
    if (live) this.explicitCache.delete(hash);

    const createBody: Record<string, unknown> = {
      model: `models/${req.model}`,
      systemInstruction: { parts: system.map((b) => ({ text: b.text })) },
      ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
    };
    if (req.tools && req.tools.length > 0) {
      createBody['tools'] = [{ functionDeclarations: toolsToGemini(req.tools) }];
    }

    const res = await this.fetchImpl(`${this.baseUrl}/cachedContents`, {
      method: 'POST',
      headers: { ...this.buildHeaders(req), 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
      signal,
    });
    // A too-small prefix (Gemini enforces a minimum cache size) or any other
    // error just means "no explicit cache this time" — the caller falls back.
    if (!res.ok) {
      // Drain the body so fetch implementations can promptly reuse the socket.
      await res.text().catch(() => undefined);
      // Remember negative result so repeated turns in this session don't spam
      // failing /cachedContents POSTs when the prefix is below Gemini's token threshold.
      this.explicitCache.set(hash, {
        name: null,
        expiresAt: Date.now() + 60_000,
      });
      return undefined;
    }
    const json = (await res.json()) as { name?: unknown };
    const name = typeof json.name === 'string' ? json.name : undefined;
    if (!name) {
      this.explicitCache.set(hash, {
        name: null,
        expiresAt: Date.now() + 60_000,
      });
      return undefined;
    }
    const now = Date.now();
    for (const [key, entry] of this.explicitCache) {
      if (entry.expiresAt <= now) this.explicitCache.delete(key);
    }
    while (this.explicitCache.size >= GEMINI_EXPLICIT_CACHE_MAX_ENTRIES) {
      const oldest = this.explicitCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.explicitCache.delete(oldest);
    }
    this.explicitCache.set(hash, {
      name,
      expiresAt: now + GEMINI_CACHE_TTL_SECONDS * 1000 - 60_000,
    });
    return name;
  }
}
