import { expect, it, vi } from "vitest";

import { readSelfHostedEffectiveConfiguration } from "../src/composition/self-hosted";

it("resolves effective configuration for the requested real repository at its trusted default revision", async () => {
  const findRepositoryConfigurationTarget = vi.fn().mockResolvedValue({
    providerConnectionId: "connection-1",
    externalConnectionId: "99",
    repository: {
      provider: "github",
      externalId: "101",
      owner: "acme",
      name: "api",
    },
  });
  const request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
    if (route === "GET /repos/{owner}/{repo}") return { data: { default_branch: "main" } };
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}") return { data: { sha: "trusted-main-sha" } };
    if (route === "GET /repos/{owner}/{repo}/contents/{path}" && parameters.path === ".triagepilot.yml") {
      return { data: { content: Buffer.from("mode: enforce").toString("base64") } };
    }
    throw Object.assign(new Error(`unexpected request ${route}`), { status: 404 });
  });

  const result = await readSelfHostedEffectiveConfiguration({
    workspaceId: "workspace-1",
    repositoryId: "repository-row-1",
    repositories: { findRepositoryConfigurationTarget } as never,
    github: {
      appId: "123",
      privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      webhookSecret: "webhook-secret",
    },
    createRequester: vi.fn(async () => ({ request })) as never,
  });

  expect(findRepositoryConfigurationTarget).toHaveBeenCalledWith("repository-row-1");
  expect(result).toMatchObject({
    repository: { label: "acme/api", href: "https://github.com/acme/api" },
    trustedPath: ".triagepilot.yml",
    trustedRevision: "trusted-main-sha",
    repositoryRevision: "trusted-main-sha",
    inheritanceMode: "replace",
  });
  expect(result.values).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "$.mode", value: "enforce", source: "repository" }),
  ]));
  expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/contents/{path}", {
    owner: "acme",
    repo: "api",
    path: ".triagepilot.yml",
    ref: "trusted-main-sha",
  });
});
