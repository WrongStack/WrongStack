/**
 * HQ network-exposure guard.
 *
 * HQ binds to all interfaces by default so a fleet dashboard is reachable
 * from a phone or a second machine. That default is only safe because a
 * first run mints random browser + client tokens.
 *
 * The hole it leaves is the *open mode* an operator can configure by hand:
 * with no browser tokens and no password, `hq-server` skips its 401 branch
 * entirely — including on `POST /api/command`, which enqueues commands into
 * live sessions. Open mode was tolerable while HQ was loopback-only; paired
 * with a non-loopback bind it is unauthenticated remote command execution
 * reachable by any peer on the network.
 *
 * So: refuse that one combination, and warn about the merely-unencrypted
 * ones. Nothing here changes the default bind — it guards the case where the
 * default silently turns a local-only setup into a public one.
 */

/**
 * The bind the HQ *CLI* surfaces choose on purpose: HQ is the deliberate
 * cross-machine surface, so `wstack hq` and the launch menu reach every
 * interface without an extra flag.
 *
 * This deliberately does not live in `startHqServer`'s default. A caller
 * that never mentions a host — a test, an embedder — has not asked to be
 * published to its network, and that library default stays loopback. Keep
 * the two apart: collapsing them is what turns "HQ is reachable from my
 * phone" into "every embedder silently binds 0.0.0.0".
 */
import { isIP } from 'node:net';

export const HQ_CLI_DEFAULT_HOST = '0.0.0.0';

/**
 * Thrown when the bind host and the auth configuration combine into an
 * unauthenticated, network-reachable HQ.
 *
 * Lives here rather than beside the server so callers can identify it
 * without importing (or successfully mocking) the whole hq-server module.
 */
export class HqInsecureExposureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HqInsecureExposureError';
  }
}

export interface HqExposureInput {
  /** Host HQ is about to bind. */
  host: string;
  /** At least one browser token is configured. */
  hasBrowserTokens: boolean;
  /** A browser password hash is configured. */
  hasPassword: boolean;
  /** Operator opt-in that downgrades a refusal to a warning. */
  allowInsecure?: boolean | undefined;
}

export type HqExposureVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; message: string }
  | { kind: 'refuse'; message: string };

/** Hosts that cannot receive traffic from another machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (normalized === 'localhost') return true;
  // Use Node's authoritative IP parser instead of a regex. A regex can
  // accept syntactically-valid-but-semantically-wrong strings (e.g.
  // leading zeros, shorthand IPv6) that net.isIP() rejects, and can
  // miss valid forms (IPv4-mapped IPv6 loopback ::ffff:127.0.0.1).
  const family = isIP(normalized);
  if (family === 4) {
    // The entire 127.0.0.0/8 block is loopback, not just 127.0.0.1.
    return normalized.startsWith('127.');
  }
  if (family === 6) {
    // ::1 is the IPv6 loopback address. Also accept the IPv4-mapped
    // form ::ffff:127.x.x.x which resolves to loopback on dual-stack.
    return normalized === '::1' || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
  }
  return false;
}

/** True when HQ would serve every request unauthenticated. Mirrors the
 *  `(inBrowserTokenMode || inPasswordMode) && !auth` gate in hq-server. */
export function isOpenMode(
  input: Pick<HqExposureInput, 'hasBrowserTokens' | 'hasPassword'>,
): boolean {
  return !input.hasBrowserTokens && !input.hasPassword;
}

export function assessHqExposure(input: HqExposureInput): HqExposureVerdict {
  if (isLoopbackHost(input.host)) return { kind: 'ok' };

  if (isOpenMode(input)) {
    const detail =
      `HQ is configured in open mode (no browser tokens and no password), so every ` +
      `request — including POST /api/command, which runs commands in your live ` +
      `sessions — is served unauthenticated. Binding that to ${input.host} exposes it ` +
      `to every peer on the network.`;
    if (input.allowInsecure) {
      return {
        kind: 'warn',
        message: `${detail} Continuing because --insecure-open was passed.`,
      };
    }
    return {
      kind: 'refuse',
      message:
        `${detail}\n\nFix one of these, then retry:\n` +
        `  • bind locally:        wstack hq --host 127.0.0.1\n` +
        `  • mint a token:        wstack hq token create\n` +
        `  • set a password:      wstack hq --password <value>\n` +
        `  • accept the risk:     wstack hq --insecure-open`,
    };
  }

  // Authenticated, but the token still crosses the network in cleartext and
  // rides in the URL query — worth saying out loud once at startup.
  return {
    kind: 'warn',
    message:
      `HQ is bound to ${input.host} (all interfaces) without TLS. Access tokens ` +
      `travel in cleartext and appear in the URL query. Prefer --host 127.0.0.1 ` +
      `unless you intend HQ to be reachable from other machines.`,
  };
}
