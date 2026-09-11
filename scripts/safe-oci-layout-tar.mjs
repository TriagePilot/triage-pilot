import { readFile } from "node:fs/promises";
import { posix } from "node:path";

const allowedEntryTypes = new Set(["0", "5"]);
const tarBlockSize = 512;

export async function validateOciLayoutArchive(tarPath) {
  validateTarEntries(await listTarEntries(tarPath));
}

async function listTarEntries(tarPath) {
  const archive = await readFile(tarPath);
  if (archive.length % tarBlockSize !== 0) {
    throw new Error("Malformed OCI layout archive: length is not a multiple of 512 bytes.");
  }

  const entries = [];
  for (let offset = 0; offset < archive.length;) {
    const header = archive.subarray(offset, offset + tarBlockSize);
    if (isZeroBlock(header)) {
      validateEndOfArchive(archive, offset);
      return entries;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryName = prefix.length > 0 ? `${prefix}/${name}` : name;
    validateTarHeaderChecksum(header, entryName);
    const typeflag = readTarTypeflag(header);
    const linkname = readTarString(header, 157, 100);
    const size = parseTarOctal(header, 124, 12, "size", entryName);
    const payloadStart = offset + tarBlockSize;
    const payloadEnd = safeAdd(payloadStart, size, `OCI layout archive entry ${entryName} payload size`);
    const paddedPayloadSize = roundUpToTarBlock(size, entryName);
    const nextOffset = safeAdd(payloadStart, paddedPayloadSize, `OCI layout archive entry ${entryName} padded size`);
    if (payloadEnd > archive.length || nextOffset > archive.length) {
      throw new Error(`Malformed OCI layout archive: entry ${entryName} payload exceeds archive size.`);
    }
    if (archive.subarray(payloadEnd, nextOffset).some((byte) => byte !== 0)) {
      throw new Error(`Malformed OCI layout archive: entry ${entryName} has nonzero padding.`);
    }
    entries.push({ name: entryName, typeflag, linkname });
    offset = nextOffset;
  }

  throw new Error("Malformed OCI layout archive: missing end-of-archive marker.");
}

function validateTarEntries(entries) {
  for (const entry of entries) {
    if (!allowedEntryTypes.has(entry.typeflag)) {
      throw new Error(`Unsupported OCI layout archive entry type ${entry.typeflag} at ${entry.name}.`);
    }
    if (entry.linkname.length > 0) {
      throw new Error(`Unsupported OCI layout archive link target at ${entry.name}.`);
    }
    validateTarEntryPath(entry.name);
  }
}

function validateTarEntryPath(entryName) {
  const normalizedEntry = entryName.endsWith("/") ? entryName.slice(0, -1) : entryName;
  if (normalizedEntry.length === 0 || posix.isAbsolute(normalizedEntry) || normalizedEntry.includes("\\")) {
    throw new Error(`Unsafe OCI layout archive entry ${entryName}.`);
  }
  const segments = normalizedEntry.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe OCI layout archive entry ${entryName}.`);
  }
}

function readTarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  const sliceEnd = end === -1 || end > offset + length ? offset + length : end;
  return header.toString("utf8", offset, sliceEnd).trim();
}

function readTarTypeflag(header) {
  const byte = header[156];
  return byte === 0 ? "0" : String.fromCharCode(byte);
}

function parseTarOctal(header, offset, length, label, entryName) {
  const field = header.subarray(offset, offset + length);
  if (field.length !== length) {
    throw new Error(`Invalid OCI layout archive numeric field ${label} at ${entryName}.`);
  }
  const nulIndex = field.indexOf(0);
  const valueBytes = nulIndex === -1 ? field : field.subarray(0, nulIndex);
  const trailingBytes = nulIndex === -1 ? Buffer.alloc(0) : field.subarray(nulIndex + 1);
  if (trailingBytes.some((byte) => byte !== 0 && byte !== 32)) {
    throw new Error(`Invalid OCI layout archive numeric field ${label} at ${entryName}.`);
  }
  const digits = trimAsciiSpaces(valueBytes);
  if (digits.length === 0 || digits.some((byte) => byte < 48 || byte > 55)) {
    throw new Error(`Invalid OCI layout archive numeric field ${label} at ${entryName}.`);
  }
  const raw = digits.toString("ascii");
  const size = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`OCI layout archive numeric field ${label} at ${entryName} exceeds supported safe integer range.`);
  }
  return size;
}

function trimAsciiSpaces(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === 32) start += 1;
  while (end > start && value[end - 1] === 32) end -= 1;
  return value.subarray(start, end);
}

function validateTarHeaderChecksum(header, entryName) {
  const expectedChecksum = parseTarOctal(header, 148, 8, "checksum", entryName);
  let actualChecksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Invalid OCI layout archive header checksum at ${entryName}.`);
  }
}

function validateEndOfArchive(archive, offset) {
  const secondEndBlock = archive.subarray(offset + tarBlockSize, offset + tarBlockSize * 2);
  if (secondEndBlock.length !== tarBlockSize || !isZeroBlock(secondEndBlock)) {
    throw new Error("Malformed OCI layout archive: missing second zero end-of-archive block.");
  }
  const trailingArchive = archive.subarray(offset + tarBlockSize * 2);
  if (trailingArchive.some((byte) => byte !== 0)) {
    throw new Error("Malformed OCI layout archive: trailing data after end-of-archive marker.");
  }
}

function roundUpToTarBlock(size, entryName) {
  if (size > Number.MAX_SAFE_INTEGER - (tarBlockSize - 1)) {
    throw new Error(`OCI layout archive entry ${entryName} padded size exceeds supported safe integer range.`);
  }
  return Math.ceil(size / tarBlockSize) * tarBlockSize;
}

function safeAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} exceeds supported safe integer range.`);
  }
  return value;
}

function isZeroBlock(block) {
  return block.length === tarBlockSize && block.every((byte) => byte === 0);
}
