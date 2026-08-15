# @wrongstack/vector-memory

An **additional vector-search memory** that sits alongside the existing
SAGE lexical memory system. Embeddings are computed locally via
[@huggingface/transformers](https://github.com/huggingface/transformers.js)
using the `Xenova/all-MiniLM-L6-v2` ONNX model (384 dimensions, ~25 MB
quantized). No project text leaves the machine.

The store is deliberately separate from SAGE's SQLite database — its own
file under `.wrongstack/vector-memory/vector-memory.db` — so the two
stores cannot contend on the same file lock. A built-in `syncFromSage`
bridge indexes active SAGE memories into the vector store, giving
semantic search over your existing knowledge.

## Parallel operation with SAGE

`wrapMemoryPortWithVectorRecall(port, { store })` returns a new
`MemoryPort` whose `searchSage` calls automatically fuse lexical and
semantic recall via Reciprocal Rank Fusion. Hosts that opt in get
**vector-augmented retrieval without changing any caller code** — the
tool-call middleware, the turn middleware, and the surface/retrieval
capabilities all see the same `searchSage(query, options)` shape.

```ts
import {
  VectorMemoryStore,
  TransformersEmbeddingProvider,
  wrapMemoryPortWithVectorRecall,
} from '@wrongstack/vector-memory';

const vectorStore = new VectorMemoryStore({
  provider: new TransformersEmbeddingProvider({ cacheDir }),
  projectRoot,
});

const augmentedPort = wrapMemoryPortWithVectorRecall(sagePort, {
  store: vectorStore,
  weight: 0.3, // default; mirrors SAGE's hybridRerankMemories baseline
});

// Every downstream searchSage(query, options) now does
//   lexical candidates + vector hits → RRF → fused result list
const hits = await augmentedPort
  .getCapability(SAGE_RETRIEVAL_CAPABILITY)!
  .searchSage('quantum entanglement', { limit: 10 });
```

The wrapper is fail-open: a thrown error from the vector backend
(offline model, missing dependency) falls back to the lexical list
unchanged. The vector channel only **re-orders and boosts** — it does
not inject foreign memories, because vector hits that map to SAGE
memories not present in the lexical list are dropped (no Sage object to
materialize).

## Embedding result cache

A provider-level cache keyed by `(content_hash, provider_id, dimensions)`
skips the ONNX forward pass for repeated text. Both `remember()` and
`search()` use the same cache, so the second embedding of an identical
text costs only a SQLite lookup. Hosts that want to bound cache growth
can call `store.evictCache(keepMostRecent)` for an LRU sweep.

```ts
const stats = store.cacheStats();
// { entries: 142, providers: 1, totalUseCount: 1834, oldestLastUsedAt: '...' }
```

## Cross-process safety

Mutating operations (`remember`, `forget`, `reindexAll`, `syncFromSage`,
`evictCache`) are wrapped in a host-OS file lock. Two processes pointing
at the same `.wrongstack/vector-memory/vector-memory.db` cannot interleave
a read-modify-write. `remember()` is also idempotent on `content_hash`:
calling it twice with the same text returns the existing entry instead of
inserting a duplicate (the `UNIQUE` index on `entries.content_hash` is
the second line of defense).

## Installation

`@huggingface/transformers` is listed as an **optional** dependency so
the package installs and typechecks even without it. In this monorepo
it's installed by default; in downstream packages, ensure it's present:

```sh
pnpm add @huggingface/transformers
```

The package itself is a workspace member; no extra install step is
needed inside the monorepo.

## Quick start

```ts
import {
  TransformersEmbeddingProvider,
  VectorMemoryStore,
  createVectorMemoryTools,
} from '@wrongstack/vector-memory';
import path from 'node:path';

const provider = new TransformersEmbeddingProvider({
  // Optional overrides (these are the defaults):
  modelId: 'Xenova/all-MiniLM-L6-v2',
  cacheDir: path.join(projectRoot, '.wrongstack/vector-memory/models'),
  dtype: 'q8',
  device: 'cpu',
  allowRemoteModels: true, // set false to require a pre-cached model
});

const store = new VectorMemoryStore({ provider, projectRoot });

await store.remember({ text: 'pnpm is the package manager', tags: ['build'] });

const hits = await store.search('how do we install dependencies', { limit: 5 });
//   → hits[i].entry.text, hits[i].score (cosine similarity in [0, 1])

store.close();
```

## Tools

`createVectorMemoryTools(store)` returns four `@wrongstack/core` `Tool`
definitions that surface the store to agents:

| Tool | Permission | Mutating | Purpose |
|------|------------|----------|---------|
| `vector_memory_remember` | `confirm` | yes | Store text + embed it |
| `vector_memory_search` | `auto` | no | Semantic top-k search |
| `vector_memory_stats` | `auto` | no | Entry/vector/provider counts |
| `vector_memory_forget` | `confirm` | yes | Hard-delete an entry by id |

Wire them alongside `createSageTools` if you want agents to have both
the lexical and the semantic memory surface.

## Graceful fallback

`TransformersEmbeddingProvider` is lazy — nothing is imported until the
first `embed()` call. If `@huggingface/transformers` is not installed
or the model fails to load (offline, corrupt cache, etc.):

- `isAvailable()` returns `false`.
- `embed()` throws `VectorMemoryProviderUnavailableError` (or a wrapped
  underlying error from the pipeline).
- The store's `remember()` **swallows** the embedding failure and
  persists the entry without a vector. Search simply skips entries
  without a matching vector row. Writes never disappear.
- `search()` returns `[]` when embedding fails, so callers can fall
  back to lexical search at a higher layer.

For an offline-only store, wire the sage `HashingEmbeddingProvider`
instead — it's deterministic, zero-dependency, and satisfies the same
`EmbeddingProvider` contract:

```ts
import { HashingEmbeddingProvider, type EmbeddingProvider } from '@wrongstack/sage';

const provider: EmbeddingProvider = new HashingEmbeddingProvider({ dimensions: 384 });
```

The store accepts any `EmbeddingProvider`; you can mix and match
between providers across instances or for testing.

## Syncing with SAGE

```ts
const sagePort = /* a MemoryPort or any object satisfying SageSyncSource */;
const report = await store.syncFromSage({
  listActiveMemories: async ({ limit }) => {
    const page = await sagePort.listSagePage({ statuses: ['active'], limit });
    return (page.memories ?? []).map((m) => ({
      id: m.id,
      text: m.text,
      tags: m.tags,
    }));
  },
});
// { scanned, indexed, skipped, failed, errors }
```

The bridge deduplicates on `contentHash` (SHA-256 of NFKC-normalized
text) so repeated calls are idempotent.

## Storage layout

```
<projectRoot>/.wrongstack/vector-memory/
├── vector-memory.db          — SQLite database (WAL mode)
├── vector-memory.db-wal      — WAL frame file
└── models/                   — transformers.js model cache (when configured)
```

The model cache defaults to `.wrongstack/vector-memory/models` under
the project root; override via `TransformersEmbeddingProvider({ cacheDir })`.
Set `allowRemoteModels: false` to refuse downloads and require a
pre-populated cache (useful in CI / air-gapped runs).

## Schema

- `entries` — text, summary, metadata JSON, tags JSON, scope, kind,
  content_hash, timestamps. Indexed on scope/kind/hash/updated_at.
- `vectors` — `(entry_id, provider_id)` PK, dimensions, raw float32
  BLOB, timestamp. Foreign-key cascades on entry delete. Provider-id
  keying means a model change triggers reindexing rather than mixed
  vectors.
- `entries_fts` — FTS5 mirror of `text` + `tags` for the optional
  lexical fallback path. Kept in sync via triggers.
- `schema_meta` — active provider id and dimensions.

## API reference

- `VectorMemoryStore` — constructor `({ provider, projectRoot, directory?, filename? })`.
- `remember(input)` → `VectorEntryWithVector`
- `get(id)` → `VectorEntryWithVector | undefined`
- `forget(id)` → `boolean`
- `search(query, opts?)` → `VectorSearchHit[]`
- `list(opts?)` → `VectorEntry[]`
- `stats()` → `VectorStoreStats`
- `reindexAll()` → `{ processed, errors }`
- `syncFromSage(source)` → `SageSyncReport`
- `activeProviderId` → `string`
- `close()`

See `src/types.ts` for the full type surface.

## Testing

Tests use a deterministic `FakeEmbeddingProvider` — no network, no
model download. Run:

```sh
pnpm --filter @wrongstack/vector-memory test
```

The integration path that exercises the real transformers.js pipeline
is not included in the default test suite because it requires model
download. To exercise it manually:

```ts
import { TransformersEmbeddingProvider } from '@wrongstack/vector-memory';
const p = new TransformersEmbeddingProvider();
console.log(await p.isAvailable()); // true when @huggingface/transformers is installed
const [vec] = await p.embed(['hello world']);
console.log(vec.length); // 384
```

## Related

- `@wrongstack/sage` — lexical/FTS/graph memory. `EmbeddingProvider` and
  `cosineSimilarity` are exported from sage so any package can implement
  or compose with them.
- `docs/competitive-roadmap-2026-2027/13-semantic-sage-retrieval.md` —
  the roadmap doc this package implements a subset of.
