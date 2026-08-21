## Provider mapping

- Map provider work only from `docs/provider-author-guide.md` and `packages/providers/README.md` ("Wire-format adapter (declarative)") — together they define the `WireAdapter` / `WireFormatProvider` / `presets/*.ts` split that every file in `packages/providers/src/` follows. Anchor architectural claims to these two docs; never infer structure from imports alone. [applied 14×, 14 ok]
- For the `openai` wire family, always state both roles explicitly: the registry switch in `packages/providers/src/index.ts` (`case 'openai'`) builds the class-based `OpenAIProvider` from `packages/providers/src/openai.ts`, while `packages/providers/src/presets/openai.ts` is consumed at runtime only by `GitHubCopilotProvider` (`packages/providers/src/github-copilot.ts`, via `super(openaiWireFormat, ...)`). Never present the preset as the runtime transport. [applied 3×, 3 ok]

## Verification

- Never brace-glob in grep (`{a,b}.ts`): it silently returns zero matches in this environment, and such false empties have led to files being mislabeled as "no handling". Run one grep per exact file path and record each path you checked in the output, so every negative claim is auditable. [applied 14×, 14 ok]
- Treat `reports/*.md` as standalone audit documents with no code exports or programmatic callers; before editing one, re-verify its evidence claims (counts, file paths) with a fresh search rather than assuming they are current. [applied 2×, 2 ok]
