/**
 * TechStack — Package URL (PURL) construction and parsing.
 *
 * PURL spec: https://github.com/package-url/purl-spec
 *
 * Every dependency that comes from a registry gets a PURL identifier
 * so it can be matched across ecosystems, deduplicated in aggregate views,
 * and queried against OSV's /v1/querybatch endpoint.
 *
 * @see docs/specs/techstack-sdd.md §4.1, §5
 */

import type { EcosystemId } from '../types.js';

/**
 * Parsed PURL components.
 */
export interface PurlParts {
  readonly type: string;
  readonly namespace?: string | undefined;
  readonly name: string;
  readonly version?: string | undefined;
  readonly qualifiers?: ReadonlyMap<string, string> | undefined;
  readonly subpath?: string | undefined;
}

/**
 * Map ecosystem ids to PURL type strings.
 * Some ecosystems have different PURL types than their internal id.
 */
const ECOSYSTEM_TO_PURL_TYPE: Readonly<Record<EcosystemId, string>> = {
  npm: 'npm',
  python: 'pypi',
  rust: 'cargo',
  go: 'golang',
  dotnet: 'nuget',
  php: 'composer',
  dart: 'pub',
  maven: 'maven',
  gradle: 'maven',
  ruby: 'gem',
  swift: 'swift',
  elixir: 'hex',
  cpp: 'conan',
};

/**
 * Reverse map for parsing PURL type back to ecosystem id.
 */
const PURL_TYPE_TO_ECOSYSTEM: Readonly<Record<string, EcosystemId>> = {
  npm: 'npm',
  pypi: 'python',
  cargo: 'rust',
  golang: 'go',
  nuget: 'dotnet',
  composer: 'php',
  pub: 'dart',
  maven: 'maven',
  gem: 'ruby',
  swift: 'swift',
  hex: 'elixir',
  conan: 'cpp',
};

/**
 * Build a PURL string from components.
 *
 * @example
 * buildPurl({ type: 'npm', name: 'react', version: '19.1.0' })
 * // → 'pkg:npm/react@19.1.0'
 *
 * buildPurl({ type: 'npm', namespace: '@types', name: 'node', version: '22.0.0' })
 * // → 'pkg:npm/%40types/node@22.0.0'
 *
 * buildPurl({ type: 'maven', namespace: 'org.springframework', name: 'spring-core', version: '6.2.7' })
 * // → 'pkg:maven/org.springframework/spring-core@6.2.7'
 *
 * buildPurl({ type: 'pypi', name: 'django', version: '5.2' })
 * // → 'pkg:pypi/django@5.2'
 */
export function buildPurl(parts: PurlParts): string {
  const segments: string[] = ['pkg:', parts.type, '/'];

  if (parts.namespace) {
    segments.push(encodePurlSegment(parts.namespace), '/');
  }

  segments.push(encodePurlSegment(parts.name));

  if (parts.version) {
    segments.push('@', encodePurlSegment(parts.version));
  }

  if (parts.qualifiers && parts.qualifiers.size > 0) {
    const qs = [...parts.qualifiers.entries()]
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    segments.push('?', qs);
  }

  if (parts.subpath) {
    segments.push('#', encodePurlSegment(parts.subpath));
  }

  return segments.join('');
}

/**
 * Parse a PURL string into its components.
 * Returns undefined for malformed PURLs.
 *
 * @example
 * parsePurl('pkg:npm/react@19.1.0')
 * // → { type: 'npm', name: 'react', version: '19.1.0' }
 *
 * parsePurl('pkg:maven/org.springframework/spring-core@6.2.7')
 * // → { type: 'maven', namespace: 'org.springframework', name: 'spring-core', version: '6.2.7' }
 */
export function parsePurl(purl: string): PurlParts | undefined {
  if (!purl.startsWith('pkg:')) return undefined;

  const withoutPrefix = purl.slice(4);

  // Split subpath
  let main = withoutPrefix;
  let subpath: string | undefined;
  const hashIdx = main.indexOf('#');
  if (hashIdx >= 0) {
    subpath = decodePurlSegment(main.slice(hashIdx + 1));
    main = main.slice(0, hashIdx);
  }

  // Split qualifiers
  let qualifiers: Map<string, string> | undefined;
  const qIdx = main.indexOf('?');
  if (qIdx >= 0) {
    const qs = main.slice(qIdx + 1);
    main = main.slice(0, qIdx);
    qualifiers = new Map<string, string>();
    for (const pair of qs.split('&')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        qualifiers.set(
          decodePurlSegment(pair.slice(0, eqIdx)),
          decodePurlSegment(pair.slice(eqIdx + 1)),
        );
      }
    }
  }

  // Split version
  let version: string | undefined;
  const atIdx = main.lastIndexOf('@');
  if (atIdx > 0) {
    // Must be after the type prefix (i.e., not @scope)
    version = decodePurlSegment(main.slice(atIdx + 1));
    main = main.slice(0, atIdx);
  }

  // Split type
  const slashIdx = main.indexOf('/');
  if (slashIdx < 0) return undefined;
  const type = main.slice(0, slashIdx);
  const remainder = main.slice(slashIdx + 1);

  // Check for namespace (second /)
  let namespace: string | undefined;
  let name: string;
  const nsSlashIdx = remainder.indexOf('/');
  if (nsSlashIdx >= 0 && type !== 'npm') {
    // Most ecosystems use namespace/name; npm uses @scope/name encoded as %40scope/name
    namespace = decodePurlSegment(remainder.slice(0, nsSlashIdx));
    name = decodePurlSegment(remainder.slice(nsSlashIdx + 1));
  } else if (nsSlashIdx >= 0 && type === 'npm' && remainder.startsWith('%40')) {
    // npm scoped: %40scope/name
    namespace = decodePurlSegment(remainder.slice(0, nsSlashIdx));
    name = decodePurlSegment(remainder.slice(nsSlashIdx + 1));
  } else {
    name = decodePurlSegment(remainder);
  }

  if (!type || !name) return undefined;

  return {
    type,
    ...(namespace ? { namespace } : {}),
    name,
    ...(version ? { version } : {}),
    ...(qualifiers && qualifiers.size > 0 ? { qualifiers } : {}),
    ...(subpath ? { subpath } : {}),
  };
}

/**
 * Get the PURL type string for an ecosystem.
 */
export function purlTypeForEcosystem(ecosystem: EcosystemId): string {
  return ECOSYSTEM_TO_PURL_TYPE[ecosystem];
}

/**
 * Get the ecosystem id for a PURL type string.
 * Returns undefined for unknown types.
 */
export function ecosystemForPurlType(type: string): EcosystemId | undefined {
  return PURL_TYPE_TO_ECOSYSTEM[type];
}

/**
 * Construct a PURL string for a dependency in a given ecosystem.
 *
 * This is the spec-required convenience constructor. It composes the richer
 * `buildPurl` primitive with per-ecosystem namespace splitting so callers can
 * pass `name` in the ecosystem-native form (e.g. `"@types/node"` for npm
 * scoped packages, or `"org.springframework/spring-core"` for Maven groupId).
 *
 * Special-case: Go module paths (`github.com/gorilla/mux`) are written as a
 * single un-encoded name — the PURL spec treats `/` as the namespace
 * separator for most ecosystems but Go module paths use literal `/`s.
 *
 * @example
 * constructPurl('npm', 'react', '19.1.0')          // → 'pkg:npm/react@19.1.0'
 * constructPurl('npm', '@types/node', '22.0.0')   // → 'pkg:npm/%40types/node@22.0.0'
 * constructPurl('pypi', 'django', '5.2')           // → 'pkg:pypi/django@5.2'
 * constructPurl('maven', 'org.springframework/spring-core', '6.2.7')
 *                                                // → 'pkg:maven/org.springframework/spring-core@6.2.7'
 * constructPurl('go', 'github.com/gorilla/mux', '1.8.1')
 *                                                // → 'pkg:golang/github.com/gorilla/mux@1.8.1'
 */
export function constructPurl(ecosystem: EcosystemId, name: string, version?: string): string {
  const type = purlTypeForEcosystem(ecosystem);
  // Go module paths contain literal slashes that are part of the name, not
  // a namespace separator. `buildPurl` encodes `/` in segments per the PURL
  // spec, but the Go ecosystem is the documented exception: module paths
  // like `github.com/gorilla/mux` stay literal. Build the Go PURL string
  // directly so no `/` encoding is applied.
  if (ecosystem === 'go') {
    const versionSuffix = version !== undefined ? `@${encodePurlSegment(version)}` : '';
    return `pkg:${type}/${name}${versionSuffix}`;
  }
  const slashIdx = name.indexOf('/');
  // npm scoped packages: '@scope/name' → namespace='@scope', name='name'.
  // Maven coordinates: 'groupId/artifactId' → namespace=groupId, name=artifactId.
  if (slashIdx > 0) {
    const namespace = name.slice(0, slashIdx);
    const pkgName = name.slice(slashIdx + 1);
    if (pkgName.length > 0) {
      return buildPurl({
        type,
        namespace,
        name: pkgName,
        ...(version !== undefined ? { version } : {}),
      });
    }
  }
  return buildPurl({
    type,
    name,
    ...(version !== undefined ? { version } : {}),
  });
}

/**
 * Parse a PURL string back into the ecosystem-shaped parts used by the
 * TechStack dependency model: ecosystem id, package name, and optional version.
 *
 * The npm scope and Maven groupId are folded back into `name` so the returned
 * shape matches `constructPurl`'s inputs (round-trippable).
 *
 * Returns `undefined` for malformed PURLs or PURL types that don't map to a
 * TechStack ecosystem.
 *
 * @example
 * parsePurl('pkg:npm/%40types/node@22.0.0')  // → { ecosystem:'npm', name:'@types/node', version:'22.0.0' }
 * parsePurl('pkg:pypi/django@5.2')          // → { ecosystem:'python', name:'django', version:'5.2' }
 * parsePurl('pkg:npm/react')                // → { ecosystem:'npm', name:'react' }
 * parsePurl('not-a-purl')                   // → undefined
 */
export interface ParsedEcosystemPurl {
  readonly ecosystem: EcosystemId;
  readonly name: string;
  readonly version?: string | undefined;
}

export function parsePurlEcosystem(purl: string): ParsedEcosystemPurl | undefined {
  const parts = parsePurl(purl);
  if (!parts) return undefined;
  const ecosystem = ecosystemForPurlType(parts.type);
  if (!ecosystem) return undefined;
  const namespace = parts.namespace;
  const name = namespace ? `${namespace}/${parts.name}` : parts.name;
  return {
    ecosystem,
    name,
    ...(parts.version !== undefined ? { version: parts.version } : {}),
  };
}

/**
 * Encode a PURL path segment per the spec.
 * Percent-encode characters that are not allowed unencoded.
 */
function encodePurlSegment(segment: string): string {
  // The PURL spec says the value must be percent-encoded as per RFC 3986.
  // In practice, we need to encode: @ / % and other reserved chars.
  return segment.replace(/%/g, '%25').replace(/@/g, '%40').replace(/\//g, '%2F');
}

/**
 * Decode a PURL path segment.
 */
function decodePurlSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
