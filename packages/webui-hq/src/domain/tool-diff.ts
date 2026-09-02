/**
 * Whether a tool call carries a renderable file change.
 *
 * Cheap on purpose: no LCS is computed until the diff card actually renders,
 * so a transcript with hundreds of edits does not pay for diffs nobody opens.
 */
import { diffFromToolInput } from '@wrongstack/tools/tool-diff';

export function hasToolDiff(toolName: string | undefined, toolInput: string | undefined): boolean {
  return diffFromToolInput(toolName, toolInput) !== null;
}
