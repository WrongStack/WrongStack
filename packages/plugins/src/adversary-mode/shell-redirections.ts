/** Where a redirection target ends: the next blank, separator or closer. */
const REDIRECT_END = String.raw`(?=$|[\s;&|)])`;
/** `2>&1`, `>&2`, `>&-`: duplicating or closing a descriptor writes no file. */
const FD_DUPLICATION = new RegExp(String.raw`\d*>&\s*(?:\d+|-)${REDIRECT_END}`, 'g');
/**
 * Redirection into the null device. The target must END there:
 * `> /dev/null/../x` names something else.
 */
const NULL_DEVICE = new RegExp(String.raw`(?:\d*|&)>>?\s*\/dev\/null${REDIRECT_END}`, 'g');
/**
 * PowerShell's null devices, `$null` and `nul`. In a POSIX shell both are
 * ordinary names: `$null` a variable, `nul` a file that `ln -s` can point at
 * the policy.
 */
const PWSH_NULL = new RegExp(String.raw`(?:\d*|\*)>>?\s*(?:\$null|nul)${REDIRECT_END}`, 'gi');

/**
 * The line with the redirections that cannot write a file removed, so the
 * everyday `2>/dev/null`, `2>&1`, `>&2` and pwsh `2>$null` stop reading as
 * a write. Every `>` used to: a READ of the policy
 * (`cat .wrongstack/adversary.md 2>/dev/null`) was refused as tampering,
 * with "do not retry", even while the plugin was dormant.
 */
export function withoutHarmlessRedirections(line: string, pwsh: boolean): string {
  const out = line.replace(FD_DUPLICATION, ' ').replace(NULL_DEVICE, ' ');
  return pwsh ? out.replace(PWSH_NULL, ' ') : out;
}
