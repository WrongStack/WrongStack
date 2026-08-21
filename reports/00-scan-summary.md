# WrongStack Codebase Scan — Summary (2026-08-21)

## Scope & method

- Target: `D:\Codebox\PROJECTS\WrongStack` (packages/, apps/, excluding `node_modules`, `dist`, docs).
- Tooling: ripgrep-backed content search (`grep`), AST symbol index (`codebase-stats`: 7,703 files indexed), targeted file reads for evidence verification.
- Pattern battery run: dynamic code execution (`eval` / `new Function`), hardcoded secrets (`sk-…`, AWS/GitHub token shapes), Electron security flags, TLS validation disabling, CORS wildcard origins, SQL string interpolation, path traversal (`path.resolve/join` on untrusted input), empty `catch {}` blocks, plaintext `http://` endpoints, `child_process` usage sites, `innerHTML` sinks, insecure randomness for tokens.

## Findings index

| # | Report | Severity |
|---|--------|----------|
| 1 | [01-empty-catch-blocks.md](01-empty-catch-blocks.md) | Medium |
| 2 | [02-dynamic-code-execution-tests.md](02-dynamic-code-execution-tests.md) | Low |
| 3 | [03-plaintext-http-provider-defaults.md](03-plaintext-http-provider-defaults.md) | Low / Informational |
| 4 | [04-todo-fixme-debt.md](04-todo-fixme-debt.md) | Low |
| 5 | [05-sql-string-interpolation-hardening.md](05-sql-string-interpolation-hardening.md) | Low (hardening) |
| 6 | [06-dependency-audit.md](06-dependency-audit.md) | None (clean) |

## Areas scanned and found clean (verified)

These hot spots were checked explicitly and are **correctly hardened** — listed so future scans don't re-flag them:

- **Electron security** (`apps/desktop/src/main/main.ts:392-394`, `webui/controller.ts:92-93`): `contextIsolation: true`, `nodeIntegration: false`. No `webSecurity: false` anywhere.
- **Path traversal**: `packages/webui-server/src/server/shell-open.ts` implements three containment layers (lexical resolve + metacharacter guard + `fs.realpath` canonical check against symlink TOCTOU). `completion-handlers.ts:162-175` validates `isInside(projectRoot, resolved)` before serving completions. `cli/src/wiring/codebase-index.ts:102-106` performs a correct `path.relative` containment check before reindex enqueue.
- **CORS**: no wildcard `Access-Control-Allow-Origin: *` or reflected-origin patterns found in `packages/**/src`.
- **TLS**: no production `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED` usage (only doc comments and scanner false-positive markers).
- **Secrets**: no hardcoded API keys matching common provider token shapes in source.
- **SQL injection**: user-controlled values are parameterized (`?` placeholders); interpolations found are compile-time constants only (see report 05).
- **XSS sinks**: no `innerHTML =` or `dangerouslySetInnerHTML` outside the security-scanner's own detection regex.

## Limitations

- Scan was static/pattern-based; no runtime, fuzz, or dependency-vulnerability audit (`pnpm audit`) was executed in this pass.
- The full tree is very large (~39k TS files indexed); prioritization focused on `packages/*/src` and `apps/desktop/src`.
