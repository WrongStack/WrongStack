# CodeMap graph transfer

CodeMap uses the existing `/api/codemap/packages`, `/api/codemap/files?package=...`
and `/api/codemap/symbols?file=...` endpoints. This is a WrongStack transport
contract, independent of the index provider. No WrongIndex changes are required.

## Compatibility and bounded responses

Without `transfer=chunks`, endpoints retain their full-graph JSON response.
The shared WebUI/desktop graph loader opts in with `transfer=chunks`. Graphs
up to 512 KiB of serialized UTF-8 JSON still return their usual shape. Larger
graphs return an envelope:

```json
{
  "transport": "codemap-chunks-v1",
  "snapshot": "opaque-id",
  "offset": 0,
  "nextOffset": 524288,
  "totalBytes": 900000,
  "chunk": "base64-encoded-bytes"
}
```

Continue on the same endpoint with the original scope parameters plus
`transfer=chunks&snapshot=<id>&offset=<nextOffset>`. Each chunk contains at most
512 KiB of original bytes (about 683 KiB after base64), below the desktop's
unchanged 2 MiB per-response guard. `nextOffset: null` marks the final chunk.
Decode base64 to bytes, concatenate, then decode UTF-8 and parse JSON. Do not
decode individual chunks as UTF-8: a chunk can split a multibyte character.
The client publishes/caches only the complete graph, including all enrichment
fields and edges. This is byte transport, not silently truncated graph data.

## Snapshot consistency and budgets

Snapshots are immutable and bound to project, index directory and graph scope.
Continuations do not query the index, so an index refresh cannot mix generations
or interrupt an already retained snapshot. Normal endpoint authentication still
applies; snapshot IDs do not grant access to another project's graph.

A snapshot lasts 60 seconds. Retention is bounded to eight snapshots and 32 MiB
of graph bytes per server process; oldest snapshots may be evicted sooner.
Expired or evicted continuations return HTTP 409 with
`code: CODEMAP_SNAPSHOT_EXPIRED`. The client retries from the beginning once,
never appending bytes from another snapshot. Invalid offsets return HTTP 400.
A graph above 16 MiB returns HTTP 413 with `code: CODEMAP_GRAPH_TOO_LARGE` and
scope-narrowing guidance; it is not silently cut. Superseded loads stop requesting
further chunks.

New clients accept ordinary graph replies from older engines, but an older
engine cannot transfer graphs exceeding the desktop limit. Upgrade both engine
and desktop for chunk support. The bridge diagnoses this as a CodeMap transfer
problem rather than recommending reindexing. Index-creation advice in the canvas
is reserved for the explicit `CodeMap index unavailable` response.
