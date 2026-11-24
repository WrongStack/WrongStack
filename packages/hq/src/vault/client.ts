/**
 * Device-side half of the HQ key vault protocol: build an enrollment request,
 * check HQ's answer and pin its identity, sign fetch requests, verify and open
 * bundles. Pure functions — storage of the device keys and the pinned HQ
 * identity belongs to the client service that calls these.
 */
import {
  type HqVaultKeyPair,
  hqVaultEnrollmentMac,
  hqVaultEnrollmentMacMatches,
  hqVaultFingerprint,
  hqVaultKeyId,
  hqVaultOpen,
  hqVaultRandom,
  hqVaultSign,
  hqVaultVerify,
  isHqVaultKeyString,
} from './crypto.js';
import {
  HQ_VAULT_BUNDLE_PURPOSE,
  HQ_VAULT_FETCH_PURPOSE,
  type HqVaultBundle,
  type HqVaultBundleItem,
  type HqVaultEnrollRequest,
  type HqVaultEnrollResponse,
  type HqVaultFetchMode,
  type HqVaultFetchRequest,
  type HqVaultIdentity,
  hqVaultItemAad,
  parseHqVaultEnrollmentToken,
} from './protocol.js';

export class HqVaultClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HqVaultClientError';
  }
}

/** Build an enrollment request from the token the operator copied out of HQ. */
export function buildHqVaultEnrollRequest(
  keys: HqVaultKeyPair,
  enrollmentToken: string,
  info: { hostname: string; label?: string },
): { request: HqVaultEnrollRequest; code: string } {
  const parsed = parseHqVaultEnrollmentToken(enrollmentToken);
  if (!parsed) throw new HqVaultClientError('That is not an HQ enrollment token.');
  const body = {
    v: 1 as const,
    codeId: parsed.codeId,
    device: {
      encPublic: keys.encPublic,
      signPublic: keys.signPublic,
      hostname: info.hostname,
      ...(info.label ? { label: info.label } : {}),
    },
    nonce: hqVaultRandom(24),
  };
  return { request: { ...body, mac: hqVaultEnrollmentMac(parsed.code, body) }, code: parsed.code };
}

/**
 * Check HQ's enrollment answer: the MAC proves it came from whoever minted the
 * code, the nonce that it answers THIS request, the device id that HQ
 * registered THESE keys. Returns the HQ identity to pin.
 */
export function verifyHqVaultEnrollResponse(
  response: HqVaultEnrollResponse,
  request: HqVaultEnrollRequest,
  code: string,
): HqVaultIdentity {
  const { mac, ...body } = response;
  if (!hqVaultEnrollmentMacMatches(code, body, mac)) {
    throw new HqVaultClientError(
      'HQ enrollment answer failed verification (wrong code, or tampered).',
    );
  }
  if (response.nonce !== request.nonce) {
    throw new HqVaultClientError('HQ enrollment answer does not match this request.');
  }
  if (response.deviceId !== hqVaultKeyId(request.device)) {
    throw new HqVaultClientError('HQ registered a different device id than these keys produce.');
  }
  const hq = response.hq;
  if (!hq || !isHqVaultKeyString(hq.encPublic) || !isHqVaultKeyString(hq.signPublic)) {
    throw new HqVaultClientError('HQ enrollment answer carries no usable identity.');
  }
  if (hq.hqId !== hqVaultKeyId(hq) || hq.fingerprint !== hqVaultFingerprint(hq)) {
    throw new HqVaultClientError('HQ identity is inconsistent.');
  }
  return {
    hqId: hq.hqId,
    encPublic: hq.encPublic,
    signPublic: hq.signPublic,
    fingerprint: hq.fingerprint,
  };
}

/** Sign a fetch request as this device. */
export function buildHqVaultFetchRequest(
  keys: HqVaultKeyPair,
  options: { mode: HqVaultFetchMode; secretIds?: string[]; now?: number },
): HqVaultFetchRequest {
  const body = {
    v: 1 as const,
    deviceId: hqVaultKeyId(keys),
    ts: new Date(options.now ?? Date.now()).toISOString(),
    nonce: hqVaultRandom(24),
    mode: options.mode,
    ...(options.secretIds ? { secretIds: [...options.secretIds] } : {}),
  };
  return { ...body, sig: hqVaultSign({ ...body, purpose: HQ_VAULT_FETCH_PURPOSE }, keys) };
}

export interface HqVaultOpenedItem extends Omit<HqVaultBundleItem, 'sealed'> {
  apiKey?: string;
}

/**
 * Verify a bundle against the pinned HQ identity and the request it answers,
 * then open every sealed value. Throws on any mismatch — a bundle that does not
 * verify is discarded whole, never partially imported.
 */
export function openHqVaultBundle(
  bundle: HqVaultBundle,
  keys: HqVaultKeyPair,
  pinned: HqVaultIdentity,
  request: HqVaultFetchRequest,
): HqVaultOpenedItem[] {
  const { sig, ...body } = bundle;
  if (!hqVaultVerify({ ...body, purpose: HQ_VAULT_BUNDLE_PURPOSE }, sig, pinned.signPublic)) {
    throw new HqVaultClientError('Bundle signature does not match the pinned HQ identity.');
  }
  const deviceId = hqVaultKeyId(keys);
  if (bundle.hqId !== pinned.hqId || bundle.deviceId !== deviceId) {
    throw new HqVaultClientError('Bundle is addressed to a different HQ or device.');
  }
  if (bundle.requestNonce !== request.nonce || bundle.mode !== request.mode) {
    throw new HqVaultClientError('Bundle does not answer this request.');
  }
  if (!Array.isArray(bundle.items)) throw new HqVaultClientError('Bundle is malformed.');
  return bundle.items.map((item) => {
    const { sealed, ...meta } = item;
    if (sealed === undefined) return meta;
    const parsed = JSON.parse(hqVaultOpen(sealed, keys, hqVaultItemAad({ deviceId, ...item }))) as {
      apiKey?: unknown;
    };
    if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) {
      throw new HqVaultClientError(`Bundle item ${item.secretId} has no key.`);
    }
    return { ...meta, apiKey: parsed.apiKey };
  });
}
