/**
 * Runtime-validated mirror of the models.dev/api.json schema.
 *
 * ME-1 (Model Editor board): one zod schema pair shared by config-loader
 * validation, WS payloads, WebUI forms, and TUI validation. The static type
 * mirror lives in `../types/models-registry.js` (ModelsDevModel /
 * ModelsDevProvider); the compile-time assertion at the bottom of this file
 * keeps parsed schema output assignable to the static mirror.
 *
 * Passthrough policy: models.dev keeps adding fields (`limit.input`,
 * `cost.tiers`, `reasoning_options` are recent examples), so every object
 * schema below is LOOSE — unknown keys are accepted and preserved, never
 * stripped or rejected. Known keys are type-checked; unknown ones pass.
 *
 * Modalities are plain string arrays upstream ("text" | "image" | "audio" |
 * "video" | "pdf" observed in the 2026-08-03 census). The schema validates
 * "array of non-empty strings" rather than a closed enum so new upstream
 * modality values don't break parsing; MODELS_DEV_MODALITY_VALUES documents
 * the known set for UI/editor use.
 */
import { z } from 'zod';
import type { ModelsDevModel, ModelsDevProvider } from '../types/models-registry.js';
import { FORBIDDEN_PROTO_KEYS } from '../utils/deep-merge.js';

/**
 * In a browser, tell zod not to compile validators before building any.
 *
 * Zod's fast path assembles validators with `new Function`, and probes for
 * that capability the first time an object schema is constructed. The WebUI
 * and SimpleUI are served under `script-src 'self' 'wasm-unsafe-eval'`
 * (`buildCspHeader`), so the probe is guaranteed to fail there: zod catches
 * the throw and falls back to its interpreted path, but the browser still
 * reports a blocked eval on every page load — from the app's OWN bundle,
 * which is exactly the report you do not want to teach people to ignore.
 *
 * This is the only zod schema that reaches the browser bundle, and the flag
 * has to be set before the first schema below is constructed, so it lives
 * here rather than at an entry point where module evaluation order would
 * decide whether it took effect.
 *
 * Node is untouched and keeps the compiled fast path: the constraint belongs
 * to the page's CSP, not to the schema. The check is `'document' in
 * globalThis` rather than `typeof document` because core compiles without the
 * DOM lib.
 */
if ('document' in globalThis) z.config({ jitless: true });

/** Known values observed in models.dev modality arrays (2026-08-03 census). */
export const MODELS_DEV_MODALITY_VALUES = ['text', 'image', 'audio', 'video', 'pdf'] as const;

/**
 * Mirrors `ReasoningEffort` in `../types/provider.js`. Kept as a runtime
 * literal list because zod needs values, not types — see the sync note in
 * `reasoningOptionSchema` below.
 */
const REASONING_EFFORT_LITERALS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const nonNegativeInt = z.number().int().nonnegative();
const finiteNumber = z.number().finite();

/** `limit` — context/output on every model; `input` on a subset. 0 is valid. */
export const modelsDevLimitSchema = z.looseObject({
  context: nonNegativeInt.optional(),
  output: nonNegativeInt.optional(),
  input: nonNegativeInt.optional(),
});

/**
 * `cost` — USD per 1M tokens upstream. Known numeric keys are validated;
 * non-numeric additions like `tiers` (observed on ~300 models) pass through
 * untouched via the loose object.
 */
export const modelsDevCostSchema = z.looseObject({
  input: finiteNumber.optional(),
  output: finiteNumber.optional(),
  cache_read: finiteNumber.optional(),
  cache_write: finiteNumber.optional(),
  cache_write_5m: finiteNumber.optional(),
  cache_write_1h: finiteNumber.optional(),
  context_over_200k: finiteNumber.optional(),
  reasoning: finiteNumber.optional(),
  input_audio: finiteNumber.optional(),
  output_audio: finiteNumber.optional(),
});

/** `modalities` — plain string arrays; new values accepted (see file docs). */
export const modelsDevModalitiesSchema = z.looseObject({
  input: z.array(z.string().min(1)).optional(),
  output: z.array(z.string().min(1)).optional(),
});

const reasoningOptionSchema = z.union([
  z.looseObject({ type: z.literal('toggle') }),
  z.looseObject({
    type: z.literal('effort'),
    // Closed on purpose: effort literals are a runtime concept consumed via
    // ReasoningEffort (types/provider.ts). Keep this list in sync with that
    // union — a new upstream literal should update BOTH deliberately (the
    // compile-time sync proof below is designed to fail loudly on drift).
    values: z.array(z.enum(REASONING_EFFORT_LITERALS)).optional(),
  }),
  z.looseObject({
    type: z.literal('budget_tokens'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
]);

const protoKeyRefinement = (label: string) => ({
  message: `${label} id is a forbidden prototype-pollution key`,
});

/** One models.dev model entry (values of `provider.models`). */
export const modelsDevModelSchema = z.looseObject({
  id: z
    .string()
    .min(1)
    .refine((id) => !FORBIDDEN_PROTO_KEYS.has(id), protoKeyRefinement('Model')),
  name: z.string().min(1),
  description: z.string().optional(),
  family: z.string().optional(),
  attachment: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.union([reasoningOptionSchema, z.array(reasoningOptionSchema)]).optional(),
  interleaved: z.union([z.boolean(), z.looseObject({ field: z.string().optional() })]).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  knowledge: z.string().optional(),
  release_date: z.string().optional(),
  last_updated: z.string().optional(),
  open_weights: z.boolean().optional(),
  modalities: modelsDevModalitiesSchema.optional(),
  cost: modelsDevCostSchema.optional(),
  limit: modelsDevLimitSchema.optional(),
  status: z.string().optional(),
  experimental: z.boolean().optional(),
});

/** One models.dev provider entry (top-level values of api.json). */
export const modelsDevProviderSchema = z.looseObject({
  id: z
    .string()
    .min(1)
    .refine((id) => !FORBIDDEN_PROTO_KEYS.has(id), protoKeyRefinement('Provider')),
  name: z.string().min(1),
  env: z.array(z.string()).optional(),
  npm: z.string().optional(),
  api: z.string().optional(),
  doc: z.string().optional(),
  models: z.record(z.string(), modelsDevModelSchema),
});

/** The whole api.json payload: provider id → provider entry. */
export const modelsDevPayloadSchema = z.record(z.string(), modelsDevProviderSchema);

export type ModelsDevModelParsed = z.infer<typeof modelsDevModelSchema>;
export type ModelsDevProviderParsed = z.infer<typeof modelsDevProviderSchema>;
export type ModelsDevPayloadParsed = z.infer<typeof modelsDevPayloadSchema>;

// ---------------------------------------------------------------------------
// Compile-time sync proof: schema-parsed output must stay assignable to the
// static ModelsDevModel/ModelsDevProvider mirror. If a schema edit breaks
// this constraint, the build fails here — fix the schema (or the mirror)
// deliberately instead of loosening this check.
// ---------------------------------------------------------------------------
type AssertAssignableTo<T, U extends T> = U;
type ModelSchemaSyncCheck = AssertAssignableTo<ModelsDevModel, ModelsDevModelParsed>;
type ProviderSchemaSyncCheck = AssertAssignableTo<ModelsDevProvider, ModelsDevProviderParsed>;
// Referenced so the aliases are never reported as unused.
export type ModelsDevSchemaSyncProof = [ModelSchemaSyncCheck, ProviderSchemaSyncCheck];
