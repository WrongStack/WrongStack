# @wrongstack/fleet

The multi-agent fleet host: `MultiAgentHost` and its director wiring, the
delegation runtime and routing runner, ACP and WrongForge workers, and the
explore, memory and skill companions.

Extracted from `@wrongstack/cli` (`src/fleet/`) on 2026-10-31 so a host other
than the CLI (the standalone WebUI engine) can build a fleet without importing
the CLI. It depends on `@wrongstack/coordination`, core's public subpaths and
the provider, ACP, SAGE, SDD and worktree packages; nothing it imports depends
on the CLI.

Embedder-supplied pieces are injected through `MultiAgentDeps`: the WrongForge
tool gateway (`wrongForgeGateway`) and the subagent hook runner (`hookRunner`)
live in the CLI and are passed in.
