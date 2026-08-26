import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildRoutingKey,
  type ConfigurationSource,
  type DecisionEventV1,
  type NormalizedChangeRequestEvent,
} from "../src/index";

describe("public platform contracts", () => {
  it("builds a provider-qualified routing key", () => {
    expect(buildRoutingKey({
      workspaceId: "ws_local",
      provider: "github",
      repositoryId: "200",
      changeRequestId: "7",
      trustedConfigRevision: "base-sha",
      headRevision: "head-sha",
    })).toBe("routing:ws_local:github:200:7:base-sha:head-sha");
  });

  it("keeps events and configuration sources provider neutral", () => {
    expectTypeOf<NormalizedChangeRequestEvent["provider"]>().toEqualTypeOf<"github" | "gitlab" | "bitbucket">();
    expectTypeOf<ConfigurationSource["loadOrganization"]>().toBeFunction();
    expectTypeOf<DecisionEventV1["schemaVersion"]>().toEqualTypeOf<1>();
  });
});
