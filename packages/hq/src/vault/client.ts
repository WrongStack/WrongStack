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
  HQ_VAULT_REVOKED_PURPOSE,
  type HqVaultBundle,
  type HqVaultBundleKey,
  type HqVaultBundleProfile,
  type HqVaultEnrollRequest,
  type HqVaultEnrollResponse,
  type HqVaultFetchMode,
  type HqVaultFetchRequest,
  type HqVaultIdentity,
  type HqVaultRevocation,
  type HqVaultSealedKeyFields,
  hqVaultKeyAad,
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
  options: { mode: HqVaultFetchMode; profileIds?: string[]; now?: number },
): HqVaultFetchRequest {
  const body = {
    v: 2 as const,
    deviceId: hqVaultKeyId(keys),
    ts: new Date(options.now ?? Date.now()).toISOString(),
    nonce: hqVaultRandom(24),
    mode: options.mode,
    ...(options.profileIds ? { profileIds: [...options.profileIds] } : {}),
  };
  return { ...body, sig: hqVaultSign({ ...body, purpose: HQ_VAULT_FETCH_PURPOSE }, keys) };
}

export interface HqVaultOpenedKey extends Omit<HqVaultBundleKey, 'sealed'> {
  /** Present after a `fetch`; absent in `list` mode. */
  secrets?: HqVaultSealedKeyFields;
}

export interface HqVaultOpenedProfile extends Omit<HqVaultBundleProfile, 'keys'> {
  keys: HqVaultOpenedKey[];
}

/**
 * Verify a bundle against the pinned HQ identity and the request it answers,
 * then open every sealed key. Throws on any mismatch — a bundle that does not
 * verify is discarded whole, never partially imported.
 */
export function openHqVaultBundle(
  bundle: HqVaultBundle,
  keys: HqVaultKeyPair,
  pinned: HqVaultIdentity,
  request: HqVaultFetchRequest,
): HqVaultOpenedProfile[] {
  const { sig, ...body } = bundle;
  if (!hqVaultVerify({ ...body, purpose: HQ_VAULT_BUNDLE_PURPOSE }, sig, pinned.signPublic)) {
    throw new HqVaultClientError('Bundle signature does not match the pinned HQ identity.');
  }
  const deviceId = hqVaultKeyId(keys);
  if (bundle.hqId !== pinned.hqId || bundle.deviceId !== deviceId) {
    throw new HqVaultClientError('Bundle is addressed to a different HQ or device.');
  }
  if (bundle.v !== 2 || bundle.requestNonce !== request.nonce || bundle.mode !== request.mode) {
    throw new HqVaultClientError('Bundle does not answer this request.');
  }
  if (!Array.isArray(bundle.profiles)) throw new HqVaultClientError('Bundle is malformed.');
  return bundle.profiles.map((profile) => ({
    ...profile,
    keys: profile.keys.map((key) => {
      const { sealed, ...meta } = key;
      if (sealed === undefined) return meta;
      const aad = hqVaultKeyAad({
        deviceId,
        profileId: profile.id,
        keyId: key.id,
        version: key.version,
      });
      const parsed = JSON.parse(hqVaultOpen(sealed, keys, aad)) as Partial<HqVaultSealedKeyFields>;
      if (typeof parsed.apiKey !== 'string' || parsed.apiKey.length === 0) {
        throw new HqVaultClientError(`Key ${profile.id}/${key.label} in the bundle is empty.`);
      }
      const secrets: HqVaultSealedKeyFields = { apiKey: parsed.apiKey };
      for (const field of ['tokenType', 'scope', 'project'] as const) {
        if (typeof parsed[field] === 'string') secrets[field] = parsed[field];
      }
      return { ...meta, secrets };
    }),
  }));
}

/**
 * True only for HQ's signed revocation of THIS device answering THIS request
 * (see {@link HqVaultRevocation}). Anything else — unsigned, signed by another
 * key, for another device or an earlier request — is not a revocation.
 */
export function verifyHqVaultRevocation(
  revocation: unknown,
  keys: HqVaultKeyPair,
  pinned: HqVaultIdentity,
  request: HqVaultFetchRequest,
): boolean {
  if (!revocation || typeof revocation !== 'object') return false;
  const { sig, ...body } = revocation as HqVaultRevocation;
  return (
    body.v === 2 &&
    body.hqId === pinned.hqId &&
    body.deviceId === hqVaultKeyId(keys) &&
    body.requestNonce === request.nonce &&
    typeof body.revokedAt === 'string' &&
    hqVaultVerify({ ...body, purpose: HQ_VAULT_REVOKED_PURPOSE }, sig, pinned.signPublic)
  );
}
