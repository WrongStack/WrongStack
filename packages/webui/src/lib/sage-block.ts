/**
 * sage-block — WebUI view over the canonical SAGE suffix splitter.
 *
 * The SAGE Memory Injector middleware (`packages/sage/src/middleware/tool-call-memory.ts`)
 * appends a `--- SAGE: ... ---` block to `payload.result.content` after the
 * normal tool output. The WebUI `ToolResult` renderer surfaces that block as a
 * separate bordered card instead of letting it leak into the body.
 *
 * ALL parsing logic (headings, memory-line regexes, block walk, truncation
 * recovery) lives in ONE place: `@wrongstack/core/utils/sage-output-block`
 * (`packages/core/src/utils/sage-output-block.ts`). This module is a thin
 * adapter that keeps the historical `SageSplit` / `extractSageBlock` surface
 * (with `cleanOutput`) so existing WebUI consumers don't churn. The TUI
 * (`packages/tui/src/components/history/sage-output-format.ts`) delegates to
 * the same canonical module — see `verify-sage-all-tools.test.ts` and
 * `tests/lib/sage-block.test.ts` for the behavioral lock.
 */
import {
  SAGE_INJECTOR_HEADINGS,
  splitSageOutputBlock,
  type SageOutputSplit,
} from '@wrongstack/core/utils/sage-output-block';

export { SAGE_INJECTOR_HEADINGS };

export interface SageSplit {
  /** Tool result text with the SAGE block removed (trailing whitespace trimmed). */
  cleanOutput: string;
  /**
   * Extracted SAGE block lines including the `--- SAGE:` header. Empty when
   * the input contains no terminal SAGE suffix.
   */
  sageLines: string[];
}

/**
 * Find the last SAGE-injector suffix in `output` and split it away from the
 * normal tool text. Behaviour is the canonical `splitSageOutputBlock` from
 * `@wrongstack/core/utils/sage-output-block` (property names preserved for
 * WebUI callers).
 */
export function extractSageBlock(output: string): SageSplit {
  const { body, sageLines } = splitSageOutputBlock(output);
  return { cleanOutput: body, sageLines };
}

export type { SageOutputSplit };
