export function collectUpdaterArtifacts(
  bundle: string,
  output: string,
  label: string,
  version: string,
): string[];
export function verifyUpdaterSignature(
  payload: Uint8Array,
  signature: string,
  publicKey: string,
  version: string,
): void;
export function createUpdaterManifest(
  directory: string,
  version: string,
  repository: string,
  publicKey: string,
  date?: string,
): {
  version: string;
  notes: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature: string }>;
};
