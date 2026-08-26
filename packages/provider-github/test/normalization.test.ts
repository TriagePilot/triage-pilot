import { describe, expect, it } from "vitest";

import { normalizeGitHubWebhook } from "../src/normalization";

describe("normalizeGitHubWebhook", () => {
  it("maps a supported pull request into the provider-neutral event contract", () => {
    expect(normalizeGitHubWebhook({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 99 },
        sender: { id: 502, login: "event-sender-71c9ab" },
        repository: {
          id: 101,
          name: "api",
          owner: { login: "acme", type: "Organization" },
        },
        pull_request: {
          id: 7001,
          number: 7,
          draft: false,
          user: { id: 501, login: "developer-d82a5f" },
          base: { sha: "base-sha" },
          head: { sha: "head-sha" },
        },
      },
    })).toEqual({
      deliveryId: "delivery-1",
      eventName: "change_request",
      eventAction: "opened",
      provider: "github",
      externalConnectionId: "99",
      changeRequest: {
        repository: {
          provider: "github",
          externalId: "101",
          owner: "acme",
          name: "api",
        },
        externalId: "7001",
        number: 7,
        baseRevision: "base-sha",
        headRevision: "head-sha",
      },
      actor: {
        externalId: "502",
        displayName: "event-sender-71c9ab",
      },
      isDraft: false,
    });
  });

  it("returns null for unrelated events", () => {
    expect(normalizeGitHubWebhook({
      deliveryId: "delivery-2",
      eventName: "push",
      payload: { ref: "refs/heads/main" },
    })).toBeNull();
  });

  it("returns null for pull request actions that do not trigger routing", () => {
    expect(normalizeGitHubWebhook({
      deliveryId: "delivery-3",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 99 },
        sender: { id: 502, login: "event-sender-71c9ab" },
        repository: {
          id: 101,
          name: "api",
          owner: { login: "acme", type: "Organization" },
        },
        pull_request: {
          id: 7001,
          number: 7,
          draft: false,
          user: { id: 501, login: "developer-d82a5f" },
          base: { sha: "base-sha" },
          head: { sha: "head-sha" },
        },
      },
    })).toBeNull();
  });
});
