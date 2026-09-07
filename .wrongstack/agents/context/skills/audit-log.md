## Pitfalls

- Before editing `parseNextSteps` or `stripNextStepsBlock`, resolve them to their canonical home `@wrongstack/tools/next-steps` — `packages/webui/src/components/NextStepsBar.tsx` only re-exports them for back-compat. A UI-component import path (or a grep hit in the webui tree) does not mean the parser logic lives there or should be edited there; when the parser itself needs changing, check `@wrongstack/tools` first.

- When auditing provider-config wiring, always grep for callers of `resolveProviderCfg` / `resolveProviderCfgWithProxy` / `buildProviderForId` across `packages/cli/src/wiring/*.ts` and `packages/cli/src/cli-main.ts` — the file's own JSDoc names three historical drift sites (`provider.ts:setupProvider`, `provider-runtime.ts:resolveProviderCfg`, `packages/runtime/src/fleet/light-subagent-factory.ts:buildProvider`) and any new hand-copied merge in the same monorepo is a regression risk. ``` ``` (anchors: `resolveProviderCfg`, `resolveProviderCfgWithProxy`, `buildProviderForId`, `packages/cli/src/wiring/*.ts`, `packages/cli/src/cli-main.ts`, `provider.ts:setupProvider`, `provider-runtime.ts:resolveProviderCfg`, `packages/runtime/src/fleet/light-subagent-factory.ts:buildProvider`, `packages/runtime/src/fleet/light-subagent-factory.ts`) [applied 13×, 13 ok]

---
*Distilled 2026-09-07T21:54:17.226Z · 1 new directive*
