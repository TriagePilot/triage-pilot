#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function createReleaseImageMetadata(buildxMetadata) {
  const digest = buildxMetadata?.["containerimage.digest"];
  const descriptor = buildxMetadata?.["containerimage.descriptor"];
  if (!digestPattern.test(digest ?? "")) {
    throw new Error("Buildx metadata does not contain a valid container digest.");
  }
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Buildx metadata does not contain a container descriptor.");
  }
  if (descriptor.digest !== digest) {
    throw new Error("Buildx metadata digest and descriptor digest do not match.");
  }
  if (typeof descriptor.mediaType !== "string" || descriptor.mediaType.length === 0) {
    throw new Error("Buildx metadata container descriptor does not contain a media type.");
  }
  if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
    throw new Error("Buildx metadata container descriptor does not contain a valid size.");
  }
  if (!descriptor.annotations || typeof descriptor.annotations !== "object" || Array.isArray(descriptor.annotations)) {
    throw new Error("Buildx metadata container descriptor does not contain annotations.");
  }

  const annotations = Object.fromEntries(
    Object.entries(descriptor.annotations)
      .map(([key, value]) => {
        if (typeof value !== "string") throw new Error(`Buildx metadata annotation ${key} is not a string.`);
        return [key, value];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
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
      default:
        throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!options.input || !options.output) throw new Error("Missing required arguments.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const metadata = createReleaseImageMetadata(JSON.parse(await readFile(options.input, "utf8")));
  await writeFile(options.output, `${JSON.stringify(metadata, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
