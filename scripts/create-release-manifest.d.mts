export interface ReleaseManifestPackage {
  name: string;
  version: string;
  publishedAt: string;
  futureLicenseEffectiveAt: string;
  tarball: string;
  sha256: string;
}

export interface ReleaseManifest {
  version: string;
  gitCommit: string;
  license: string;
  publishedAt: string;
  futureLicenseEffectiveAt: string;
  packages: ReleaseManifestPackage[];
  contracts: { package: string; sha256: string | null };
  databaseMigration: { id: string; package: string };
  container: { digest: string; imageVersion: string; publishedAt: string; futureLicenseEffectiveAt: string };
}

export interface ReleaseManifestExpectations {
  version: string;
  gitCommit: string;
  databaseMigration: string;
  containerDigest: string;
}

export function createReleaseManifest(options: {
  cwd?: string;
  version: string;
  gitCommit: string;
  expectedDatabaseMigration?: string;
  containerDigest: string;
  publishedAt: string;
  ociMetadataPath: string;
  packageTarballs: string[];
}): Promise<{ outputPath: string; content: string }>;
export function deriveFutureLicenseEffectiveAt(publishedAt: string): string;
export function findHighestDatabaseMigration(repoRoot: string): Promise<string>;
export function readImageReleaseMetadata(
  ociMetadataPath: string,
  digest: string,
): Promise<{ version: string; license: string; revision: string; publishedAt: string; futureLicenseEffectiveAt: string }>;
export function readImageVersionFromOciMetadata(ociMetadataPath: string, digest: string): Promise<string>;
export function validateReleaseManifest(
  manifest: ReleaseManifest,
  expectations: ReleaseManifestExpectations,
): ReleaseManifest;
