# Semantic Sage Retrieval

**Priority:** P0  
**Horizon:** 0–4 months  
**Status:** Proposed

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
2. Add provider abstraction, cache, and one local plus one remote adapter.
3. Implement vector index rebuild and mutation synchronization under the project lock.
4. Add hybrid ranking, diversity, and retrieval explanations.
5. Tune injection budgets and expose opt-in diagnostics.

## Acceptance criteria

- Canonical memory reads/writes remain correct if the vector index is absent or corrupt.
- No project text leaves the machine unless the selected embedding provider and policy allow it.
- Retrieval evaluation improves recall without unacceptable precision or token-budget regression.
- Model changes trigger safe reindexing rather than mixed-vector search.

