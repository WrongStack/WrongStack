# Coverage Matrix — 2026-08-29

Aggregated from per-area `coverage/coverage-summary.json` files by
`scripts/coverage-matrix.mjs` (`pnpm coverage:matrix`). This report is a progress view for
`docs/plans/test-coverage-100-2026-08.md`; enforcement lives in each area's vitest config.

| Area | Lines | Stmts | Funcs | Branches | Uncovered stmts | Measured | Age |
|---|---:|---:|---:|---:|---:|---|---:|
| coverage/root | 84.36% | 82.47% | 82.73% | 73.10% | 34805 | 2026-08-29 | 0d |
| coverage/scripts | 99.00% | 98.91% | 99.42% | 96.32% | 11 | 2026-08-29 | 0d |
| packages/acp | 97.84% | 97.40% | 98.08% | 93.87% | 69 | 2026-08-04 | 24d |
| packages/bench | 100.00% | 100.00% | 100.00% | 100.00% | 0 | 2026-08-04 | 24d |
| packages/kanban | — | — | — | — | 0 | 2026-07-17 | 42d |
| packages/mcp | 100.00% | 100.00% | 100.00% | 100.00% | 0 | 2026-08-04 | 24d |
| packages/persistence | 100.00% | 100.00% | 100.00% | 100.00% | 0 | 2026-08-05 | 24d |
| packages/plug-lsp | 99.73% | 99.76% | 100.00% | 99.86% | 3 | 2026-08-29 | 0d |
| packages/sdd | 99.96% | 99.79% | 99.09% | 99.23% | 6 | 2026-08-13 | 15d |
| packages/security-scanner | 100.00% | 100.00% | 100.00% | 100.00% | 0 | 2026-08-04 | 24d |
| packages/techstack | 91.22% | 87.81% | 93.53% | 72.15% | 327 | 2026-08-04 | 24d |
| packages/telegram | — | — | — | — | 0 | 2026-07-25 | 34d |
| packages/tui | 72.12% | 70.28% | 73.85% | 60.70% | 5788 | 2026-08-04 | 24d |
| packages/webui | 61.08% | 59.52% | 52.08% | 51.31% | 12001 | 2026-08-29 | 0d |
| packages/webui-protocol | 100.00% | 99.44% | 100.00% | 98.61% | 1 | 2026-08-29 | 0d |
| packages/webui-server | 58.58% | 56.89% | 48.55% | 51.27% | 5244 | 2026-08-04 | 24d |
| apps/desktop | 41.62% | 39.54% | 32.72% | 30.66% | 815 | 2026-08-14 | 15d |

## Worst files in the root run (by uncovered statements)

| File | Uncovered stmts | Lines |
|---|---:|---:|
| packages\tui\src\hooks\use-tui-slash-commands.ts | 246 | 22.48% |
| packages\cli\src\slash-commands\kanban-task-subcommands.ts | 244 | 26.73% |
| packages\cli\src\project-picker.ts | 237 | 20.14% |
| packages\tools\src\codebase-index\project-server.ts | 226 | 46.25% |
| packages\tui\src\hooks\use-director-fleet-bridge.ts | 204 | 23.21% |
| packages\webui-server\src\server\start-webui.ts | 203 | 16.81% |
| packages\tui\src\components\kanban-panel.tsx | 199 | 42.90% |
| packages\cli\src\boot.ts | 193 | 29.61% |
| packages\kanban\src\server\project-server.ts | 193 | 48.55% |
| packages\cli\src\slash-commands\tier.ts | 180 | 1.76% |
| packages\tui\src\hooks\use-auth-panel.ts | 180 | 39.49% |
| packages\cli\src\slash-commands\session.ts | 174 | 42.45% |
| packages\tui\src\app-key-handler.ts | 173 | 28.50% |
| packages\sage\src\project-server.ts | 172 | 45.20% |
| packages\simpleui\src\simple-ui-session.tsx | 168 | 41.66% |
