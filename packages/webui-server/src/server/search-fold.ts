/**
 * Lowercase without moving any code-unit offset, so an index found in the folded text is the
 * same index in the original. `toLowerCase()` is not length-preserving: `İ` (U+0130) becomes
 * `i` + U+0307, and a match index taken from it lands right of the match in the original text.
 * `İ` keeps its base letter (as the TUI's transcript search does), so `istanbul` also finds
 * `İstanbul`; every other character keeps its whole-string lowercase (final sigma included).
 */
export function foldCaseSameLength(text: string): string {
  const whole = text.toLowerCase();
  if (whole.length === text.length) return whole;
  // U+0130 is the only code unit whose lowercase is longer; nothing gets shorter.
  let out = '';
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    out += whole[at];
    at += text.charCodeAt(i) === 0x130 ? 2 : 1;
  }
  if (at === whole.length) return out;
  // A runtime with other expanding mappings: fold per code point instead.
  out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : lower.slice(0, ch.length);
  }
  return out;
}
