export function createReleaseNotes(options: {
  manifestPath: string;
  outputPath: string;
}): Promise<{ outputPath: string; content: string }>;
export function renderReleaseNotes(manifest: {
  version: string;
  gitCommit: string;
  license: string;
  publishedAt: string;
  futureLicenseEffectiveAt: string;
  packages: Array<{ name: string; version: string; sha256: string }>;
  databaseMigration: { id: string };
  container: { digest: string };
}): string;
