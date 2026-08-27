import { describe, expect, it, vi } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

describe("GitHub webhook route", () => {
  it.each([
    [{ login: "someone", type: "User" }, "account_scope"],
    [{ login: "other-org", type: "Organization" }, "account_scope"],
  ])("acknowledges but ignores an out-of-scope repository owner %#", async (owner, ignored) => {
    const acceptRoutingDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptRoutingDelivery, logIgnoredWebhook }),
    );

    const response = await signedWebhook(app, pullRequestBody({ owner }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored });
    expect(acceptRoutingDelivery).not.toHaveBeenCalled();
    expect(logIgnoredWebhook).toHaveBeenCalledWith({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      accountType: "Organization",
      accountLogin: owner.login,
    });
    expect(logIgnoredWebhook.mock.calls[0]?.[0]).not.toHaveProperty("body");
  });

  it("accepts a matching organization pull request with metadata only", async () => {
    const acceptRoutingDelivery = vi.fn(async () => ({ inserted: true, jobId: "job-1" }));
    const body = pullRequestBody({ owner: { login: "AcMe", type: "Organization" } });
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptRoutingDelivery }));

    const response = await signedWebhook(app, body);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptRoutingDelivery).toHaveBeenCalledWith({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      eventAction: "opened",
      hookId: "hook-1",
      installation: { githubInstallationId: "99", accountLogin: "AcMe" },
      repository: { githubRepositoryId: "101", owner: "AcMe", name: "api" },
      payload: {
        kind: "process_change_request",
        deliveryId: "delivery-1",
        eventName: "change_request.opened",
        changeRequest: {
          repository: { provider: "github", externalId: "101", owner: "AcMe", name: "api" },
          externalId: "7",
          number: 7,
          baseRevision: "trusted-base-123",
          headRevision: "abc123",
        },
        isDraft: false,
        routingKey: "routing:00000000-0000-4000-8000-000000000001:github:101:7:trusted-base-123:abc123",
      },
    });
  });

  it("builds the routing job from the provider normalizer output", async () => {
    const acceptRoutingDelivery = vi.fn(async () => ({ inserted: true, jobId: "job-1" }));
    const normalizeGitHubWebhook = vi.fn(() => ({
      deliveryId: "delivery-1",
      eventName: "change_request" as const,
      eventAction: "synchronize",
      provider: "github" as const,
      externalConnectionId: "provider-connection-9",
      changeRequest: {
        repository: {
          provider: "github" as const,
          externalId: "repository-77",
          owner: "AcMe",
          name: "normalized-api",
        },
        externalId: "42",
        number: 42,
        baseRevision: "normalized-base",
        headRevision: "normalized-head",
      },
      actor: { externalId: "actor-5", displayName: "event-sender-71c9ab" },
      isDraft: true,
    }));
    const app = createWebApp(buildServices({ acceptRoutingDelivery, normalizeGitHubWebhook }));

    const response = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "raw-owner-must-be-ignored", type: "User" } }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(normalizeGitHubWebhook).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "pull_request",
      deliveryId: "delivery-1",
    }));
    expect(acceptRoutingDelivery).toHaveBeenCalledWith(expect.objectContaining({
      eventAction: "synchronize",
      installation: { githubInstallationId: "provider-connection-9", accountLogin: "AcMe" },
      repository: { githubRepositoryId: "repository-77", owner: "AcMe", name: "normalized-api" },
      payload: {
        kind: "process_change_request",
        deliveryId: "delivery-1",
        eventName: "change_request.synchronize",
        changeRequest: {
          repository: {
            provider: "github",
            externalId: "repository-77",
            owner: "AcMe",
            name: "normalized-api",
          },
          externalId: "42",
          number: 42,
          baseRevision: "normalized-base",
          headRevision: "normalized-head",
        },
        isDraft: true,
        routingKey: "routing:00000000-0000-4000-8000-000000000001:github:repository-77:42:normalized-base:normalized-head",
      },
    }));
  });

  it("passes an opened draft pull request to the worker for configuration-aware routing", async () => {
    const acceptRoutingDelivery = vi.fn(async () => ({ inserted: true, jobId: "job-1" }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptRoutingDelivery }));

    const response = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "acme", type: "Organization" }, draft: true }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptRoutingDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ isDraft: true }),
      }),
    );
  });

  it.each(["edited", "labeled", "review_requested", "converted_to_draft"])(
    "acknowledges but does not route an irrelevant pull-request action: %s",
    async (action) => {
      const acceptRoutingDelivery = vi.fn();
      const app = createWebApp(buildServices({ githubOrganization: "acme", acceptRoutingDelivery }));

      const response = await signedWebhook(
        app,
        pullRequestBody({ owner: { login: "acme", type: "Organization" }, action }),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, ignored: "action" });
      expect(acceptRoutingDelivery).not.toHaveBeenCalled();
    },
  );

  it("acknowledges a duplicate pull-request delivery", async () => {
    const acceptRoutingDelivery = vi.fn(async () => ({ inserted: false, jobId: null }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptRoutingDelivery }));

    const response = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "acme", type: "Organization" } }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it("enqueues a matching organization review with only policy-evaluation metadata", async () => {
    const acceptHumanReviewPolicyDelivery = vi.fn(async (_delivery) => ({
      inserted: true,
      jobId: "job-review-1",
    }));
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptHumanReviewPolicyDelivery }),
    );

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "AcMe", type: "Organization" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-1" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptHumanReviewPolicyDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-review-1",
        eventName: "pull_request_review",
        payload: expect.objectContaining({
          kind: "evaluate_human_review_policy",
          changeRequest: expect.objectContaining({ number: 7 }),
        }),
      }),
    );
    expect(acceptHumanReviewPolicyDelivery.mock.calls[0]?.[0]?.payload).toEqual({
      kind: "evaluate_human_review_policy",
      deliveryId: "delivery-review-1",
      changeRequest: {
        repository: { provider: "github", externalId: "101", owner: "AcMe", name: "api" },
        externalId: "7",
        number: 7,
      },
    });
  });

  it("acknowledges a duplicate review delivery", async () => {
    const acceptHumanReviewPolicyDelivery = vi.fn(async () => ({ inserted: false, jobId: null }));
    const app = createWebApp(buildServices({ acceptHumanReviewPolicyDelivery }));

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "acme", type: "Organization" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-1" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it("acknowledges but ignores an out-of-scope review", async () => {
    const acceptHumanReviewPolicyDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptHumanReviewPolicyDelivery, logIgnoredWebhook }),
    );

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "other-org", type: "Organization" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-out-of-scope" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "account_scope" });
    expect(acceptHumanReviewPolicyDelivery).not.toHaveBeenCalled();
    expect(logIgnoredWebhook).toHaveBeenCalledWith({
      eventName: "pull_request_review",
      deliveryId: "delivery-review-out-of-scope",
      accountType: "Organization",
      accountLogin: "other-org",
    });
  });

  it("replaces the repository snapshot when an installation becomes active", async () => {
    const replaceInstallationRepositories = vi.fn();
    const app = createWebApp(buildServices({ replaceInstallationRepositories }));

    const response = await signedWebhook(
      app,
      installationBody({ action: "created" }),
      { eventName: "installation" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(replaceInstallationRepositories).toHaveBeenCalledWith({
      githubInstallationId: "99",
      accountLogin: "acme",
      repositories: [
        { githubRepositoryId: "101", owner: "acme", name: "api" },
        { githubRepositoryId: "102", owner: "acme", name: "web" },
      ],
    });
  });

  it.each(["unsuspend", "new_permissions_accepted"])(
    "reactivates metadata without replacing repositories when %s omits the snapshot",
    async (action) => {
      const activateConfiguredInstallation = vi.fn();
      const replaceInstallationRepositories = vi.fn();
      const app = createWebApp(
        buildServices({ activateConfiguredInstallation, replaceInstallationRepositories }),
      );

      const response = await signedWebhook(
        app,
        installationBody({ action, includeRepositories: false }),
        { eventName: "installation" },
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true });
      expect(activateConfiguredInstallation).toHaveBeenCalledWith({
        githubInstallationId: "99",
        accountLogin: "acme",
      });
      expect(replaceInstallationRepositories).not.toHaveBeenCalled();
    },
  );

  it("suspends and deletes the configured installation projection", async () => {
    const suspendConfiguredInstallation = vi.fn();
    const deleteConfiguredInstallation = vi.fn();
    const app = createWebApp(
      buildServices({ suspendConfiguredInstallation, deleteConfiguredInstallation }),
    );

    const suspended = await signedWebhook(
      app,
      installationBody({ action: "suspend" }),
      { eventName: "installation", deliveryId: "delivery-suspend" },
    );
    const deleted = await signedWebhook(
      app,
      installationBody({ action: "deleted" }),
      { eventName: "installation", deliveryId: "delivery-delete" },
    );

    expect(suspended.status).toBe(202);
    expect(deleted.status).toBe(202);
    expect(suspendConfiguredInstallation).toHaveBeenCalledWith({
      githubInstallationId: "99",
      accountLogin: "acme",
    });
    expect(deleteConfiguredInstallation).toHaveBeenCalledWith({ githubInstallationId: "99" });
  });

  it.each([
    {
      action: "added",
      repositoriesAdded: [{ githubRepositoryId: "103", owner: "acme", name: "docs" }],
      repositoryIdsRemoved: [],
    },
    {
      action: "removed",
      repositoriesAdded: [],
      repositoryIdsRemoved: ["101"],
    },
  ])("maps installation repository action $action to its corresponding list", async (expected) => {
    const updateInstallationRepositories = vi.fn();
    const app = createWebApp(buildServices({ updateInstallationRepositories }));
    const body = JSON.stringify({
      action: expected.action,
      installation: {
        id: 99,
        account: { login: "acme", type: "Organization" },
      },
      repositories_added: [{ id: 103, name: "docs" }],
      repositories_removed: [{ id: 101, name: "api" }],
    });

    const response = await signedWebhook(app, body, { eventName: "installation_repositories" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(updateInstallationRepositories).toHaveBeenCalledWith({
      githubInstallationId: "99",
      accountLogin: "acme",
      repositoriesAdded: expected.repositoriesAdded,
      repositoryIdsRemoved: expected.repositoryIdsRemoved,
    });
  });

  it("acknowledges an unknown installation repository action without mutation", async () => {
    const updateInstallationRepositories = vi.fn();
    const app = createWebApp(buildServices({ updateInstallationRepositories }));
    const body = JSON.stringify({
      action: "renamed_in_the_future",
      installation: {
        id: 99,
        account: { login: "acme", type: "Organization" },
      },
      repositories_added: [{ id: 103, name: "docs" }],
      repositories_removed: [{ id: 101, name: "api" }],
    });

    const response = await signedWebhook(app, body, { eventName: "installation_repositories" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "event" });
    expect(updateInstallationRepositories).not.toHaveBeenCalled();
  });

  it("acknowledges a signed unsupported event without parsing its payload", async () => {
    const acceptRoutingDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const verifySignature = vi.fn(async () => {});
    const app = createWebApp(buildServices({ acceptRoutingDelivery, logIgnoredWebhook, verifySignature }));

    const response = await signedWebhook(app, "not-json", { eventName: "push" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "event" });
    expect(verifySignature).toHaveBeenCalledWith({
      body: "not-json",
      secret: "hook-secret",
      signature: "sha256=test",
    });
    expect(acceptRoutingDelivery).not.toHaveBeenCalled();
    expect(logIgnoredWebhook).not.toHaveBeenCalled();
  });
});

const pullRequestBody = ({
  owner,
  action = "opened",
  draft = false,
}: {
  owner: { login: string; type: string };
  action?: string;
  draft?: boolean;
}) =>
  JSON.stringify({
    action,
    installation: { id: 99 },
    sender: { id: 502, login: "event-sender-71c9ab" },
    repository: { id: 101, name: "api", owner },
    pull_request: {
      id: 7001,
      number: 7,
      draft,
      base: { sha: "trusted-base-123" },
      head: { sha: "abc123" },
    },
  });

const pullRequestReviewBody = ({ owner }: { owner: { login: string; type: string } }) =>
  JSON.stringify({
    action: "submitted",
    installation: { id: 99 },
    sender: { id: 503, login: "reviewer-82df10" },
    repository: { id: 101, name: "api", owner },
    pull_request: {
      id: 7001,
      number: 7,
      draft: false,
      base: { sha: "trusted-base-123" },
      head: { sha: "abc123" },
    },
    review: {
      state: "approved",
      body: "This review body must not enter the durable job payload.",
      commit_id: "reviewed-commit-sha",
    },
  });

const installationBody = ({
  action,
  includeRepositories = true,
}: {
  action: string;
  includeRepositories?: boolean;
}) => {
  const payload: Record<string, unknown> = {
    action,
    installation: {
      id: 99,
      account: { login: "acme", type: "Organization" },
    },
  };
  if (includeRepositories) {
    payload.repositories = [
      { id: 101, name: "api" },
      { id: 102, name: "web" },
    ];
  }
  return JSON.stringify(payload);
};

const signedWebhook = (
  app: ReturnType<typeof createWebApp>,
  body: string,
  options: { eventName?: string; deliveryId?: string } = {},
) =>
  app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-event": options.eventName ?? "pull_request",
      "x-github-delivery": options.deliveryId ?? "delivery-1",
      "x-github-hook-id": "hook-1",
      "x-hub-signature-256": "sha256=test",
    },
    body,
  });
