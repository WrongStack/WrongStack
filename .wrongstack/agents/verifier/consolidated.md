## Testing

- Run focused Vitest files from the repository root using root-relative paths (e.g. `pnpm exec vitest run packages/core/tests/...`). The shared Vitest include pattern is `packages/**/tests/**`, so package-relative filters launched from inside a package (e.g. `packages/core`) may report no matching tests.