import { describe, it, expect } from 'vitest';
import { createZipBuffer, readZipEntries } from '../src/server/zip.js';
import * as zlib from 'node:zlib';

describe('zip', () => {
  describe('createZipBuffer', () => {
    it('creates a valid ZIP archive with a single text entry', () => {
      const buf = createZipBuffer([{ name: 'test.txt', data: 'hello world' }]);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
      // ZIP magic number
      expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('creates a valid ZIP archive with multiple entries', () => {
      const buf = createZipBuffer([
        { name: 'file1.txt', data: 'content1' },
        { name: 'file2.txt', data: 'content2' },
      ]);
      expect(buf.length).toBeGreaterThan(0);
      // Should have two local file headers
      expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    });

    it('handles binary data entries', () => {
      const buf = createZipBuffer([{ name: 'binary.dat', data: new Uint8Array([0, 1, 2, 255]) }]);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('normalizes Windows-style backslashes in entry names', () => {
      const buf = createZipBuffer([{ name: 'subdir\\file.txt', data: 'test' }]);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('rejects entries with nested path traversal', () => {
      expect(() => createZipBuffer([{ name: 'foo/../../etc/passwd', data: 'hack' }])).toThrow(
        'Unsafe ZIP entry path',
      );
    });

    it('rejects entries with direct path traversal', () => {
      expect(() => createZipBuffer([{ name: '../outside.txt', data: 'hack' }])).toThrow(
        'Unsafe ZIP entry path',
      );
    });

    it('rejects entries with null byte', () => {
      expect(() => createZipBuffer([{ name: 'safe\x00exploit.txt', data: 'hack' }])).toThrow(
        'Unsafe ZIP entry path',
      );
    });

    it('rejects entries with Windows drive letter', () => {
      expect(() => createZipBuffer([{ name: 'C:config.txt', data: 'hack' }])).toThrow(
        'Unsafe ZIP entry path',
      );
    });

    it('rejects empty entry name', () => {
      expect(() => createZipBuffer([{ name: '', data: 'test' }])).toThrow('Unsafe ZIP entry path');
    });
  });

  describe('readZipEntries', () => {
    it('reads entries from a valid ZIP archive', () => {
      const buf = createZipBuffer([{ name: 'test.txt', data: 'hello world' }]);
      const entries = readZipEntries(buf);
      expect(entries.size).toBe(1);
      expect(entries.get('test.txt')?.toString('utf8')).toBe('hello world');
    });

    it('reads multiple entries from a valid ZIP archive', () => {
      const buf = createZipBuffer([
        { name: 'a.txt', data: 'aaa' },
        { name: 'b.txt', data: 'bbb' },
        { name: 'c.txt', data: 'ccc' },
      ]);
      const entries = readZipEntries(buf);
      expect(entries.size).toBe(3);
      expect(entries.get('a.txt')?.toString('utf8')).toBe('aaa');
      expect(entries.get('b.txt')?.toString('utf8')).toBe('bbb');
      expect(entries.get('c.txt')?.toString('utf8')).toBe('ccc');
    });

    it('handles binary data entries', () => {
      const binary = new Uint8Array([0, 255, 128, 64, 32]);
      const buf = createZipBuffer([{ name: 'bin.dat', data: binary }]);
      const entries = readZipEntries(buf);
      expect(Buffer.from(binary).equals(entries.get('bin.dat')!)).toBe(true);
    });

    it('handles stored (uncompressed, method=0) entries', () => {
      // Create a manually crafted minimal ZIP with stored entry
      const name = Buffer.from('stored.txt', 'utf8');
      const data = Buffer.from('stored data', 'utf8');
      const crc = crc32Manual(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(0, 6); // flags: none
      local.writeUInt16LE(0, 8); // method: stored (0)
      local.writeUInt16LE(0, 10); // time
      local.writeUInt16LE(0, 12); // date
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18); // compressed size (same for stored)
      local.writeUInt32LE(data.length, 22); // uncompressed size
      local.writeUInt16LE(name.length, 26);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x031e, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0, 8); // method: stored
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(0, 12);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(0, 42); // offset

      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(1, 8);
      end.writeUInt16LE(1, 10);
      end.writeUInt32LE(central.length, 12);
      end.writeUInt32LE(30 + name.length + data.length, 16);

      const archive = Buffer.concat([local, name, data, central, end]);
      const entries = readZipEntries(archive);
      expect(entries.get('stored.txt')?.toString('utf8')).toBe('stored data');
    });

    it('throws on encrypted entries', () => {
      // Create entry with bit 0 (encryption) set in flags
      const name = Buffer.from('secret.txt', 'utf8');
      const data = zlib.deflateRawSync(Buffer.from('data', 'utf8'));
      const crc = crc32Manual(Buffer.from('data', 'utf8'));

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(1, 6); // flag bit 0 = encrypted
      header.writeUInt16LE(8, 8); // deflated
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(4, 22); // uncompressed size
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, data]);
      expect(() => readZipEntries(archive)).toThrow('Encrypted ZIP entries');
    });

    it('throws on data descriptor entries', () => {
      // Create entry with bit 3 (data descriptor) set in flags
      const name = Buffer.from('test.txt', 'utf8');
      const data = zlib.deflateRawSync(Buffer.from('data', 'utf8'));
      const crc = crc32Manual(Buffer.from('data', 'utf8'));

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(8, 6); // flag bit 3 = data descriptor
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(4, 22);
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, data]);
      expect(() => readZipEntries(archive)).toThrow('ZIP data descriptors');
    });

    it('throws on unsupported compression method', () => {
      const name = Buffer.from('test.txt', 'utf8');
      const data = Buffer.from('data', 'utf8');

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6); // no flags
      header.writeUInt16LE(12, 8); // method 12 = unsupported
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(0, 14); // crc
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, data]);
      expect(() => readZipEntries(archive)).toThrow('Unsupported ZIP compression method');
    });

    it('throws on truncated local header', () => {
      const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // just magic, no full header
      expect(() => readZipEntries(archive)).toThrow('Truncated ZIP local header');
    });

    it('throws on CRC mismatch', () => {
      const name = Buffer.from('test.txt', 'utf8');
      const uncompressed = Buffer.from('hello', 'utf8');
      const compressed = zlib.deflateRawSync(uncompressed);
      const wrongCrc = 0xdeadbeef;

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8); // deflated
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(wrongCrc, 14); // wrong CRC
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(uncompressed.length, 22);
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, compressed]);
      expect(() => readZipEntries(archive)).toThrow('ZIP CRC mismatch');
    });

    it('throws on size mismatch', () => {
      const name = Buffer.from('test.txt', 'utf8');
      const uncompressed = Buffer.from('hello', 'utf8');
      const compressed = zlib.deflateRawSync(uncompressed);
      const crc = crc32Manual(uncompressed);

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(999, 22); // wrong expected size
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, compressed]);
      expect(() => readZipEntries(archive)).toThrow('ZIP size mismatch');
    });

    it('throws on unsafe ZIP entry path', () => {
      const name = Buffer.from('../escape.txt', 'utf8');
      const data = zlib.deflateRawSync(Buffer.from('test', 'utf8'));
      const crc = crc32Manual(Buffer.from('test', 'utf8'));

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(3, 22); // 'test' length
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, data]);
      expect(() => readZipEntries(archive)).toThrow('Unsafe ZIP entry path');
    });

    // WS-092. The read path checked the RAW entry name while the write path
    // normalised backslashes first via normalizeZipPath. isSafeZipPath splits
    // on '/' only, so `..\..\evil.txt` is one opaque segment that never equals
    // '..' — it passed, and Windows resolves it as a traversal all the same.
    it.each([
      ['..\\escape.txt'],
      ['..\\..\\Windows\\System32\\evil.dll'],
      ['sub\\..\\..\\escape.txt'],
    ])('throws on backslash traversal %s', (entryName) => {
      const name = Buffer.from(entryName, 'utf8');
      const payload = Buffer.from('test', 'utf8');
      const data = zlib.deflateRawSync(payload);
      const crc = crc32Manual(payload);

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(payload.length, 22);
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, data]);
      expect(() => readZipEntries(archive)).toThrow('Unsafe ZIP entry path');
    });

    it('bounds the inflate when the header understates the real size', () => {
      // The size and ratio guards read the entry header, which the archive
      // author controls. A header claiming a small size used to let an
      // unbounded inflateRawSync run anyway; maxOutputLength stops the
      // allocation before the declared-size mismatch is even reached.
      const payload = Buffer.alloc(4 * 1024 * 1024, 0x41); // compresses tiny
      const data = zlib.deflateRawSync(payload);
      const name = Buffer.from('bomb.txt', 'utf8');

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc32Manual(payload), 14);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(16, 22); // lie: claim 16 bytes uncompressed
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, data]);
      // Either zlib refuses to exceed maxOutputLength, or the size check
      // catches the lie — both are a rejection, neither expands unbounded.
      expect(() => readZipEntries(archive)).toThrow();
    });

    it('throws when ZIP has too many entries', () => {
      // We need to create an archive with 1001 entries
      // Instead, test the limit by creating entries that exceed maxEntries
      const entries: Array<{ name: string; data: string }> = [];
      for (let i = 0; i < 1001; i++) {
        entries.push({ name: `file${i}.txt`, data: 'x' });
      }
      // Use the round-trip to test: create large zip, read it
      // But 1001 small files might create a large zip - let's just create a smaller
      // zip and verify the limit logic is there
      const buf = createZipBuffer(entries);
      expect(() => readZipEntries(buf)).toThrow('ZIP contains too many entries');
    });

    it('returns empty map for non-ZIP data', () => {
      const archive = Buffer.from('not a zip file');
      const entries = readZipEntries(archive);
      expect(entries.size).toBe(0);
    });

    it('throws on suspicious compression ratio', () => {
      // Create entry with compressed size 1 and expected size > 1000
      const name = Buffer.from('test.txt', 'utf8');
      const compressed = Buffer.from([0]); // tiny compressed
      const crc = crc32Manual(Buffer.alloc(1001, 0x41)); // large expected

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8); // deflated
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(1001, 22); // huge expansion ratio
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, compressed]);
      expect(() => readZipEntries(archive)).toThrow('suspicious compression ratio');
    });

    it('throws on total size exceeding limit', () => {
      // We can't easily create a 128MB buffer, but we can test the per-entry limit
      // by creating an entry that claims huge expected size
      const name = Buffer.from('big.txt', 'utf8');
      const compressed = zlib.deflateRawSync(Buffer.from('test', 'utf8'));
      const crc = crc32Manual(Buffer.from('test', 'utf8'));

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(65 * 1024 * 1024 + 1, 22); // > 64MB maxEntryBytes
      header.writeUInt16LE(name.length, 26);

      const archive = Buffer.concat([header, name, compressed]);
      expect(() => readZipEntries(archive)).toThrow('ZIP expands beyond the configured size limit');
    });
  });
});

// Helper: CRC32 implementation matching the one in zip.ts
function crc32Manual(data: Uint8Array): number {
  const table = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}
