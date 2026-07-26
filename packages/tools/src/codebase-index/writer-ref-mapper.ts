import type { Ref } from './schema.js';

export type WriterRefRow = {
  id: number;
  from_id: number;
  to_name: string;
  to_id: number | null;
  call_type: string;
  line: number;
};

export function mapWriterRefRow(row: WriterRefRow): Ref {
  return {
    id: row.id,
    fromId: row.from_id,
    toName: row.to_name,
    toId: row.to_id ?? undefined,
    callType: row.call_type as Ref['callType'],
    line: row.line,
  };
}
