import { describe, expect, it } from "vitest";

import { createReleaseImageMetadata } from "../scripts/create-release-image-metadata.mjs";

describe("createReleaseImageMetadata", () => {
  it("keeps only deterministic digest, descriptor, and sorted annotation evidence", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const publishableDescriptor = {
      size: 123,
      digest,
      mediaType: "application/vnd.oci.image.index.v1+json",
      annotations: { z: "last", a: "first" },
    };
    expect(
      createReleaseImageMetadata(
        {
          "buildx.build.ref": "builder/random-invocation-id",
          "buildx.build.provenance": { runDetails: { metadata: { startedOn: "now" } } },
          "containerimage.digest": digest,
          "containerimage.descriptor": publishableDescriptor,
        },
        publishableDescriptor,
      ),
    ).toEqual({
      "containerimage.digest": digest,
      "containerimage.descriptor": {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest,
        size: 123,
        annotations: { a: "first", z: "last" },
      },
    });
  });

  it("rejects inconsistent Buildx digest evidence", () => {
    expect(() =>
      createReleaseImageMetadata({
        "containerimage.digest": `sha256:${"a".repeat(64)}`,
        "containerimage.descriptor": {
          digest: `sha256:${"b".repeat(64)}`,
          mediaType: "application/vnd.oci.image.index.v1+json",
          size: 123,
          annotations: {},
        },
      }),
    ).toThrow("Buildx metadata digest and descriptor digest do not match.");
  });

  it("uses the publishable OCI index annotations when Buildx omits them", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    expect(
      createReleaseImageMetadata(
        {
          "containerimage.digest": digest,
          "containerimage.descriptor": {
            digest,
            mediaType: "application/vnd.oci.image.index.v1+json",
            size: 321,
            annotations: { "org.opencontainers.image.created": "2026-08-28T10:20:30Z" },
          },
        },
        {
          digest,
          mediaType: "application/vnd.oci.image.index.v1+json",
          size: 321,
          annotations: {
            "org.opencontainers.image.revision": "release-commit",
            "org.opencontainers.image.version": "0.1.0",
          },
        },
      ),
    ).toEqual({
      "containerimage.digest": digest,
      "containerimage.descriptor": {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest,
        size: 321,
        annotations: {
          "org.opencontainers.image.revision": "release-commit",
          "org.opencontainers.image.version": "0.1.0",
        },
      },
    });
  });
});
