import type { Ref, SymbolLang } from './schema.js';

export type WriterRefRow = {
  id: number;
  from_id: number;
  to_name: string;
  to_id: number | null;
  call_type: string;
  line: number;
  lang?: string | null;
  module?: string | null;
  to_file?: string | null;
};

export function mapWriterRefRow(row: WriterRefRow): Ref {
  return {
    id: row.id,
    fromId: row.from_id,
    toName: row.to_name,
    toId: row.to_id ?? undefined,
    callType: row.call_type as Ref['callType'],
    line: row.line,
    // `lang`/`module`/`to_file` are absent from the narrower column lists some
    // queries select; `undefined` keeps those rows valid Refs.
    lang: (row.lang ?? undefined) as SymbolLang | undefined,
    module: row.module ?? undefined,
    toFile: row.to_file ?? undefined,
  };
}
