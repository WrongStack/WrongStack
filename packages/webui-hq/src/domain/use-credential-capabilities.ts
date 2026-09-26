/**
 * What this browser's credential may do, read once from `/api/auth/status`.
 *
 * The server is the authority — every command is re-checked there — so this
 * only decides what the UI OFFERS. A control the credential cannot use is
 * worse than an absent one: the mobile login is `control.enqueue`-only by
 * design, and its Allow/Deny buttons answered every tap with a 403.
 *
 * @module domain/use-credential-capabilities
 */
import { useEffect, useState } from 'react';
import { fetchHqCredentialCapabilities } from '../data/auth/index.js';

/**
 * `undefined` while loading and for unrestricted credentials; the helper
 * below treats both as allowed so a slow status read never hides a control.
 */
export function useCredentialCapabilities(): readonly string[] | undefined {
  const [capabilities, setCapabilities] = useState<readonly string[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void fetchHqCredentialCapabilities().then((result) => {
      if (!cancelled) setCapabilities(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return capabilities;
}

export function credentialAllows(
  capabilities: readonly string[] | undefined,
  capability: string,
): boolean {
  return capabilities === undefined || capabilities.includes(capability);
}
