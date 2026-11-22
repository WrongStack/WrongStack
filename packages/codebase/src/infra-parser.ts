/**
 * Polyglot Infrastructure, CI/CD, and Schema Parser (`infra-parser.ts`).
 *
 * Extracts rich architectural symbols and cross-entity references from
 * non-code / infrastructure artifacts:
 *   - Dockerfile (`FROM ... AS`, `COPY --from`, `ARG`, `ENV`, `EXPOSE`)
 *   - Docker Compose (`services`, `depends_on`, `image`, `build`)
 *   - GitHub Actions Workflows (`.github/workflows/*.yml`: `jobs`, `needs`, `uses`)
 *   - SQL Schemas (`.sql`: `CREATE TABLE/VIEW`, `REFERENCES <table>`)
 *   - GraphQL Schemas (`.graphql`/`.gql`: types, `implements`, field type refs)
 *   - Protobuf Schemas (`.proto`: services, messages, `rpc` request/response refs)
 *   - Makefile & CMakeLists.txt (targets, prerequisites, `target_link_libraries`)
 */

import { detectLang } from './languages.js';
import type { Symbol as IndexSymbol, Ref, SymbolKind, SymbolLang } from './schema.js';

export type InfraArtifactKind =
  | 'dockerfile'
  | 'docker-compose'
  | 'github-workflow'
  | 'sql'
  | 'graphql'
  | 'protobuf'
  | 'makefile'
  | 'cmake'
  | 'dotenv'
  | 'openapi'
  | 'terraform'
  | 'kubernetes'
  | 'markdown-wiki'
  | 'shell';

export interface InfraParseResult {
  kind: InfraArtifactKind | null;
  symbols: IndexSymbol[];
  refs: Ref[];
}

const GRAPHQL_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
const PROTO_SCALARS = new Set([
  'double',
  'float',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'bool',
  'string',
  'bytes',
]);

export function detectInfraArtifactKind(file: string, content?: string): InfraArtifactKind | null {
  const norm = file.replace(/\\/g, '/');
  const lower = norm.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (
    base === 'docker-compose.yml' ||
    base === 'docker-compose.yaml' ||
    base === 'compose.yml' ||
    base === 'compose.yaml'
  ) {
    return 'docker-compose';
  }
  if (lower.includes('.github/workflows/') && (base.endsWith('.yml') || base.endsWith('.yaml'))) {
    return 'github-workflow';
  }
  if (base === 'makefile' || base === 'gnumakefile' || base === 'justfile') return 'makefile';
  if (base === 'cmakelists.txt') return 'cmake';
  if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
  if (
    base === 'openapi.yml' ||
    base === 'openapi.yaml' ||
    base === 'openapi.json' ||
    base === 'swagger.yml' ||
    base === 'swagger.yaml' ||
    base === 'swagger.json'
  ) {
    return 'openapi';
  }
  if (base.endsWith('.tf') || base.endsWith('.tfvars')) return 'terraform';
  if (
    (base.endsWith('.yml') || base.endsWith('.yaml')) &&
    (lower.includes('/k8s/') ||
      lower.startsWith('k8s/') ||
      lower.includes('/kubernetes/') ||
      lower.startsWith('kubernetes/') ||
      lower.includes('/manifests/') ||
      lower.startsWith('manifests/') ||
      base.endsWith('.k8s.yml') ||
      base.endsWith('.k8s.yaml') ||
      (content !== undefined && /^apiVersion\s*:/m.test(content) && /^kind\s*:/m.test(content)))
  ) {
    return 'kubernetes';
  }
  if (base.endsWith('.sql')) return 'sql';
  if (base.endsWith('.graphql') || base.endsWith('.gql')) return 'graphql';
  if (base.endsWith('.proto')) return 'protobuf';
  if (base.endsWith('.md') || base.endsWith('.mdx')) return 'markdown-wiki';
  if (base.endsWith('.sh') || base.endsWith('.bash') || base.endsWith('.zsh')) return 'shell';
  return null;
}

function makeSym(opts: {
  file: string;
  lang: SymbolLang;
  kind: SymbolKind;
  name: string;
  line: number;
  signature: string;
  scope?: string;
}): IndexSymbol {
  return {
    id: 0,
    file: opts.file,
    lang: opts.lang,
    kind: opts.kind,
    name: opts.name,
    line: opts.line,
    col: 0,
    signature: opts.signature.trim().slice(0, 500),
    docComment: '',
    scope: opts.scope ?? '',
    text: `${opts.name} ${opts.signature}`.trim().slice(0, 1000),
  };
}

/**
 * Parse an infrastructure, workflow, or schema file into symbols and references.
 */
export function parseInfraArtifact(opts: {
  file: string;
  content: string;
  lang?: SymbolLang | undefined;
}): InfraParseResult {
  const kind = detectInfraArtifactKind(opts.file, opts.content);
  if (!kind || !opts.content) {
    return { kind: null, symbols: [], refs: [] };
  }
  const lang: SymbolLang = opts.lang ?? detectLang(opts.file) ?? 'other';
  const lines = opts.content.split('\n');
  const symbols: IndexSymbol[] = [];
  const refs: Ref[] = [];

  if (kind === 'dockerfile') {
    let currentStage = '';
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('#')) continue;
      const lineNo = i + 1;

      const fromMatch = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i.exec(
        raw,
      );
      if (fromMatch) {
        const baseImage = fromMatch[1] ?? '';
        const stageName = fromMatch[2] ?? baseImage;
        currentStage = stageName;
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'namespace',
            name: stageName,
            line: lineNo,
            signature: raw,
          }),
        );
        if (baseImage) {
          refs.push({
            fromId: 0,
            toName: baseImage,
            line: lineNo,
            callType: 'import',
            lang,
            module: baseImage,
          });
        }
        continue;
      }

      const copyFromMatch = /^COPY\s+.*--from=([A-Za-z0-9_.:/-]+)/i.exec(raw);
      if (copyFromMatch?.[1]) {
        refs.push({
          fromId: 0,
          toName: copyFromMatch[1],
          line: lineNo,
          callType: 'call',
          lang,
        });
      }

      const envArgMatch = /^(?:ARG|ENV)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(raw);
      if (envArgMatch?.[1]) {
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'const',
            name: envArgMatch[1],
            line: lineNo,
            signature: raw,
            scope: currentStage,
          }),
        );
        continue;
      }

      const exposeMatch = /^EXPOSE\s+(\d+(?:\/(?:tcp|udp))?)/i.exec(raw);
      if (exposeMatch?.[1]) {
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'property',
            name: `EXPOSE:${exposeMatch[1]}`,
            line: lineNo,
            signature: raw,
            scope: currentStage,
          }),
        );
      }
    }
  } else if (kind === 'docker-compose') {
    let inServices = false;
    let currentService = '';
    let inDependsOn = false;
    // Indent units come from the file: 2 and 4 spaces are both common.
    let serviceIndent = -1;
    let propIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const lineNo = i + 1;

      if (indent === 0) {
        inServices = /^services\s*:/.test(trimmed);
        currentService = '';
        inDependsOn = false;
        serviceIndent = -1;
        propIndent = -1;
        continue;
      }
      if (!inServices) continue;
      if (serviceIndent < 0) serviceIndent = indent;
      if (currentService && indent > serviceIndent && propIndent < 0) propIndent = indent;

      if (indent === serviceIndent) {
        const svcMatch = /^([A-Za-z0-9_.-]+)\s*:/.exec(trimmed);
        if (svcMatch?.[1]) {
          currentService = svcMatch[1];
          inDependsOn = false;
          propIndent = -1;
          symbols.push(
            makeSym({
              file: opts.file,
              lang,
              kind: 'namespace',
              name: currentService,
              line: lineNo,
              signature: `service ${currentService}`,
              scope: 'services',
            }),
          );
        }
        continue;
      }

      if (currentService && indent === propIndent) {
        inDependsOn = /^depends_on\s*:/.test(trimmed);
        const imageMatch = /^image\s*:\s*['"]?([^\s'"]+)/.exec(trimmed);
        if (imageMatch?.[1]) {
          refs.push({
            fromId: 0,
            toName: imageMatch[1],
            line: lineNo,
            callType: 'import',
            lang,
            module: imageMatch[1],
          });
        }
        continue;
      }

      if (currentService && inDependsOn && indent >= propIndent) {
        const listDep = /^-\s*([A-Za-z0-9_.-]+)/.exec(trimmed);
        const mapDep = /^([A-Za-z0-9_.-]+)\s*:/.exec(trimmed);
        const target = listDep?.[1] ?? mapDep?.[1];
        if (target && target !== 'condition') {
          refs.push({
            fromId: 0,
            toName: target,
            line: lineNo,
            callType: 'call',
            lang,
          });
        }
      }
    }
  } else if (kind === 'github-workflow') {
    let inJobs = false;
    let currentJob = '';
    let jobIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const lineNo = i + 1;

      if (indent === 0) {
        inJobs = /^jobs\s*:/.test(trimmed);
        currentJob = '';
        jobIndent = -1;
        continue;
      }
      if (!inJobs) continue;
      if (jobIndent < 0) jobIndent = indent;

      if (indent === jobIndent) {
        const jobMatch = /^([A-Za-z0-9_.-]+)\s*:/.exec(trimmed);
        if (jobMatch?.[1]) {
          currentJob = jobMatch[1];
          symbols.push(
            makeSym({
              file: opts.file,
              lang,
              kind: 'function',
              name: currentJob,
              line: lineNo,
              signature: `job ${currentJob}`,
              scope: 'jobs',
            }),
          );
        }
        continue;
      }

      if (currentJob && indent > jobIndent) {
        const needsInline = /^needs\s*:\s*\[([^\]]+)\]/.exec(trimmed);
        if (needsInline?.[1]) {
          for (const rawNeed of needsInline[1].split(',')) {
            const need = rawNeed.trim().replace(/^['"]|['"]$/g, '');
            if (need) {
              refs.push({
                fromId: 0,
                toName: need,
                line: lineNo,
                callType: 'call',
                lang,
              });
            }
          }
        } else {
          const needsSingle = /^needs\s*:\s*([A-Za-z0-9_.-]+)\s*$/.exec(trimmed);
          if (needsSingle?.[1]) {
            refs.push({
              fromId: 0,
              toName: needsSingle[1],
              line: lineNo,
              callType: 'call',
              lang,
            });
          }
        }

        const usesMatch = /^(?:-\s*)?uses\s*:\s*['"]?([^\s'"]+)/.exec(trimmed);
        if (usesMatch?.[1]) {
          refs.push({
            fromId: 0,
            toName: usesMatch[1],
            line: lineNo,
            callType: 'import',
            lang,
            module: usesMatch[1],
          });
        }
      }
    }
  } else if (kind === 'sql') {
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('--')) continue;
      const lineNo = i + 1;

      const createMatch =
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/i.exec(
          raw,
        );
      if (createMatch?.[1]) {
        const name = createMatch[1].replace(/"/g, '');
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'type',
            name,
            line: lineNo,
            signature: raw,
          }),
        );
      }

      const refRe = /\bREFERENCES\s+([A-Za-z_"][\w."]*)/gi;
      for (const match of raw.matchAll(refRe)) {
        const target = (match[1] ?? '').replace(/"/g, '');
        if (target) {
          refs.push({
            fromId: 0,
            toName: target,
            line: lineNo,
            callType: 'type_ref',
            lang,
          });
        }
      }
    }
  } else if (kind === 'graphql') {
    let currentType = '';
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('#')) continue;
      const lineNo = i + 1;

      const typeMatch =
        /^(?:extend\s+)?(type|interface|input|enum|union|scalar)\s+([A-Za-z_]\w*)(?:\s+implements\s+([^{]+))?/i.exec(
          raw,
        );
      if (typeMatch?.[2]) {
        currentType = typeMatch[2];
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'type',
            name: currentType,
            line: lineNo,
            signature: raw,
          }),
        );
        if (typeMatch[3]) {
          for (const iface of typeMatch[3].split(/[&,]/)) {
            const trimmedIface = iface.trim();
            if (trimmedIface) {
              refs.push({
                fromId: 0,
                toName: trimmedIface,
                line: lineNo,
                callType: 'implement',
                lang,
              });
            }
          }
        }
        continue;
      }

      if (raw.startsWith('}')) {
        currentType = '';
        continue;
      }

      if (currentType) {
        const fieldMatch = /^([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*[[!\s]*([A-Za-z_]\w*)/.exec(raw);
        const targetType = fieldMatch?.[2];
        if (targetType && !GRAPHQL_SCALARS.has(targetType)) {
          refs.push({
            fromId: 0,
            toName: targetType,
            line: lineNo,
            callType: 'type_ref',
            lang,
          });
        }
      }
    }
  } else if (kind === 'protobuf') {
    let currentScope = '';
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('//')) continue;
      const lineNo = i + 1;

      const declMatch = /^(service|message|enum)\s+([A-Za-z_]\w*)/.exec(raw);
      if (declMatch?.[2]) {
        currentScope = declMatch[2];
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'type',
            name: currentScope,
            line: lineNo,
            signature: raw,
          }),
        );
        continue;
      }

      const rpcMatch =
        /^rpc\s+([A-Za-z_]\w*)\s*\(\s*(?:stream\s+)?([A-Za-z_][\w.]*)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([A-Za-z_][\w.]*)\s*\)/.exec(
          raw,
        );
      if (rpcMatch?.[1]) {
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'function',
            name: rpcMatch[1],
            line: lineNo,
            signature: raw,
            scope: currentScope,
          }),
        );
        for (const msgType of [rpcMatch[2], rpcMatch[3]]) {
          if (msgType && !PROTO_SCALARS.has(msgType)) {
            refs.push({
              fromId: 0,
              toName: msgType.split('.').pop() ?? msgType,
              line: lineNo,
              callType: 'type_ref',
              lang,
            });
          }
        }
      }
    }
  } else if (kind === 'makefile') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!line || line.startsWith('\t') || line.trimStart().startsWith('#')) continue;
      const lineNo = i + 1;
      const targetMatch = /^([A-Za-z_][\w.-]*)\s*:(?!=)\s*(.*)$/.exec(line);
      if (targetMatch?.[1] && targetMatch[1] !== '.PHONY') {
        const targetName = targetMatch[1];
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'function',
            name: targetName,
            line: lineNo,
            signature: line.trim(),
          }),
        );
        const prereqs = (targetMatch[2] ?? '').split(/\s+/).filter(Boolean);
        for (const prereq of prereqs) {
          if (/^[A-Za-z_][\w.-]*$/.test(prereq)) {
            refs.push({
              fromId: 0,
              toName: prereq,
              line: lineNo,
              callType: 'call',
              lang,
            });
          }
        }
      }
    }
  } else if (kind === 'cmake') {
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('#')) continue;
      const lineNo = i + 1;
      const addTarget = /^(?:add_executable|add_library)\s*\(\s*([A-Za-z0-9_.-]+)/i.exec(raw);
      if (addTarget?.[1]) {
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'function',
            name: addTarget[1],
            line: lineNo,
            signature: raw,
          }),
        );
      }
    }
  } else if (kind === 'dotenv') {
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('#')) continue;
      const lineNo = i + 1;
      const envMatch = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
      if (envMatch?.[1]) {
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'const',
            name: envMatch[1],
            line: lineNo,
            // Never record raw secret values in signatures
            signature: `${envMatch[1]}=***`,
          }),
        );
        const val = envMatch[2] ?? '';
        for (const interp of val.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
          if (interp[1]) {
            refs.push({
              fromId: 0,
              toName: interp[1],
              line: lineNo,
              callType: 'call',
              lang,
            });
          }
        }
      }
    }
  } else if (kind === 'openapi') {
    let inSchemas = false;
    let schemasIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const lineNo = i + 1;
      const indent = line.length - line.trimStart().length;

      if (/^schemas\s*:/.test(trimmed)) {
        inSchemas = true;
        schemasIndent = indent;
        continue;
      }
      if (inSchemas && indent <= schemasIndent) {
        inSchemas = false;
      }

      if (inSchemas && indent === schemasIndent + 2) {
        const schemaMatch = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/.exec(trimmed);
        if (schemaMatch?.[1]) {
          symbols.push(
            makeSym({
              file: opts.file,
              lang,
              kind: 'type',
              name: schemaMatch[1],
              line: lineNo,
              signature: `schema ${schemaMatch[1]}`,
              scope: 'components.schemas',
            }),
          );
          continue;
        }
      }

      const pathMatch = /^['"]?(\/[A-Za-z0-9_/{}-]+)['"]?\s*:/.exec(trimmed);
      if (pathMatch?.[1]) {
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: 'function',
            name: pathMatch[1],
            line: lineNo,
            signature: `endpoint ${pathMatch[1]}`,
            scope: 'paths',
          }),
        );
        continue;
      }

      const refMatch = /\$ref\s*:\s*['"]?#\/components\/schemas\/([A-Za-z0-9_.-]+)['"]?/.exec(
        trimmed,
      );
      if (refMatch?.[1]) {
        refs.push({
          fromId: 0,
          toName: refMatch[1],
          line: lineNo,
          callType: 'type_ref',
          lang,
        });
      }
    }
  } else if (kind === 'terraform') {
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue;
      const lineNo = i + 1;

      const resMatch = /^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/.exec(raw);
      if (resMatch?.[1] && resMatch[2] && resMatch[3]) {
        const blockType = resMatch[1];
        const rType = resMatch[2];
        const rName = resMatch[3];
        const fullName = blockType === 'data' ? `data.${rType}.${rName}` : `${rType}.${rName}`;
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind: blockType === 'data' ? 'type' : 'class',
            name: fullName,
            line: lineNo,
            signature: `${blockType} "${rType}" "${rName}"`,
            scope: blockType,
          }),
        );
        continue;
      }

      const modVarOutMatch = /^(module|variable|output)\s+"([^"]+)"/.exec(raw);
      if (modVarOutMatch?.[1] && modVarOutMatch[2]) {
        const blockType = modVarOutMatch[1];
        const bName = modVarOutMatch[2];
        const prefix = blockType === 'variable' ? 'var' : blockType;
        symbols.push(
          makeSym({
            file: opts.file,
            lang,
            kind:
              blockType === 'module'
                ? 'namespace'
                : blockType === 'variable'
                  ? 'const'
                  : 'property',
            name: `${prefix}.${bName}`,
            line: lineNo,
            signature: `${blockType} "${bName}"`,
            scope: blockType,
          }),
        );
        continue;
      }

      const sourceMatch = /^source\s*=\s*"([^"]+)"/.exec(raw);
      if (sourceMatch?.[1]) {
        refs.push({
          fromId: 0,
          toName: sourceMatch[1],
          line: lineNo,
          callType: 'import',
          lang,
          module: sourceMatch[1],
        });
      }

      for (const refMatch of raw.matchAll(/\b(var|module)\.([A-Za-z0-9_-]+)/g)) {
        if (refMatch[1] && refMatch[2]) {
          refs.push({
            fromId: 0,
            toName: `${refMatch[1]}.${refMatch[2]}`,
            line: lineNo,
            callType: 'call',
            lang,
          });
        }
      }
    }
  } else if (kind === 'kubernetes') {
    let currentKind = '';
    let inMetadata = false;
    let metadataLine = 1;
    let metadataIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const lineNo = i + 1;
      const indent = line.length - line.trimStart().length;

      if (trimmed === '---') {
        currentKind = '';
        inMetadata = false;
        continue;
      }

      if (indent === 0) {
        const kindMatch = /^kind\s*:\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(trimmed);
        if (kindMatch?.[1]) {
          currentKind = kindMatch[1];
          continue;
        }
        inMetadata = /^metadata\s*:/.test(trimmed);
        if (inMetadata) metadataLine = lineNo;
        metadataIndent = -1;
        continue;
      }
      if (inMetadata && metadataIndent < 0) metadataIndent = indent;

      if (inMetadata && indent === metadataIndent && currentKind) {
        const nameMatch = /^name\s*:\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(trimmed);
        if (nameMatch?.[1]) {
          symbols.push(
            makeSym({
              file: opts.file,
              lang,
              kind: 'class',
              name: `${currentKind}:${nameMatch[1]}`,
              line: metadataLine,
              signature: `k8s ${currentKind} ${nameMatch[1]}`,
              scope: currentKind,
            }),
          );
          inMetadata = false;
          continue;
        }
      }

      const imageMatch = /^(?:-\s*)?image\s*:\s*['"]?([^\s'"]+)/.exec(trimmed);
      if (imageMatch?.[1]) {
        refs.push({
          fromId: 0,
          toName: imageMatch[1],
          line: lineNo,
          callType: 'import',
          lang,
          module: imageMatch[1],
        });
      }

      const svcRefMatch =
        /^(?:serviceName|claimName|configMapName|secretName)\s*:\s*['"]?([A-Za-z0-9_.-]+)['"]?/.exec(
          trimmed,
        );
      if (svcRefMatch?.[1]) {
        refs.push({
          fromId: 0,
          toName: svcRefMatch[1],
          line: lineNo,
          callType: 'call',
          lang,
        });
      }
    }
  } else if (kind === 'markdown-wiki') {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (/^(`{3,}|~{3,})/.test(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const lineNo = i + 1;

      // Obsidian / WikiLinks: [[TargetPage]] or [[TargetPage|Label]] or [[TargetPage#Heading]]
      for (const wikiMatch of line.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
        const target = (wikiMatch[1] ?? '').trim();
        if (target) {
          refs.push({
            fromId: 0,
            toName: target,
            line: lineNo,
            callType: 'import',
            lang,
            module: target,
          });
        }
      }

      // Standard Markdown links to local docs/files: [Label](./path/to/doc.md)
      for (const mdLink of line.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+)\)/g)) {
        const rawHref = (mdLink[1] ?? '').trim();
        if (!rawHref || /^(?:https?:|mailto:|#)/i.test(rawHref)) continue;
        const cleanHref = rawHref.split('#')[0] ?? rawHref;
        if (cleanHref) {
          refs.push({
            fromId: 0,
            toName: cleanHref,
            line: lineNo,
            callType: 'import',
            lang,
            module: cleanHref,
          });
        }
      }
    }
  } else if (kind === 'shell') {
    for (let i = 0; i < lines.length; i++) {
      const raw = (lines[i] ?? '').trim();
      if (!raw || raw.startsWith('#')) continue;
      const lineNo = i + 1;
      const sourceMatch = /^(?:source|\.)\s+['"]?([^\s'";|&]+)['"]?/.exec(raw);
      if (sourceMatch?.[1]) {
        refs.push({
          fromId: 0,
          toName: sourceMatch[1],
          line: lineNo,
          callType: 'import',
          lang,
          module: sourceMatch[1],
        });
      }
    }
  }

  return { kind, symbols, refs };
}
