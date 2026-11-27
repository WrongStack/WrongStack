import { writeClipboardText as writeNativeClipboardText } from '@wrongstack/runtime/clipboard';
import { stripAnsi } from './terminal-width.js';

export {
  type ClipboardImage,
  readClipboardImage,
  readClipboardText,
} from '@wrongstack/runtime/clipboard';

/**
 * Longest OSC 52 payload sent. xterm-family terminals drop (or truncate)
 * sequences past roughly 100k base64 characters, and a silently partial copy
 * is worse than a copy that reports failure.
 */
const OSC52_MAX_BASE64 = 100_000;

/**
 * Text as it should reach a clipboard: no ANSI styling from tool output, and
 * no C0 control bytes but tab and line breaks. A NUL ends Windows clipboard
 * text early (everything after it silently vanished), and terminals refuse or
 * cut an OSC 52 payload carrying control bytes.
 */
function clipboardSafeText(text: string): string {
  return stripAnsi(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** The OSC 52 "set clipboard" sequence for `text`, or undefined when it is too long to send. */
function osc52Sequence(text: string): string | undefined {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  return payload.length > OSC52_MAX_BASE64 ? undefined : `\x1b]52;c;${payload}\x07`;
}

interface ClipboardWriteDeps {
  native: (text: string) => Promise<boolean>;
  stdout: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}

/** Why a clipboard write failed. */
export type ClipboardFailureReason =
  /** Native tooling failed AND the cleaned text is over the OSC 52 payload cap. */
  | 'too-large'
  /** Native tooling failed and there is no TTY to ask via OSC 52. */
  | 'unavailable';

/** Outcome of a clipboard write attempt: success, or failure with a reason. */
export type ClipboardWriteOutcome = { ok: true } | { ok: false; reason: ClipboardFailureReason };

/**
 * Copy text for the TUI's copy actions, reporting WHY a failure happened so
 * callers can surface an accurate notice instead of failing silently. The OS
 * clipboard tool first; when there is none that works — an SSH session, a
 * headless Linux box without wl-copy/xclip — the terminal is asked to copy it
 * with OSC 52, which reaches the clipboard of the machine the user is actually
 * sitting at. (Inside tmux that needs `set -g set-clipboard on`.) OSC 52 has
 * no acknowledgement, so a sent sequence counts as copied. Over-cap text is
 * NOT chunked across multiple OSC 52 sequences — terminals reassemble them
 * inconsistently, and a partial copy is worse than a reported failure.
 */
export async function writeClipboardTextOutcome(
  text: string,
  deps: ClipboardWriteDeps = { native: writeNativeClipboardText, stdout: process.stdout },
): Promise<ClipboardWriteOutcome> {
  const clean = clipboardSafeText(text);
  if (await deps.native(clean)) return { ok: true };
  if (!deps.stdout.isTTY) return { ok: false, reason: 'unavailable' };
  const sequence = osc52Sequence(clean);
  if (!sequence) return { ok: false, reason: 'too-large' };
  deps.stdout.write(sequence);
  return { ok: true };
}

/**
 * Copy text for the TUI's copy actions. Boolean wrapper over
 * {@link writeClipboardTextOutcome} for callers that only need success/failure.
 */
export async function writeClipboardText(
  text: string,
  deps: ClipboardWriteDeps = { native: writeNativeClipboardText, stdout: process.stdout },
): Promise<boolean> {
  return (await writeClipboardTextOutcome(text, deps)).ok;
}

/** Approximate raw-text byte cap implied by the base64 limit (base64 is 4:3). */
const OSC52_MAX_TEXT_KB = Math.floor(((OSC52_MAX_BASE64 / 4) * 3) / 1000);

/**
 * User-facing transcript message for a failed copy. Mentions the size limit
 * when that is the cause, so an over-cap failure is not mistaken for a
 * missing clipboard tool.
 */
export function clipboardFailureMessage(reason: ClipboardFailureReason): string {
  return reason === 'too-large'
    ? `Copy failed: the text is over the terminal clipboard size limit (~${OSC52_MAX_TEXT_KB} KB) and no system clipboard tool is available.`
    : 'Copy failed: no system clipboard tool is available and this terminal cannot receive OSC 52.';
}

/** Short one-line variant for transient status notices (composer hint row). */
export function clipboardFailureNotice(reason: ClipboardFailureReason): string {
  return reason === 'too-large'
    ? 'Copy failed: too large for terminal clipboard'
    : 'Copy failed: no clipboard available';
}
