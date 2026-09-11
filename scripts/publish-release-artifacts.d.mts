export type CommandResult = { stdout: string; stderr: string; exitCode: number };

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { allowFailure?: boolean; cwd?: string },
) => Promise<CommandResult>;

export function publishReleaseArtifacts(
  options: {
    artifactsDir?: string;
    version: string;
    tagName: string;
    imageName: string;
    gitCommit: string;
    databaseMigration: string;
    containerDigest: string;
  },
  command?: CommandRunner,
): Promise<{
  release: "matched" | "created";
  container: "matched" | "published";
  packages: Array<{ name: string; status: "matched" | "published" }>;
}>;
