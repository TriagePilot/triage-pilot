import { describe, expect, it, vi } from "vitest";

import { createWebApp } from "../src/app";
import { buildServices } from "./helpers";

describe("GitHub webhook route", () => {
  it.each([
    [{ login: "someone", type: "User" }, "account_scope"],
    [{ login: "other-org", type: "Organization" }, "account_scope"],
  ])("acknowledges but ignores an out-of-scope repository owner %#", async (owner, ignored) => {
    const acceptPullRequestDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptPullRequestDelivery, logIgnoredWebhook }),
    );

    const response = await signedWebhook(app, pullRequestBody({ owner }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored });
    expect(acceptPullRequestDelivery).not.toHaveBeenCalled();
    expect(logIgnoredWebhook).toHaveBeenCalledWith({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      accountType: owner.type,
      accountLogin: owner.login,
    });
    expect(logIgnoredWebhook.mock.calls[0]?.[0]).not.toHaveProperty("body");
  });

  it("rejects a personal account whose login matches the configured organization before enqueue", async () => {
    const acceptPullRequestDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptPullRequestDelivery, logIgnoredWebhook }),
    );

    const response = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "acme", type: "User" } }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "account_scope" });
    expect(acceptPullRequestDelivery).not.toHaveBeenCalled();
    expect(logIgnoredWebhook).toHaveBeenCalledWith({
      eventName: "pull_request",
      deliveryId: "delivery-1",
      accountType: "User",
      accountLogin: "acme",
    });
  });

  it("accepts a matching organization pull request with metadata only", async () => {
    const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: true, routingJobId: "job-1", policyJobId: null }));
    const body = pullRequestBody({ owner: { login: "AcMe", type: "Organization" } });
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));

    const response = await signedWebhook(app, body);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptPullRequestDelivery).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      eventAction: "opened",
      hookId: "hook-1",
      installation: { githubInstallationId: "99", accountLogin: "AcMe" },
      repository: { githubRepositoryId: "101", owner: "AcMe", name: "api" },
      routingPayload: {
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
        routingKey: "routing:00000000-0000-4000-8000-000000000001:github:101:7:trusted-base-123:abc123:ready",
      },
    }));
  });

  it("passes an opened draft pull request to the worker for configuration-aware routing", async () => {
    const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: true, routingJobId: "job-1", policyJobId: null }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));

    const response = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "acme", type: "Organization" }, draft: true }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptPullRequestDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        routingPayload: expect.objectContaining({ isDraft: true }),
      }),
    );
  });

  it("creates a distinct ready routing delivery after a draft delivery with unchanged revisions", async () => {
    const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: true, routingJobId: "job-1", policyJobId: null }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));

    const draftResponse = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "acme", type: "Organization" }, draft: true }),
      { deliveryId: "delivery-draft" },
    );
    const readyResponse = await signedWebhook(
      app,
      pullRequestBody({
        owner: { login: "acme", type: "Organization" },
        action: "ready_for_review",
        draft: false,
      }),
      { deliveryId: "delivery-ready" },
    );

    expect(draftResponse.status).toBe(202);
    expect(readyResponse.status).toBe(202);
    expect(acceptPullRequestDelivery).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveryId: "delivery-draft",
      eventAction: "opened",
      routingPayload: expect.objectContaining({
        isDraft: true,
        routingKey: "routing:00000000-0000-4000-8000-000000000001:github:101:7:trusted-base-123:abc123:draft",
      }),
    }));
    expect(acceptPullRequestDelivery).toHaveBeenNthCalledWith(2, expect.objectContaining({
      deliveryId: "delivery-ready",
      eventAction: "ready_for_review",
      routingPayload: expect.objectContaining({
        isDraft: false,
        routingKey: "routing:00000000-0000-4000-8000-000000000001:github:101:7:trusted-base-123:abc123:ready",
      }),
    }));
  });

  it.each(["labeled"])(
    "acknowledges but does not route an irrelevant pull-request action: %s",
    async (action) => {
      const acceptPullRequestDelivery = vi.fn();
      const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));

      const response = await signedWebhook(
        app,
        pullRequestBody({ owner: { login: "acme", type: "Organization" }, action }),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, ignored: "action" });
      expect(acceptPullRequestDelivery).not.toHaveBeenCalled();
    },
  );

  it.each(["closed", "edited", "converted_to_draft", "review_requested", "review_request_removed"])("invalidates projection without routing for %s", async action => {
    const acceptPullRequestDelivery = vi.fn(async (_input: Parameters<NonNullable<NonNullable<Parameters<typeof buildServices>[0]>["acceptPullRequestDelivery"]>>[0]) => ({ inserted: true, routingJobId: null, policyJobId: null }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));
    const response = await signedWebhook(app, pullRequestBody({ owner: { login: "acme", type: "Organization" }, action }));
    expect(response.status).toBe(202);
    expect(acceptPullRequestDelivery).toHaveBeenCalledWith(expect.objectContaining({ invalidation: expect.objectContaining({ pullNumber: 7, externalInstallationId: "99" }) }));
    expect(acceptPullRequestDelivery.mock.calls[0]?.[0]).not.toHaveProperty("routingPayload");
    expect(acceptPullRequestDelivery.mock.calls[0]?.[0]).not.toHaveProperty("policyPayload");
  });

  it.each(["pull_request", "pull_request_review"])("acknowledges durable deferral when repository selection is unavailable for %s", async eventName => {
    const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: false, routingJobId: null, policyJobId: null, deferred: true }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));
    const body = eventName === "pull_request" ? pullRequestBody({ owner: { login: "acme", type: "Organization" } }) : pullRequestReviewBody({ owner: { login: "acme", type: "Organization" } });
    const response = await signedWebhook(app, body, { eventName });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, deferred: true });
  });

  it("acknowledges a duplicate pull-request delivery", async () => {
    const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: false, routingJobId: null, policyJobId: null }));
    const app = createWebApp(buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }));

    const response = await signedWebhook(
      app,
      pullRequestBody({ owner: { login: "acme", type: "Organization" } }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it("enqueues a matching organization review with only policy-evaluation metadata", async () => {
    const acceptPullRequestDelivery = vi.fn(async (_delivery) => ({
      inserted: true,
      routingJobId: null, policyJobId: "job-review-1",
    }));
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptPullRequestDelivery }),
    );

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "AcMe", type: "Organization" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-1" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptPullRequestDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-review-1",
        eventName: "pull_request_review",
        policyPayload: expect.objectContaining({
          kind: "evaluate_human_review_policy",
          changeRequest: expect.objectContaining({ number: 7 }),
        }),
      }),
    );
    expect(acceptPullRequestDelivery.mock.calls[0]?.[0]?.policyPayload).toEqual({
      kind: "evaluate_human_review_policy",
      deliveryId: "delivery-review-1",
      changeRequest: {
        repository: { provider: "github", externalId: "101", owner: "AcMe", name: "api" },
        externalId: "7",
        number: 7,
      },
    });
  });

  it("rejects a personal account pull request review whose login matches the configured organization before enqueue", async () => {
    const acceptPullRequestDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptPullRequestDelivery, logIgnoredWebhook }),
    );

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "acme", type: "User" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-personal" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "account_scope" });
    expect(acceptPullRequestDelivery).not.toHaveBeenCalled();
    expect(logIgnoredWebhook).toHaveBeenCalledWith({
      eventName: "pull_request_review",
      deliveryId: "delivery-review-personal",
      accountType: "User",
      accountLogin: "acme",
    });
  });

  it("acknowledges a duplicate review delivery", async () => {
    const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: false, routingJobId: null, policyJobId: null }));
    const app = createWebApp(buildServices({ acceptPullRequestDelivery }));

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "acme", type: "Organization" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-1" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
  });

  it("acknowledges but ignores an out-of-scope review", async () => {
    const acceptPullRequestDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const app = createWebApp(
      buildServices({ githubOrganization: "acme", acceptPullRequestDelivery, logIgnoredWebhook }),
    );

    const response = await signedWebhook(
      app,
      pullRequestReviewBody({ owner: { login: "other-org", type: "Organization" } }),
      { eventName: "pull_request_review", deliveryId: "delivery-review-out-of-scope" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "account_scope" });
    expect(acceptPullRequestDelivery).not.toHaveBeenCalled();
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
    const acceptPullRequestDelivery = vi.fn();
    const logIgnoredWebhook = vi.fn();
    const verifySignature = vi.fn(async () => {});
    const app = createWebApp(buildServices({ acceptPullRequestDelivery, logIgnoredWebhook, verifySignature }));

    const response = await signedWebhook(app, "not-json", { eventName: "push" });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, ignored: "event" });
    expect(verifySignature).toHaveBeenCalledWith({
      body: "not-json",
      secret: "hook-secret",
      signature: "sha256=test",
    });
    expect(acceptPullRequestDelivery).not.toHaveBeenCalled();
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

it("queues repeated retargets on identical commits without reusing a completed routing identity", async () => {
  const acceptPullRequestDelivery = vi.fn(async () => ({ inserted: true, routingJobId: "job", policyJobId: null }));
  const app = createWebApp(buildServices({ acceptPullRequestDelivery }));
  for (const [deliveryId, from, to] of [["retarget-1", "main", "release"], ["retarget-2", "release", "main"], ["retarget-1", "main", "release"]] as const) {
    const body = JSON.parse(pullRequestBody({ owner: { login: "acme", type: "Organization" } }));
    body.action = "edited";
    body.changes = { base: { ref: { from }, sha: { from: "trusted-base-123" } } };
    body.pull_request.base.ref = to;
    expect((await signedWebhook(app, JSON.stringify(body), { deliveryId })).status).toBe(202);
  }
  expect(acceptPullRequestDelivery).toHaveBeenCalledTimes(3);
  const keys = acceptPullRequestDelivery.mock.calls.map(call => (call as unknown as [{ routingPayload: { routingKey: string } }])[0].routingPayload.routingKey);
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[0]).toBe(keys[2]);
  expect(keys[0]).not.toBe("routing:00000000-0000-4000-8000-000000000001:github:101:7:trusted-base-123:abc123:ready");
});
