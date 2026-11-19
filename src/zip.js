// Minimal ZIP reader: enough to pull named entries out of a .docx.
// Supports stored (0) and deflated (8) entries, and caps inflated size to
// guard against zip bombs.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

export class ZipError extends Error {}

function findEndOfCentralDirectory(buf) {
  // EOCD is 22 bytes plus an optional comment of up to 65535 bytes.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('Not a valid zip archive');
}

export function readZipEntries(buf) {
  if (buf.length < 22) throw new ZipError('Not a valid zip archive');
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new ZipError('Corrupt zip central directory');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractEntry(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const { method, compressedSize, localOffset } = entry;
  if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new ZipError('Corrupt zip entry');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compressedSize);

  if (method === 0) return data;
  if (method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch {
      throw new ZipError('Zip entry is corrupt or too large');
    }
  }
  throw new ZipError(`Unsupported zip compression method ${method}`);
}
