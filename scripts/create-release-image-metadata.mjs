#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validateOciLayoutArchive } from "./safe-oci-layout-tar.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const execFileAsync = promisify(execFile);

export function createReleaseImageMetadata(buildxMetadata, publishableDescriptor) {
  const digest = buildxMetadata?.["containerimage.digest"];
  const buildxDescriptor = buildxMetadata?.["containerimage.descriptor"];
  if (!digestPattern.test(digest ?? "")) {
    throw new Error("Buildx metadata does not contain a valid container digest.");
  }
  if (!buildxDescriptor || typeof buildxDescriptor !== "object" || Array.isArray(buildxDescriptor)) {
    throw new Error("Buildx metadata does not contain a container descriptor.");
  }
  if (buildxDescriptor.digest !== digest) {
    throw new Error("Buildx metadata digest and descriptor digest do not match.");
  }
  const descriptor = validatePublishableDescriptor(publishableDescriptor, digest);
  if (buildxDescriptor.mediaType !== descriptor.mediaType || buildxDescriptor.size !== descriptor.size) {
    throw new Error("Buildx metadata descriptor does not match the publishable OCI index descriptor.");
  }

  const annotations = sortedStringRecord(descriptor.annotations, "Publishable OCI image annotation");
  return {
    "containerimage.digest": digest,
    "containerimage.descriptor": {
      mediaType: descriptor.mediaType,
      digest,
      size: descriptor.size,
      annotations,
    },
  };
}

export async function readPublishableDescriptor(ociArchivePath, digest) {
  await validateOciLayoutArchive(ociArchivePath);
  const { stdout: indexJson } = await execFileAsync("tar", ["-xOf", ociArchivePath, "index.json"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const index = JSON.parse(indexJson);
  const descriptor = index?.manifests?.find((entry) => entry?.digest === digest);
  validatePublishableDescriptor(descriptor, digest);

  const blobPath = `blobs/sha256/${digest.slice("sha256:".length)}`;
  const { stdout: imageIndexJson } = await execFileAsync("tar", ["-xOf", ociArchivePath, blobPath], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  const actualDigest = `sha256:${createHash("sha256").update(imageIndexJson).digest("hex")}`;
  if (actualDigest !== digest) {
    throw new Error(`Publishable OCI image index bytes do not match ${digest}.`);
  }
  if (imageIndexJson.length !== descriptor.size) {
    throw new Error("Publishable OCI image index size does not match its descriptor.");
  }
  const imageIndex = JSON.parse(imageIndexJson.toString("utf8"));
  if (imageIndex.mediaType !== descriptor.mediaType) {
    throw new Error("Publishable OCI image index media type does not match its descriptor.");
  }

  return { ...descriptor, annotations: imageIndex.annotations };
}

function validatePublishableDescriptor(descriptor, digest) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Publishable OCI archive does not contain the release image descriptor.");
  }
  if (descriptor.digest !== digest) {
    throw new Error("Publishable OCI image descriptor digest does not match Buildx metadata.");
  }
  if (typeof descriptor.mediaType !== "string" || descriptor.mediaType.length === 0) {
    throw new Error("Publishable OCI image descriptor does not contain a media type.");
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    throw new Error("Publishable OCI image descriptor does not contain a valid size.");
  }
  if (!descriptor.annotations || typeof descriptor.annotations !== "object" || Array.isArray(descriptor.annotations)) {
    throw new Error("Publishable OCI image index does not contain annotations.");
  }
  return descriptor;
}

function sortedStringRecord(record, label) {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => {
        if (typeof value !== "string") throw new Error(`${label} ${key} is not a string.`);
        return [key, value];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--input":
        options.input = value;
        index += 1;
        break;
      case "--output":
        options.output = value;
        index += 1;
        break;
      case "--oci-archive":
        options.ociArchive = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!options.input || !options.output || !options.ociArchive) throw new Error("Missing required arguments.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const buildxMetadata = JSON.parse(await readFile(options.input, "utf8"));
  const metadata = createReleaseImageMetadata(
    buildxMetadata,
    await readPublishableDescriptor(options.ociArchive, buildxMetadata["containerimage.digest"]),
  );
  await writeFile(options.output, `${JSON.stringify(metadata, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
