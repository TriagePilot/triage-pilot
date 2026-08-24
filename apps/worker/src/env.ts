import { loadGitHubAppCredentials, type GitHubAppCredentials } from "@triagepilot/github";

export interface WorkerEnv {
  databaseUrl: string;
  githubOrganization: string;
  github: GitHubAppCredentials;
  pollMs: number;
  workerId: string;
}

function readRequired(source: NodeJS.ProcessEnv, name: "DATABASE_URL" | "GITHUB_ORGANIZATION"): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

export async function readWorkerEnv(source: NodeJS.ProcessEnv, processId = process.pid): Promise<WorkerEnv> {
  const pollMs = Number(source.WORKER_POLL_MS === undefined ? 2000 : source.WORKER_POLL_MS.trim());
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error("WORKER_POLL_MS must be a positive number");
  }

  return {
    databaseUrl: readRequired(source, "DATABASE_URL"),
    githubOrganization: readRequired(source, "GITHUB_ORGANIZATION"),
    github: await loadGitHubAppCredentials(source),
    pollMs,
    workerId: source.WORKER_ID?.trim() || `worker-${processId}`,
  };
}
