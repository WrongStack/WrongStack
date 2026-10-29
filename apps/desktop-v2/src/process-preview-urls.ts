const MAX_URLS = 5;
// ANSI colour/cursor sequences dev servers print around their URLs.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const LOCAL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d{1,5})?(?:\/[^\s'"<>)\]]*)?/gi;

/**
 * Local preview URLs a process printed (dev servers announce "http://localhost:5173"), newest
 * first and without duplicates. `0.0.0.0` (listen on all interfaces) is offered as localhost,
 * since the preview window only opens loopback hosts. Ports outside 1–65535 are dropped.
 */
export function processPreviewUrls(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of [...lines].reverse()) {
    const matches = line.replace(ANSI, '').match(LOCAL) ?? [];
    for (const raw of matches.reverse()) {
      let url: URL;
      try {
        url = new URL(raw.replace(/[.,;:]+$/, ''));
      } catch {
        continue;
      }
      if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
      if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) continue;
      const text = url.href;
      if (!found.includes(text)) found.push(text);
      if (found.length === MAX_URLS) return found;
    }
  }
  return found;
}
