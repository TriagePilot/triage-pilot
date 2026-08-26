import { describe, expect, it, vi } from "vitest";

import { GitHubConfigurationSource } from "../src/adapter";

const repository = {
  provider: "github" as const,
  externalId: "101",
  owner: "acme",
  name: "api",
};

const requestInput = {
  workspaceId: "workspace-1",
  repository,
  trustedRevision: "base-sha",
};

describe("GitHubConfigurationSource", () => {
  it("loads the root configuration without reading the legacy path", async () => {
    const request = vi.fn().mockResolvedValue({ data: encoded("mode: shadow") });
    const source = new GitHubConfigurationSource({ request });

    await expect(source.loadRepository(requestInput)).resolves.toEqual({
      content: "mode: shadow",
      revision: "base-sha",
      path: ".triagepilot.yml",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "acme",
      repo: "api",
      path: ".triagepilot.yml",
      ref: "base-sha",
    });
  });

  it("falls back to the legacy path when the root configuration is absent", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(gitHubError(404))
      .mockResolvedValueOnce({ data: encoded("mode: enforce") });
    const source = new GitHubConfigurationSource({ request });

    await expect(source.loadRepository(requestInput)).resolves.toEqual({
      content: "mode: enforce",
      revision: "base-sha",
      path: ".github/triagepilot.yml",
    });
    expect(request).toHaveBeenNthCalledWith(1, "GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "acme",
      repo: "api",
      path: ".triagepilot.yml",
      ref: "base-sha",
    });
    expect(request).toHaveBeenNthCalledWith(2, "GET /repos/{owner}/{repo}/contents/{path}", {
      owner: "acme",
      repo: "api",
      path: ".github/triagepilot.yml",
      ref: "base-sha",
    });
  });

  it("returns null when neither configuration path exists", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(gitHubError(404))
      .mockRejectedValueOnce(gitHubError(404));
    const source = new GitHubConfigurationSource({ request });

    await expect(source.loadRepository(requestInput)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not fall back when the root configuration read is forbidden", async () => {
    const forbidden = gitHubError(403);
    const request = vi.fn().mockRejectedValue(forbidden);
    const source = new GitHubConfigurationSource({ request });

    await expect(source.loadRepository(requestInput)).rejects.toBe(forbidden);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

function encoded(content: string) {
  return { content: Buffer.from(content).toString("base64") };
}

function gitHubError(status: number) {
  return Object.assign(new Error(`GitHub request failed with ${status}`), { status });
}
