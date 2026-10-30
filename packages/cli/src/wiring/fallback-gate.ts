/**
 * The fallback gate moved to `@wrongstack/runtime` so the standalone WebUI
 * engine (the desktop app's host) registers the exact same gate as the CLI.
 * Re-exported here to keep the CLI's import sites and tests unchanged.
 */
export { createFallbackGate } from '@wrongstack/runtime';
