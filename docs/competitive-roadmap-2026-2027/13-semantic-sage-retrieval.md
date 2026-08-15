# Semantic Sage Retrieval

**Priority:** P0  
**Horizon:** 0–4 months  
**Status:** Partial — embedding-provider + vector-index layers shipped in `@wrongstack/vector-memory`; deeper SAGE integration (hybrid rerank in the tool-call/turn middleware, audience-aware scoring, online eval corpus) remains.

## Outcome

Add embedding-based recall to the existing lexical, anchor, and graph retrieval pipeline while keeping local-first operation, deterministic fallbacks, and current store invariants.

## Current baseline

Sage is already the default store across runtime surfaces. This plan does not repeat wiring work; it improves relevance and recall.

## Architecture

- Introduce an embedding provider interface independent of chat providers.
- Store vector index metadata separately from the canonical SQLite `memories` table; SQLite remains the source of truth (JSONL was replaced as canonical storage in 2026-07).
- Key embeddings by normalized content hash, model ID, dimensions, and scope.
- Fuse semantic, lexical, anchor, recency, quality, and graph scores with inspectable contributions.
- Rebuild incrementally and degrade to current retrieval when embeddings are unavailable.

## Delivery plan

1. Create an offline evaluation corpus from sanitized fixtures.
2. Add provider abstraction, cache, and one local plus one remote adapter. — **Partial** — shipped the provider abstraction (`@wrongstack/sage`'s `EmbeddingProvider` interface) and two local implementations (`TransformersEmbeddingProvider` via `@huggingface/transformers`, and the existing `HashingEmbeddingProvider`). An embedding-result cache (so repeated `embed()` calls for the same text skip the ONNX forward pass) and a remote adapter (HTTP embedding API) remain.
3. Implement vector index rebuild and mutation synchronization under the project lock. — **Partial** — shipped provider-keyed vector storage and reindex (`VectorMemoryStore` keyed by `(entry_id, provider_id)`, `reindexAll()` re-embeds under a new provider id) plus SHA-256 content-hash dedup for the `syncFromSage()` path. Project-lock synchronization across processes and general mutation dedup in `remember()` (today it always inserts a fresh random UUID) remain.
4. Add hybrid ranking, diversity, and retrieval explanations.
5. Tune injection budgets and expose opt-in diagnostics.

## What shipped (2026-08-15)

- New package [`@wrongstack/vector-memory`](../../packages/vector-memory) — a standalone SQLite-backed vector memory store that sits **alongside** SAGE rather than replacing its retrieval.
- Pluggable embedding providers implementing sage's `EmbeddingProvider` contract:
  - `TransformersEmbeddingProvider` — local ONNX embeddings via [`@huggingface/transformers`](https://github.com/huggingface/transformers.js), default `Xenova/all-MiniLM-L6-v2` (384-dim, q8 quantized). Lazy-loads `@huggingface/transformers` via dynamic `import()`; throws a typed `VectorMemoryProviderUnavailableError` when the optional dependency is not installed so callers can fall back cleanly.
  - Sage's existing `HashingEmbeddingProvider` — deterministic zero-dependency fallback.
- Vector store with `entries` + `vectors` tables (vectors keyed by `(entry_id, provider_id)` so model changes trigger a safe reindex rather than mixed-vector search).
- Four agent-facing tools exposed via `createVectorMemoryTools(store)`:
  - `vector_memory_remember` (permission: `confirm`, mutating)
  - `vector_memory_search` (permission: `auto`)
  - `vector_memory_stats` (permission: `auto`)
  - `vector_memory_forget` (permission: `confirm`, mutating)
- Wired into the canonical host tool surface: `registerCanonicalHostTools({ vectorMemory: { store } })` registers the four tools alongside `createSageTools` without disturbing the SAGE-only surface (the `vectorMemory` option is opt-in).
- CLI smoke test (`packages/cli/tests/boot/vector-memory-tools.test.ts`) exercises an agent calling `vector_memory_remember → vector_memory_search` end-to-end through the real `ToolRegistry`.
- Graceful fallback: if `@huggingface/transformers` is not installed or the model fails to load, `remember()` persists the entry without a vector and `search()` returns `[]` — callers can fall back to lexical search at a higher layer.
- Integration test (`pnpm --filter @wrongstack/vector-memory test:integration`) gated behind `WRONGSTACK_VECTOR_INTEGRATION=1` so CI can periodically validate the real transformers.js pipeline (~25 MB model download) without blocking PRs.

## Remaining work

- Online evaluation corpus for relevance regression testing.
- Hybrid ranking, diversity, and retrieval explanations (step 4 in the delivery plan).
- SAGE tool-call/turn middleware integration so semantic retrieval augments the existing lexical injection path (not just a sibling surface).
- Audience-aware scoring (semantic hit weighting by agent role/mode).

## Acceptance criteria

- Canonical memory reads/writes remain correct if the vector index is absent or corrupt. — **Verified**: `VectorMemoryStore.remember()` swallows provider failures and persists the entry; `search()` returns `[]` when embedding fails.
- No project text leaves the machine unless the selected embedding provider and policy allow it. — **Verified for local embeddings** (the shipped `TransformersEmbeddingProvider` defaults to local ONNX inference via `@huggingface/transformers`; the only network call is the optional Hugging Face Hub model download, configurable via `allowRemoteModels: false` for air-gapped runs). — **Pending** the remote adapter from step 2.
- Retrieval evaluation improves recall without unacceptable precision or token-budget regression. — Pending the online eval corpus.
- Model changes trigger safe reindexing rather than mixed-vector search. — **Verified for vector storage**: vectors are keyed by `(entry_id, provider_id)`; switching the active provider leaves old vectors in place but search filters by the current provider id, and `reindexAll()` re-embeds under the new id. — **Pending** project-lock synchronization from step 3.

