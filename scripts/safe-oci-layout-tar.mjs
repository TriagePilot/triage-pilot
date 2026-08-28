import { readFile } from "node:fs/promises";
import { posix } from "node:path";

const allowedEntryTypes = new Set(["0", "5"]);

export async function validateOciLayoutArchive(tarPath) {
  validateTarEntries(await listTarEntries(tarPath));
}

async function listTarEntries(tarPath) {
  const archive = await readFile(tarPath);
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const typeflag = readTarTypeflag(header);
    const linkname = readTarString(header, 157, 100);
    const size = parseTarOctal(header, 124, 12);
    entries.push({ name: entryName, typeflag, linkname });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
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

function parseTarOctal(header, offset, length) {
  const raw = readTarString(header, offset, length).trim();
  if (raw.length === 0) return 0;
  const size = Number.parseInt(raw, 8);
  if (!Number.isFinite(size)) throw new Error("Invalid OCI layout archive entry size.");
  return size;
}
