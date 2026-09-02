/**
 * TechStack — SBOM (Software Bill of Materials) export.
 *
 * Converts a Snapshot into SPDX or CycloneDX JSON format.
 *
 * @see docs/specs/techstack-sdd.md §9
 */

import type { Snapshot } from './types.js';

// ── SPDX ────────────────────────────────────────────────────────────────

export interface SpdxDocument {
  spdxVersion: string;
  dataLicense: string;
  SPDXID: string;
  name: string;
  documentNamespace: string;
  creationInfo: {
    created: string;
    creators: string[];
  };
  packages: Array<{
    name: string;
    SPDXID: string;
    versionInfo?: string | undefined;
    downloadLocation?: string | undefined;
    filesAnalyzed: boolean;
    licenseConcluded?: string | undefined;
    licenseDeclared?: string | undefined;
    supplier: string;
    copyrightText: string;
  }>;
}

export function toSpdx(snapshot: Snapshot): SpdxDocument {
  const created = snapshot.createdAt;
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `TechStack-SBOM-${snapshot.projectId}`,
    documentNamespace: `https://wrongstack.dev/spdx/${snapshot.id}`,
    creationInfo: {
      created,
      creators: ['Tool: WrongStack TechStack Engine'],
    },
    packages: snapshot.dependencies.map((dep, index) => ({
      name: dep.name,
      SPDXID: `SPDXRef-Package-${index}`,
      versionInfo: dep.locked ?? dep.requested,
      downloadLocation: dep.purl ? `https://purl.io/${dep.purl}` : 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: dep.license ?? 'NOASSERTION',
      licenseDeclared: dep.license ?? 'NOASSERTION',
      supplier: 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    })),
  };
}

// ── CycloneDX ───────────────────────────────────────────────────────────

export interface CycloneDXBom {
  bomFormat: string;
  specVersion: string;
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ name: string; version: string }>;
  };
  components: Array<{
    type: string;
    name: string;
    version?: string | undefined;
    purl?: string | undefined;
    licenses?: Array<{ license: { id: string } }> | undefined;
  }>;
}

export function toCycloneDX(snapshot: Snapshot): CycloneDXBom {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: snapshot.createdAt,
      tools: [{ name: 'WrongStack TechStack Engine', version: snapshot.adapterVersion }],
    },
    components: snapshot.dependencies.map((dep) => ({
      type: 'library',
      name: dep.name,
      version: dep.locked ?? dep.requested,
      ...(dep.purl ? { purl: dep.purl } : {}),
      ...(dep.license ? { licenses: [{ license: { id: dep.license } }] } : {}),
    })),
  };
}
