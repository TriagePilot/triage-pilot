import { describe, expect, it, vi } from "vitest";

import type {
  ConfigurationDocument,
  ConfigurationSource,
  OrganizationConfigurationDocument,
  RepositoryRef,
} from "@triagepilot/contracts";
import { resolveConfiguration } from "../src/index";

const repository: RepositoryRef = {
  provider: "github",
  externalId: "repository-1",
  owner: "example",
  name: "service",
};

function repositoryDocument(content: string): ConfigurationDocument {
  return { content, path: ".triagepilot.yml", revision: "base-sha" };
}

function organizationDocument(content: string): OrganizationConfigurationDocument {
  return { content, path: "workspace/defaults.yml", revision: "organization-revision", version: "organization-v3" };
}

async function resolveFixture(input: {
  organization?: string;
  repository?: string;
  allowOrganizationEnforce?: boolean;
}) {
  const source: ConfigurationSource = {
    loadOrganization: vi.fn().mockResolvedValue(
      input.organization === undefined ? null : organizationDocument(input.organization),
    ),
    loadRepository: vi.fn().mockResolvedValue(
      input.repository === undefined ? null : repositoryDocument(input.repository),
    ),
  };

  return resolveConfiguration({
    workspaceId: "workspace-1",
    repository,
    trustedRevision: "base-sha",
    source,
    allowOrganizationEnforce: input.allowOrganizationEnforce ?? true,
  });
}

describe("resolveConfiguration", () => {
  it.each([
    {
      name: "built-in defaults when neither document exists",
      input: {},
      expected: { mode: "shadow", inheritanceMode: "defaults", modeSource: "default" },
    },
    {
      name: "organization configuration when the repository document is absent",
      input: { organization: "mode: enforce" },
      expected: { mode: "enforce", inheritanceMode: "organization", modeSource: "organization" },
    },
    {
      name: "repository replacement without inheritance",
      input: { organization: "mode: enforce", repository: "mode: shadow" },
      expected: { mode: "shadow", inheritanceMode: "replace", modeSource: "repository" },
    },
    {
      name: "repository replacement omission defaults to shadow",
      input: { organization: "mode: enforce", repository: "ownership:\n  fallback_reviewers: [\"@repository\"]" },
      expected: { mode: "shadow", inheritanceMode: "replace", modeSource: "default" },
    },
    {
      name: "repository shadow overrides organization enforce while inheriting",
      input: { organization: "mode: enforce", repository: "inheritance: true\nmode: shadow" },
      expected: { mode: "shadow", inheritanceMode: "inherit", modeSource: "repository" },
    },
  ])("uses $name", async ({ input, expected }) => {
    const result = await resolveFixture(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected resolved configuration");
    expect(result.config.mode).toBe(expected.mode);
    expect(result.provenance.inheritanceMode).toBe(expected.inheritanceMode);
    expect(result.provenance.sources["$.mode"]).toBe(expected.modeSource);
    expect(result.provenance.effectiveHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("inherits organization values and merges arrays repository-first", async () => {
    const result = await resolveFixture({
      organization: `mode: enforce\nownership:\n  fallback_reviewers: ["@parent"]`,
      repository: `inheritance: true\nownership:\n  fallback_reviewers: ["@child", "@parent"]`,
    });

    expect(result).toMatchObject({
      ok: true,
      config: { mode: "enforce", ownership: { fallbackReviewers: ["@child", "@parent"] } },
      provenance: {
        organizationVersion: "organization-v3",
        repositoryPath: ".triagepilot.yml",
        repositoryRevision: "base-sha",
        inheritanceMode: "inherit",
        sources: {
          "$.mode": "organization",
          "$.ownership.fallbackReviewers.0": "repository",
          "$.ownership.fallbackReviewers.1": "repository",
        },
      },
    });
  });

  it("attributes inherited non-colliding array entries to the organization", async () => {
    const result = await resolveFixture({
      organization: `ownership:\n  fallback_reviewers: ["@parent"]`,
      repository: `inheritance: true\nownership:\n  fallback_reviewers: ["@child"]`,
    });

    expect(result).toMatchObject({
      ok: true,
      config: { ownership: { fallbackReviewers: ["@child", "@parent"] } },
      provenance: {
        sources: {
          "$.ownership.fallbackReviewers.0": "repository",
          "$.ownership.fallbackReviewers.1": "organization",
        },
      },
    });
  });

  it("prevents organization configuration from enabling OSS writes without a trusted repository document", async () => {
    const result = await resolveFixture({
      organization: "mode: enforce",
      allowOrganizationEnforce: false,
    });

    expect(result).toMatchObject({
      ok: true,
      config: { mode: "shadow" },
      provenance: {
        inheritanceMode: "organization",
        sources: { "$.mode": "default" },
      },
    });
  });

  it("resolves replacement repository configuration without loading the organization source", async () => {
    const loadOrganization = vi.fn().mockRejectedValue(new Error("organization store unavailable"));
    const source: ConfigurationSource = {
      loadOrganization,
      loadRepository: vi.fn().mockResolvedValue(repositoryDocument("mode: enforce")),
    };

    const result = await resolveConfiguration({
      workspaceId: "workspace-1",
      repository,
      trustedRevision: "base-sha",
      source,
      allowOrganizationEnforce: true,
    });

    expect(result).toMatchObject({
      ok: true,
      config: { mode: "enforce" },
      provenance: {
        organizationVersion: null,
        inheritanceMode: "replace",
        sources: { "$.mode": "repository" },
      },
    });
    expect(loadOrganization).not.toHaveBeenCalled();
  });

  it("preserves organization provenance when OSS organization mode is already shadow", async () => {
    const result = await resolveFixture({
      organization: "mode: shadow",
      allowOrganizationEnforce: false,
    });

    expect(result).toMatchObject({
      ok: true,
      config: { mode: "shadow" },
      provenance: {
        inheritanceMode: "organization",
        sources: { "$.mode": "organization" },
      },
    });
  });

  it("returns diagnostics and no effective hash for malformed source configuration", async () => {
    const result = await resolveFixture({
      repository: `risk:\n  paths:\n    - { pattern: "src/**", weight: 20, tag: first }\n    - { pattern: " SRC/** ", weight: 30, tag: second }`,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ path: "$.risk.paths[1].pattern" }],
      provenance: {
        repositoryPath: ".triagepilot.yml",
        repositoryRevision: "base-sha",
        inheritanceMode: "replace",
        effectiveHash: null,
      },
    });
  });

  it("rejects inheritance controls in organization documents", async () => {
    const result = await resolveFixture({ organization: "inheritance: true\nmode: enforce" });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ path: "$.inheritance" }],
      provenance: { inheritanceMode: "organization", effectiveHash: null },
    });
  });

  it("hashes canonical JSON deterministically across reordered source keys", async () => {
    const first = await resolveFixture({
      repository: "mode: enforce\nownership:\n  fallback_reviewers: [\"@reviewer\"]",
    });
    const second = await resolveFixture({
      repository: "ownership:\n  fallback_reviewers: [\"@reviewer\"]\nmode: enforce",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.provenance.effectiveHash).toBe(second.provenance.effectiveHash);
  });

  it("loads repository configuration at the trusted revision", async () => {
    const source: ConfigurationSource = {
      loadOrganization: vi.fn().mockResolvedValue(null),
      loadRepository: vi.fn().mockResolvedValue(null),
    };

    await resolveConfiguration({
      workspaceId: "workspace-1",
      repository,
      trustedRevision: "trusted-base",
      source,
      allowOrganizationEnforce: false,
    });

    expect(source.loadOrganization).toHaveBeenCalledWith("workspace-1");
    expect(source.loadRepository).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      repository,
      trustedRevision: "trusted-base",
    });
  });
});
