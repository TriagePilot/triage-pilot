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
  version: string;
  gitCommit: string;
  databaseMigration: string;
  containerDigest: string;
  packageTarballs: string[];
}): Promise<{ outputPath: string; content: string }>;
