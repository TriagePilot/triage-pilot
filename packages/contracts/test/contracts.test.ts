import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildRoutingKey,
  type ConfigurationSource,
  type DecisionEventV1,
  type NormalizedChangeRequestEvent,
} from "../src/index";

describe("public platform contracts", () => {
  it("builds a provider-qualified ready routing key", () => {
    expect(buildRoutingKey({
      workspaceId: "ws_local",
      provider: "github",
      repositoryId: "200",
      changeRequestId: "7",
      trustedConfigRevision: "base-sha",
      headRevision: "head-sha",
      isDraft: false,
    })).toBe("routing:ws_local:github:200:7:base-sha:head-sha:ready");
  });

  it("distinguishes draft and ready routing keys while keeping retries stable", () => {
    const routingInput = {
      workspaceId: "ws_local",
      provider: "github" as const,
      repositoryId: "200",
      changeRequestId: "7",
      trustedConfigRevision: "base-sha",
      headRevision: "head-sha",
    };

    expect(buildRoutingKey({ ...routingInput, isDraft: true }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:draft");
    expect(buildRoutingKey({ ...routingInput, isDraft: true }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:draft");
    expect(buildRoutingKey({ ...routingInput, isDraft: false }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:ready");
    expect(buildRoutingKey({ ...routingInput, isDraft: false }))
      .toBe("routing:ws_local:github:200:7:base-sha:head-sha:ready");
  });

  it("keeps events and configuration sources provider neutral", () => {
    expectTypeOf<NormalizedChangeRequestEvent["provider"]>().toEqualTypeOf<"github" | "gitlab" | "bitbucket">();
    expectTypeOf<ConfigurationSource["loadOrganization"]>().toBeFunction();
    expectTypeOf<DecisionEventV1["schemaVersion"]>().toEqualTypeOf<1>();
  });
});
