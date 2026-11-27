/**
 * BOM-led UTF-16 text, decoded — or null. UTF-16 is full of NUL bytes, so the
 * binary heuristic refused it, yet Windows writes it routinely (Windows
 * PowerShell 5 `>` / `Out-File`, `reg export`, many `.rc` files). The BOM is a
 * declaration, but a binary can also start with FF FE: only an even payload
 * that decodes with no replacement or C0 control characters (besides tab, CR,
 * LF) counts as text.
 */
export function decodeUtf16Text(
  buf: Uint8Array,
): { text: string; encoding: 'utf16le' | 'utf16be' } | null {
  if (buf.length < 2 || buf.length % 2 !== 0) return null;
  const encoding =
    buf[0] === 0xff && buf[1] === 0xfe
      ? 'utf16le'
      : buf[0] === 0xfe && buf[1] === 0xff
        ? 'utf16be'
        : null;
  if (!encoding) return null;
  const text = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-16be').decode(
    buf.subarray(2),
  );
  return /[�\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text) ? null : { text, encoding };
}
