import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntryInput {
  name: string;
  data: string | Uint8Array;
}

/** Create a standards-compliant ZIP archive using only Node built-ins. */
export function createZipBuffer(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { date, time } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(normalizeZipPath(entry.name), 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

/** Minimal reader for validation/import paths; rejects encrypted or unsafe entries. */
export function readZipEntries(archive: Uint8Array): Map<string, Buffer> {
  const maxEntries = 1_000;
  const maxEntryBytes = 64 * 1024 * 1024;
  const maxTotalBytes = 128 * 1024 * 1024;
  const buffer = Buffer.from(archive);
  const result = new Map<string, Buffer>();
  let totalBytes = 0;
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > buffer.length) throw new Error('Truncated ZIP local header.');
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    if ((flags & 1) !== 0) throw new Error('Encrypted ZIP entries are not supported.');
    if ((flags & 8) !== 0) throw new Error('ZIP data descriptors are not supported.');
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const expectedSize = buffer.readUInt32LE(offset + 22);
    if (result.size >= maxEntries) throw new Error('ZIP contains too many entries.');
    if (expectedSize > maxEntryBytes || totalBytes + expectedSize > maxTotalBytes) {
      throw new Error('ZIP expands beyond the configured size limit.');
    }
    if (compressedSize > 0 && expectedSize / compressedSize > 1_000) {
      throw new Error('ZIP entry has a suspicious compression ratio.');
    }
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error('Truncated ZIP entry.');
    const rawName = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    // Normalise BEFORE the safety check, exactly as the write path does via
    // normalizeZipPath. Checking the raw name let `..\..\evil.txt` through:
    // isSafeZipPath splits on '/' only, so a backslash-separated traversal is
    // one opaque segment that never equals '..'. Windows resolves it as a
    // traversal all the same (WS-092).
    const name = normalizeZipPath(rawName);
    const compressed = buffer.subarray(dataStart, dataEnd);
    // Bound the inflate itself. The size and ratio checks above read
    // `expectedSize`/`compressedSize` from the entry header — attacker-declared
    // values — so a lying header sailed past them and inflateRawSync then
    // expanded without limit. maxOutputLength makes zlib stop allocating; the
    // declared-size mismatch below still catches the lie afterwards.
    const inflateLimit = Math.min(expectedSize, maxEntryBytes) + 1;
    const data =
      method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: inflateLimit })
          : undefined;
    if (!data) throw new Error(`Unsupported ZIP compression method: ${method}`);
    if (data.length !== expectedSize) throw new Error(`ZIP size mismatch for ${name}`);
    if (crc32(data) !== buffer.readUInt32LE(offset + 14)) throw new Error(`ZIP CRC mismatch for ${name}`);
    result.set(name, data);
    totalBytes += data.length;
    offset = dataEnd;
  }
  return result;
}

function normalizeZipPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!isSafeZipPath(normalized)) throw new Error(`Unsafe ZIP entry path: ${value}`);
  return normalized;
}

function isSafeZipPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !value.startsWith('?') &&
    !/^[a-z]:/i.test(value) &&
    !value.split('/').includes('..')
  );
}

function dosDateTime(value: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}
