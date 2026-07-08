// Thin re-export: the tool-input summarizer now lives in @wrongstack/tools as
// the single source of truth shared by the WebUI (this module) and the HQ
// dashboard. Keeping this local path lets existing imports (`@/lib/tool-summary`)
// keep working unchanged while the implementation is deduplicated.
//
// See packages/tools/src/tool-summary.ts. To change summary behavior, edit
// there — a parity test guarantees the HQ browser transcription stays in sync.

export { FALLBACK_HEAD_FIELDS, summarizeToolInput } from '@wrongstack/tools/tool-summary';
