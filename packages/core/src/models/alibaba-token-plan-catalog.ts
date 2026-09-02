/**
 * Offline **floor** for the Alibaba Cloud Model Studio Token Plan (Personal
 * Edition) models, sourced from the official documentation at:
 *   https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview
 *
 * Source-of-truth precedence (live path wins):
 *  1. The curated overlay `packages/cli/data/providers.json` — provider
 *     `alibaba-token-plan` — synced from the official doc + cached + bundled
 *     offline by `DefaultModelsRegistry` (overlayUrl/overlayFile). Editing
 *     that JSON and pushing updates every client without a code release;
 *     this is the authoritative list whenever the registry overlay is wired
 *     (the CLI path).
 *  2. This hardcoded table — the last-resort floor used where no overlay is
 *     available (a standalone registry without the bundled file) and by the
 *     CLI auth-menu login flow, which needs a synchronous id list.
 *
 * Keep this in lockstep with the `alibaba-token-plan` block in
 * `providers.json`; the drift-guard test
 * `packages/cli/tests/alibaba-token-plan-catalog-overlay-sync.test.ts`
 * asserts they agree.
 *
 * ─── Correction context: models.dev vs Token Plan ─────────────────────
 * The models.dev catalog (fetched by DefaultModelsRegistry) reports the
 * FULL Alibaba Cloud Model Studio model inventory — hundreds of models
 * across pay-per-use, legacy snapshots, Team Edition, and Personal Edition.
 * The Token Plan (Personal Edition) is an exact-string allowlist that
 * covers only **11 models** from 5 brands. The following models.dev
 * entries are **NOT in the Personal Edition** and must NOT appear in the
 * provider's model list:
 *
 *  ❌ qwen3.6-plus          Team Edition only
 *  ❌ deepseek-v4-flash      Team Edition only
 *  ❌ deepseek-v3.2          Team Edition only
 *  ❌ qwen-image-2.0         Team Edition only  (Qwen image gen)
 *  ❌ qwen-image-2.0-pro     Team Edition only
 *  ❌ kimi-k2.7-code         Team Edition only (Moonshot AI)
 *  ❌ kimi-k2.6              Team Edition only
 *  ❌ kimi-k2.5              Team Edition only
 *  ❌ glm-5.1                Team Edition only
 *  ❌ glm-5                  Team Edition only
 *  ❌ MiniMax-M2.5           Team Edition only
 *  ❌ qwen3-max              Legacy pay-per-use (not in any Token Plan)
 *  ❌ qwen3.5-plus / flash   Legacy pay-per-use
 *  ❌ qwen3-coder-plus       Legacy pay-per-use
 *  ❌ qwen-long              10M-token model, not in Token Plan
 *  ❌ qwen3-math-plus        Specialised model, not in Token Plan
 *  ❌ qwen3-235b-a22b        Open-weight, pay-per-use
 *  ❌ wan2.7-t2v-turbo       Different Wanx variant, verify availability
 *
 * See packages/cli/data/providers.json for the authoritative model
 * allowlist.
 * ──────────────────────────────────────────────────────────────────────
 */

export interface AlibabaTokenPlanModelMeta {
  /** The wire id sent to the backend (e.g. `qwen3.7-max`). */
  id: string;
  /** Human-readable display name shown in pickers. */
  name: string;
  /** One-line capability blurb. */
  description: string;
  /** Capability tags — which modality/feature this model supports. */
  capabilities: string[];
  /** The recommended / latest model — tagged "(current)" in the official UI. */
  current?: boolean;
  /** Explicit input modality declaration (e.g. image-conditioned video models). */
  inputs?: ReadonlyArray<'text' | 'image'>;
}

/**
 * Token Plan Personal Edition models, newest-first. The first entry is the
 * recommended default (`current`). Order is significant: callers that need a
 * default model id use `ALIBABA_TOKEN_PLAN_MODELS[0]`.
 *
 * Carries DISPLAY metadata only — ids, names, descriptions, capability tags.
 * Context/output limits are deliberately NOT stored here: models.dev publishes
 * a dedicated `alibaba-token-plan` provider entry whose per-model `limit` is
 * the authority, and a hand-transcribed copy here only ever drifts below it.
 *
 * Corresponds to the "Supported models" table on:
 * https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview
 *
 * Last verified: 2026-07-20 (official doc last updated Jul 19, 2026)
 */
export const ALIBABA_TOKEN_PLAN_MODELS: ReadonlyArray<AlibabaTokenPlanModelMeta> = [
  // ── Qwen (flagship) ──────────────────────────────────────────────
  {
    id: 'qwen3.8-max-preview',
    name: 'Qwen3.8 Max Preview',
    description:
      '2.4T-parameter multimodal reasoning — text, image, video, documents. 10% Credits rate during preview. Night discount (22:00-08:00 UTC+8).',
    capabilities: ['reasoning', 'visual-understanding', 'text-generation'],
    current: true,
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    description:
      'Top-tier pure-text reasoning model — strongest in the Qwen3.7 series. 1M context, thinking mode, function calling.',
    capabilities: ['reasoning', 'text-generation'],
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7 Plus',
    description:
      'Balanced flagship — reasoning, visual understanding, text generation. 1M context, built-in tools.',
    capabilities: ['reasoning', 'visual-understanding', 'text-generation'],
  },
  {
    id: 'qwen3.6-flash',
    name: 'Qwen3.6 Flash',
    description:
      'Cost-effective reasoning model — vision + text, 1M context, same context length as flagship at lower cost.',
    capabilities: ['reasoning', 'visual-understanding', 'text-generation'],
  },

  // ── Zhipu AI ──────────────────────────────────────────────────────
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    description:
      'Zhipu AI flagship text-generation model — reasoning, text, 198K context, function calling, structured output.',
    capabilities: ['reasoning', 'text-generation'],
  },

  // ── DeepSeek ──────────────────────────────────────────────────────
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    description: 'Frontier reasoning + text generation model. 1M context, always-thinking mode.',
    capabilities: ['reasoning', 'text-generation'],
  },

  // ── Wanx (image generation) ────────────────────────────────────────
  {
    id: 'wan2.7-image',
    name: 'Wan2.7 Image',
    description: 'Text-to-image generation model by Wanx.',
    capabilities: ['image-generation'],
  },
  {
    id: 'wan2.7-image-pro',
    name: 'Wan2.7 Image Pro',
    description: 'Higher-quality text-to-image generation model by Wanx.',
    capabilities: ['image-generation'],
  },

  // ── HappyHorse (video generation) ─────────────────────────────────
  {
    id: 'happyhorse-1.1-t2v',
    name: 'HappyHorse 1.1 T2V',
    description: 'Text-to-video generation model by HappyHorse.',
    capabilities: ['video-generation'],
  },
  {
    id: 'happyhorse-1.1-i2v',
    name: 'HappyHorse 1.1 I2V',
    description: 'Image-to-video generation model by HappyHorse.',
    capabilities: ['video-generation'],
    inputs: ['text', 'image'],
  },
  {
    id: 'happyhorse-1.1-r2v',
    name: 'HappyHorse 1.1 R2V',
    description: 'Reference-to-video generation model by HappyHorse.',
    capabilities: ['video-generation'],
    inputs: ['text', 'image'],
  },
];

const BY_ID: ReadonlyMap<string, AlibabaTokenPlanModelMeta> = new Map(
  ALIBABA_TOKEN_PLAN_MODELS.map((m) => [m.id, m]),
);

/** Look up the canonical metadata for a Token Plan model id, or `undefined`. */
export function alibabaTokenPlanModelMeta(id: string): AlibabaTokenPlanModelMeta | undefined {
  return BY_ID.get(id);
}
