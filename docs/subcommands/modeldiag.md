# `wstack modeldiag` - Model diagnostics & benchmarking

Read-only diagnostics over your configured providers and the model matrix:
API-key check, capability scan, heuristic model suggestions per role, and
real benchmarked comparisons. Never modifies config — pinning a suggestion is
always an explicit `wstack setmodel` call.

Model metadata comes from the local models cache; capability heuristics use a
built-in profile table (family, strengths, cost tier, speed tier).

## Usage

| Command | Effect |
|---|---|
| `wstack modeldiag` | Full report (default; combines the sections below) |
| `wstack modeldiag keys` | API-key status per provider |
| `wstack modeldiag caps` | Capability scan of available models |
| `wstack modeldiag suggest` | Heuristic model suggestions per role (with the `setmodel` command to pin each) |
| `wstack modeldiag test` | Connectivity/capability test across keyed providers |
| `wstack modeldiag bench <role> "<prompt>" [--providers=p1,p2]` | Benchmark candidate models for a role with a real prompt |
| `wstack modeldiag eval [role] [--providers=…] [--max=N] [--quick]` | Evaluate models per category (`--quick` = 1 model per category) |

## Typical flow

```
wstack modeldiag keys          # do my providers have keys?
wstack modeldiag suggest       # what should each role use?
wstack modeldiag bench coding "write a binary search in TS"
wstack setmodel set coding anthropic/anthropic-test-model   # pin the winner
```

## Notes

- `bench`/`eval` make real API calls to the selected providers (cost applies);
  everything else is offline against the models cache and config.
- Ported from the removed `/modeldiag` slash command — this is now the only
  entry point.

## Code Reference

- `packages/cli/src/subcommands/handlers/modeldiag.ts`
- `packages/cli/src/slash-commands/setmodel.ts` (pinning)
