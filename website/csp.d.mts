/** Inline `<script>` bodies in document order — those without a `src`. */
export function inlineScripts(html: string): string[];

/** CSP `'sha256-…'` source expression for one inline script body. */
export function scriptHash(body: string): string;

/** The full policy string for the given built HTML. */
export function websiteCsp(html: string): string;

/** The HTML with a `<meta http-equiv="Content-Security-Policy">` after `<head>`. */
export function injectWebsiteCsp(html: string): string;
