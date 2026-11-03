# Plans

This directory retains ongoing work ledgers, pending proposals and accepted
refactor decisions. Completed rollout plans live in
[the archive](../archive/plans/). A dated baseline in a plan is historical;
unchecked tasks do not by themselves prove a current product gap.

| Plan | Reading status |
|---|---|
| [Package improvement](packages-system-improvement-2026-09.md) | Ongoing work ledger; recorded checks certify their stated scope |
| [Kanban orchestration](kanban-orchestration-roadmap.md) | Historical roadmap and pending ideas; current behavior is in the Kanban guide |
| [HQ improvements](hq-improvements-2026-09.md) | Delivered slices plus deferred RFCs |
| [Coverage program](test-coverage-100-2026-08.md) | Target program; proposed exclusion registry is not an existing file |
| [Codebase index refactor](codebase-index-refactor.md) | Proposal; reviewed source links, with the duplicate root copy archived |
| [WrongIndex service](wrongindex/README.md) | Proposed standalone Rust daemon and desktop program; storage compatibility, delivery backlog, and acceptance gates |
| [WrongMemory service](wrongmemory/README.md) | Proposed multi-project Rust SAGE memory service; source research, independent MCP clients, WrongStack connection, migration, and acceptance gates |
| [Authority-first decision](adr-003-authority-first-refactor-program.md) | Accepted historical decision retained under its original identifier |
| [Core/Runtime ownership](adr-004-core-runtime-export-and-config-ownership.md) | Accepted ownership decision; exported subpaths are defined by current manifests |

Other plans retain their original baseline and sequencing. Before resuming
one, refresh its status against code and tests and record owner, scope and
verification date. [Architecture](../architecture.md) and source owners take
precedence over planned module names. See [maintenance](../maintenance.md).
