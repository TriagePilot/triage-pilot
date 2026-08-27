export interface ReleaseManifestPackage {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
}

export interface ReleaseManifest {
  version: string;
  gitCommit: string;
  packages: ReleaseManifestPackage[];
  contracts: { package: string; sha256: string | null };
  databaseMigration: { id: string; package: string };
  container: { digest: string; imageVersion: string };
}

export function createReleaseManifest(options: {
  cwd?: string;
  version: string;
  gitCommit: string;
  expectedDatabaseMigration?: string;
  containerDigest: string;
  ociMetadataPath: string;
  packageTarballs: string[];
}): Promise<{ outputPath: string; content: string }>;
export function findHighestDatabaseMigration(repoRoot: string): Promise<string>;
export function readImageVersionFromOciMetadata(ociMetadataPath: string, digest: string): Promise<string>;
