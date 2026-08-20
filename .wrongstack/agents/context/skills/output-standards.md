## Provider mapping conventions

- Treat `docs/provider-author-guide.md` and `packages/providers/README.md` ("Wire-format adapter (declarative)") as the mandatory entry points when pre-mapping provider work; they define the `WireAdapter` / `WireFormatProvider` / `presets/*.ts` split that every provider file in `packages/providers/src/` follows. Anchor architectural claims in your output to these two docs rather than inferring structure from imports. [applied 14×, 14 ok]
- Never present `packages/providers/src/presets/openai.ts` as the runtime transport for the `openai` wire family. When reporting on that family, state both roles explicitly: the registry factory switch in `packages/providers/src/index.ts` (`case 'openai'`) builds the class-based `OpenAIProvider` from `packages/providers/src/openai.ts`, while the preset is consumed at runtime only by `GitHubCopilotProvider` (`packages/providers/src/github-copilot.ts`, via `super(openaiWireFormat, ...)`). [applied 3×, 3 ok]

## Pitfalls

- Do not use brace-globs (`{a,b}.ts`) in grep in this environment: they silently return zero matches, and a false empty result has led to files being mislabeled as "no handling". Grep by exact file path, or run one grep per file, and record the exact path you checked in the output so the negative claim is auditable. [applied 14×, 14 ok]
