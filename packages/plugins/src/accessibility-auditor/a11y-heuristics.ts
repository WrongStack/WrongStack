/**
 * Regex heuristics behind the accessibility-auditor plugin: the finding
 * types, the tag/attribute patterns and the per-element predicates
 * `auditFile` applies.
 */

export type A11yRule =
  | 'missing-alt'
  | 'missing-input-label'
  | 'low-contrast-placeholder'
  | 'missing-button-text'
  | 'duplicate-id';

export interface A11yFinding {
  file: string;
  line: number;
  rule: A11yRule;
  severity: 'error' | 'warning';
  message: string;
  /**
   * Optional scan limitation. Cross-file labels (e.g. `<Label>` in a
   * sibling component) are invisible to this single-file regex walk.
   */
  note?: string;
}

export const TAG_IMG = /<img\b[^>]*>/gi;
export const TAG_INPUT = /<input\b[^>]*\/?>/gi;
export const TAG_BUTTON = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
export const INPUT_BUTTON = /<input\b[^>]*\btype\s*=\s*["'](submit|button|reset)["'][^>]*\/?>/gi;
// `(?<![-\w])`, not `\b`: a hyphen is a word boundary, so `\bid` also read
// `data-id="…"` as an element id (false duplicate ids, wrong label lookup).
export const ATTR_ID = /(?<![-\w])id\s*=\s*["']([^"']+)["']/gi;
// `(?<![-\w])`, not `\b`, for the same reason as ATTR_ID above: a hyphen is a
// word boundary, so `\balt` also matched `data-alt="…"` (and `data-x-alt=`).
// A data-* attribute is invisible to assistive tech, so treating it as alt
// text silently suppressed the missing-alt error on such an image.
const ATTR_ALT = /(?<![-\w])alt\s*=/i;
// Captures the accessible-name VALUE, not just the attribute's presence: an
// empty `aria-label=""` (or `aria-labelledby=""`, which references nothing)
// names nothing for assistive tech, so mere presence is not a label. Same
// non-empty rule `hasMeaningfulAlt` already applies to `alt`.
const ATTR_ARIA_LABEL = /(?<![-\w])(?:aria-label|aria-labelledby)\s*=\s*["']?([^"'\s>]*)["']?/i;
// Captures the idref VALUE, not just the attribute's presence: an empty
// `aria-describedby=""` references nothing, so it is not a description at
// all. Treating it as one both displaced the error-severity
// `missing-input-label` with a warning and emitted a message claiming the
// element "uses aria-describedby as a description" — false for an empty one.
const ATTR_ARIA_DESCRIBEDBY = /(?<![-\w])aria-describedby\s*=\s*["']?([^"'\s>]*)["']?/i;
// `(?<![-\w])`, not `\b`, for the same reason as ATTR_ID and ATTR_ALT above: a
// hyphen is a word boundary, so `\btitle` also matched `data-title="…"` (and
// `data-x-title=`). A data-* attribute is invisible to assistive tech, so
// treating it as a title suppressed `missing-input-label` and
// `missing-button-text` on inputs, buttons, and input[type=submit].
// Keeps the `(?<![-\w])` guard above AND captures the VALUE: `title` is a
// fallback accessible name, but an empty one supplies no name at all, so
// mere presence is not a label. Same non-empty rule `hasAccessibleName`
// applies to aria-label/aria-labelledby.
const ATTR_TITLE = /(?<![-\w])title\s*=\s*["']?([^"'\s>]*)["']?/i;
// `(?<![-\w])`, not `\b`, for the same reason as ATTR_ID, ATTR_ALT,
// ATTR_TITLE and ATTR_VALUE above: a hyphen is a word boundary, so
// `\bplaceholder` also matched `data-placeholder="…"`. A data-* attribute is
// never rendered, so reporting it as "<input> uses placeholder text" invented
// a finding and stated something false about the element. This is the last
// constant in the module still using a bare `\b`.
// It ALSO captures the VALUE: an empty or whitespace-only `placeholder`
// displays no hint text at all, so counting mere presence as placeholder text
// invented a second finding. Same non-empty rule hasAccessibleName,
// hasTitleName and hasButtonValue apply to the other name-like attributes.
const ATTR_PLACEHOLDER = /(?<![-\w])placeholder\s*=\s*["']?([^"'\s>]*)["']?/i;
// `(?<![-\w])`, not `\b`, for the same reason as ATTR_ID, ATTR_ALT and
// ATTR_TITLE above: a hyphen is a word boundary, so `\bvalue` also matched
// `data-value="…"` (and `data-x-value=`). For input[type=submit|button|reset]
// the `value` attribute IS the accessible name, and a data-* attribute is
// invisible to assistive tech, so this suppressed the error-severity
// `missing-button-text` finding on such a control.
// Keeps the `(?<![-\w])` guard from round 43 AND captures the VALUE: for
// input[type=submit|button|reset] the `value` attribute is the button's label,
// so `value=""` renders an UNLABELLED control. The finding below says the
// element "is missing value/aria-label/title" — an empty value is exactly a
// missing value, so treating mere presence as a value suppressed the finding
// the rule itself asks for. Same non-empty rule hasAccessibleName and
// hasTitleName apply to the other two accepted attributes.
const ATTR_VALUE = /(?<![-\w])value\s*=\s*["']?([^"'\s>]*)["']?/i;
const ATTR_ROLE_DECORATIVE = /(?<![-\w])role\s*=\s*["'](?:presentation|none)["']/i;
export const LABEL_SPAN = /<label\b[^>]*>[\s\S]*?<\/label>/gi;
export const FIELDSET_SPAN = /<fieldset\b[^>]*>[\s\S]*?<\/fieldset>/gi;
export const SINGLE_FILE_LABEL_NOTE =
  'Single-file heuristic: a label declared in a sibling component file is not visible to this scan.';

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Half-open [start, end) offsets of one open/close tag pair in the file. */
export interface TagSpan {
  start: number;
  end: number;
}

export function collectSpans(content: string, re: RegExp): TagSpan[] {
  return [...content.matchAll(re)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

export function isInsideSpan(spans: readonly TagSpan[], offset: number): boolean {
  return spans.some((s) => offset > s.start && offset < s.end);
}

export function hasMeaningfulAlt(tag: string): boolean {
  const m = ATTR_ALT.exec(tag);
  ATTR_ALT.lastIndex = 0;
  if (!m) return false;
  // Same `(?<![-\w])` guard as ATTR_ALT: this re-reads the value, so it must
  // not pick up a `data-alt`/`data-x-alt` value either.
  const valMatch = tag.match(/(?<![-\w])alt\s*=\s*["']?([^"'\s>]*)["']?/i);
  const alt = valMatch ? valMatch[1]!.trim() : '';
  if (alt.length > 0) return true;
  // Decorative images: empty alt plus an explicit role hint is enough.
  return ATTR_ROLE_DECORATIVE.test(tag);
}

export function hasAccessibleName(tag: string): boolean {
  const m = ATTR_ARIA_LABEL.exec(tag);
  ATTR_ARIA_LABEL.lastIndex = 0;
  if (!m) return false;
  // Read the VALUE, not just the presence: `aria-label=""` and
  // `aria-labelledby=""` give assistive tech no name at all, so an element
  // carrying one still has no accessible name and must be reported.
  return m[1]!.trim().length > 0;
}

export function hasTitleName(tag: string): boolean {
  const m = ATTR_TITLE.exec(tag);
  ATTR_TITLE.lastIndex = 0;
  if (!m) return false;
  // `title` is a FALLBACK accessible name, so the same non-empty rule applies:
  // `title=""` / `title="   "` leaves assistive tech with no name at all.
  return m[1]!.trim().length > 0;
}

export function hasButtonValue(tag: string): boolean {
  const m = ATTR_VALUE.exec(tag);
  ATTR_VALUE.lastIndex = 0;
  if (!m) return false;
  // For input[type=submit|button|reset] the value attribute IS the label, so
  // `value=""` renders an unlabelled control. The caller reports it as
  // "missing value/aria-label/title" — which an empty value satisfies not at all.
  return m[1]!.trim().length > 0;
}

export function hasDescriptionRef(tag: string): boolean {
  const m = ATTR_ARIA_DESCRIBEDBY.exec(tag);
  ATTR_ARIA_DESCRIBEDBY.lastIndex = 0;
  if (!m) return false;
  // An empty idref list describes nothing, so it is not a supplementary
  // description either. The caller falls through to `missing-input-label`.
  return m[1]!.trim().length > 0;
}

export function hasPlaceholderText(tag: string): boolean {
  const m = ATTR_PLACEHOLDER.exec(tag);
  ATTR_PLACEHOLDER.lastIndex = 0;
  if (!m) return false;
  // An empty or whitespace-only `placeholder` displays no hint text, so it is
  // not the placeholder-as-label signal this rule is looking for.
  return m[1]!.trim().length > 0;
}

export function hasFieldsetLegendLabel(
  tag: string,
  content: string,
  fieldsetSpans: readonly TagSpan[],
  inputStart: number,
): boolean {
  const labelledBy = tag.match(/\baria-labelledby\s*=\s*["']([^"']+)["']/i);
  if (labelledBy?.[1]) {
    for (const id of labelledBy[1].split(/\s+/).filter(Boolean)) {
      const idRe = new RegExp(`(?<![-\\w])id\\s*=\\s*["']${escapeRegExp(id)}["']`, 'i');
      if (idRe.test(content)) return true;
    }
  }
  const typeMatch = tag.match(/\btype\s*=\s*["']?([^"'\s>]*)["']?/i);
  const type = typeMatch ? typeMatch[1]!.toLowerCase() : 'text';
  if (type === 'checkbox' || type === 'radio') {
    // Per-element containment: THIS input sits inside a fieldset whose
    // <legend> closes before the input starts. The previous content-wide
    // regex accepted any fieldset/legend/input sequence anywhere in the
    // file, letting an unrelated legend label every checkbox/radio in it.
    return fieldsetSpans.some(
      (s) =>
        inputStart > s.start &&
        inputStart < s.end &&
        /<legend\b[\s\S]*?<\/legend>/i.test(content.slice(s.start, inputStart)),
    );
  }
  return false;
}
