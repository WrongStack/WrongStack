## Pitfalls

- Before editing `parseNextSteps` or `stripNextStepsBlock`, resolve them to their canonical home `@wrongstack/tools/next-steps` — `packages/webui/src/components/NextStepsBar.tsx` only re-exports them for back-compat. A UI-component import path (or a grep hit in the webui tree) does not mean the parser logic lives there or should be edited there; when the parser itself needs changing, check `@wrongstack/tools` first.
