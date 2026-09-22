import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repository = new URL("..", import.meta.url);
const composeFiles = ["-f", "docker-compose.yml", "-f", "docker-compose.release.yml"];

type ComposeService = {
  build?: unknown;
  command?: string[];
  image?: string;
};

type ComposeConfig = {
  services: Record<string, ComposeService>;
};

async function resolveReleaseCompose(environment: NodeJS.ProcessEnv = {}): Promise<ComposeConfig> {
  const { stdout } = await execFileAsync("docker", ["compose", ...composeFiles, "config", "--format", "json"], {
    cwd: repository,
    env: { ...process.env, ...environment },
  });

  return JSON.parse(stdout) as ComposeConfig;
}

describe("release image Compose deployment", () => {
  it("runs web and worker from the repository release version without source builds", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const config = await resolveReleaseCompose();
    const expectedImage = `ghcr.io/triagepilot/triage-pilot:${manifest.version}`;

    expect(config.services.web).toMatchObject({
      image: expectedImage,
      command: ["pnpm", "--filter", "@triagepilot/web", "start"],
    });
    expect(config.services.worker).toMatchObject({
      image: expectedImage,
      command: ["pnpm", "--filter", "@triagepilot/worker", "start"],
    });
    expect(config.services.web).not.toHaveProperty("build");
    expect(config.services.worker).not.toHaveProperty("build");
    expect(config.services.postgres.image).toBe("postgres:16");
  });

  it("accepts an exact digest-pinned image for both application services", async () => {
    const pinnedImage = `ghcr.io/triagepilot/triage-pilot:1.1.0@sha256:${"a".repeat(64)}`;
    const config = await resolveReleaseCompose({ TRIAGEPILOT_IMAGE: pinnedImage });

    expect(config.services.web.image).toBe(pinnedImage);
    expect(config.services.worker.image).toBe(pinnedImage);
  });
});
